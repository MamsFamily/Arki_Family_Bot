const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInventoryPersistence } = require('../inventoryPersistence');
const { createVoteRollbackService, selectLatestVoteBatch } = require('../voteRollback');
const { runVoteRewardBatch, getVoteRewardBatch } = require('../voteBatchContext');

function credit(id, timestamp, batchId, extra = {}) {
  return {
    id, timestamp, type: 'add', playerId: 'player', itemTypeId: 'diamants',
    quantity: 100, reason: 'Votes OCTOBRE', ...(batchId ? { voteBatchId: batchId } : {}), ...extra,
  };
}
const old = credit('old', '2026-11-01T00:00:00Z', 'first');
const latest = [
  credit('new-base', '2026-11-06T09:00:00Z', 'last'),
  credit('new-pack', '2026-11-06T09:00:01Z', 'last', {
    itemTypeId: 'fraises', quantity: 5, reason: 'Pack vote place 1 — Votes OCTOBRE',
  }),
  credit('new-shiny', '2026-11-06T09:01:00Z', 'last', {
    itemTypeId: 'shiny', quantity: 1, reason: 'Dino Shiny — Tirage votes OCTOBRE',
  }),
];

function fixture(t, transactions = [old, ...latest]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vote-rollback-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'inventory.json');
  const seed = {
    inventories: { player: { diamants: 250, fraises: 8, shiny: 1 } },
    transactions, receipts: { original: { playerId: 'player', result: { transactions: latest } } },
  };
  fs.writeFileSync(filePath, JSON.stringify(seed));
  const persistence = createInventoryPersistence({ pgStore: { isPostgres: () => false }, filePath });
  let time = Date.parse('2026-11-06T09:05:00Z');
  const service = createVoteRollbackService({ persistence, now: () => time });
  return {
    service, persistence, filePath, seed,
    read: () => JSON.parse(fs.readFileSync(filePath, 'utf8')),
    advance: ms => { time += ms; },
  };
}
const actor = { actorId: 'admin', guildId: 'guild' };
const confirmInput = plan => ({ ...actor, planId: plan.id });

test('latest batch selects base, packs and Shiny, never the original payout or shop', () => {
  const shop = credit('shop', '2026-11-06T09:02:00Z', null, { reason: 'Achat shop' });
  assert.deepEqual(selectLatestVoteBatch([old, ...latest, shop]).transactions.map(tx => tx.id).sort(),
    latest.map(tx => tx.id).sort());
});

test('month filter is literal, supports accents, and cannot become a regular expression', () => {
  const august = credit('aug', '2026-09-01T00:00:00Z', 'august', { reason: 'Votes AOÛT' });
  assert.equal(selectLatestVoteBatch([old, august], { month: ' août ' }).batchId, 'august');
  assert.throws(() => selectLatestVoteBatch([old], { month: '.*' }), /invalide/);
  assert.throws(() => selectLatestVoteBatch([], {}), /Aucun/);
});

test('legacy payouts require an explicit boundary, not an assumed time gap', () => {
  const history = [old, ...latest].map(({ voteBatchId, ...tx }) => tx);
  assert.throws(() => selectLatestVoteBatch(history), /option depuis/);
  assert.equal(selectLatestVoteBatch(history, { since: '2026-11-06T10:00:00+01:00' }).transactions.length, 3);
  assert.throws(() => selectLatestVoteBatch(history, { since: '2026-11-06 10:00' }), /fuseau/);
  assert.throws(() => selectLatestVoteBatch(history, { since: '2026-11-31T10:00:00Z' }), /invalide/);
  assert.throws(() => selectLatestVoteBatch(history, { since: '2026-12-01T00:00:00Z' }), /Aucun crédit/);
});

test('preview does not debit; confirmation removes exactly the snapshot and preserves receipts', async t => {
  const f = fixture(t);
  const { result: plan } = await f.service.prepare(actor);
  assert.deepEqual(f.read().inventories, f.seed.inventories);
  const { result } = await f.service.confirm(confirmInput(plan));
  assert.equal(result.count, 3);
  assert.deepEqual(f.read().inventories.player, { diamants: 150, fraises: 3 });
  assert.deepEqual(f.read().receipts.original, f.seed.receipts.original);
  assert.deepEqual(f.read().transactions.slice(0, 4), f.seed.transactions);
  assert.equal(f.read().transactions.filter(tx => tx.reversalOf).length, 3);
});

test('repeated/concurrent confirmation cannot debit twice, including after service restart', async t => {
  const f = fixture(t);
  const { result: plan } = await f.service.prepare(actor);
  const results = await Promise.all([f.service.confirm(confirmInput(plan)), f.service.confirm(confirmInput(plan))]);
  assert.deepEqual(results.map(r => r.result.alreadyApplied).sort(), [false, true]);
  const restarted = createVoteRollbackService({ persistence: f.persistence });
  assert.equal((await restarted.confirm(confirmInput(plan))).result.alreadyApplied, true);
  assert.equal(f.read().inventories.player.diamants, 150);
  await assert.rejects(restarted.prepare(actor), /déjà été annulé/);
});

test('two distinct previews of the same batch cannot debit twice', async t => {
  const f = fixture(t);
  const { result: a } = await f.service.prepare(actor);
  const { result: b } = await f.service.prepare(actor);
  await f.service.confirm(confirmInput(a));
  await assert.rejects(f.service.confirm(confirmInput(b)), /déjà été annulées/);
  assert.equal(f.read().inventories.player.diamants, 150);
});

test('insufficient inventory aborts the whole batch, without silently reporting success', async t => {
  const f = fixture(t);
  const { result: plan } = await f.service.prepare(actor);
  await f.persistence.mutateInventory(state => { state.inventories.player.fraises = 0; });
  const before = f.read();
  await assert.rejects(f.service.confirm(confirmInput(plan)), /Solde insuffisant/);
  assert.deepEqual(f.read(), before);
});

test('a newer batch or changed source invalidates the preview rather than expanding the debit', async t => {
  const f = fixture(t);
  const { result: plan } = await f.service.prepare(actor);
  await f.persistence.mutateInventory(state => {
    state.transactions.push(credit('newer', '2026-11-06T09:06:00Z', 'newer'));
  });
  await assert.rejects(f.service.confirm(confirmInput(plan)), /changé/);
  assert.deepEqual(f.read().inventories, f.seed.inventories);
});

test('legacy preview does not swallow credits added after it was displayed', async t => {
  const f = fixture(t, [old, ...latest].map(({ voteBatchId, ...tx }) => tx));
  const { result: plan } = await f.service.prepare({ ...actor, since: '2026-11-06T09:00:00Z' });
  await f.persistence.mutateInventory(state => {
    state.transactions.push(credit('later', '2026-11-06T09:06:00Z'));
  });
  await assert.rejects(f.service.confirm(confirmInput(plan)), /changé/);
});

test('preview expiry, author and guild are enforced without debits', async t => {
  const f = fixture(t);
  const { result: plan } = await f.service.prepare(actor);
  await assert.rejects(f.service.confirm({ ...confirmInput(plan), actorId: 'other' }), /auteur/);
  await assert.rejects(f.service.confirm({ ...confirmInput(plan), guildId: 'other' }), /auteur/);
  f.advance(16 * 60 * 1000);
  await assert.rejects(f.service.confirm(confirmInput(plan)), /expiré/);
  assert.deepEqual(f.read().inventories, f.seed.inventories);
});

test('malformed or duplicate historical transaction IDs fail closed', () => {
  assert.throws(() => selectLatestVoteBatch([latest[0], latest[0]]), /ambigus/);
  assert.throws(() => selectLatestVoteBatch([{ ...latest[0], quantity: -1 }]), /invalide/);
});

test('a full new batch keeps its exact ID on persisted inventory credits', async t => {
  const f = fixture(t);
  await runVoteRewardBatch(async () => {
    const batch = getVoteRewardBatch();
    const options = { voteBatchId: batch.id, voteBatchStartedAt: batch.startedAt };
    const first = await f.persistence.applyInventoryCredits('player', [{ itemTypeId: 'diamants', quantity: 1 }], 'system', 'Votes NOVEMBRE', options);
    const second = await f.persistence.applyInventoryCredits('player', [{ itemTypeId: 'shiny', quantity: 1 }], 'system', 'Tirage votes NOVEMBRE', options);
    assert.equal(first.result.transaction.voteBatchId, batch.id);
    assert.equal(second.result.transaction.voteBatchId, batch.id);
  });
  assert.equal(getVoteRewardBatch(), undefined);
});

test('parallel runs keep separate batch IDs and nested operations keep the same batch', async () => {
  const ids = await Promise.all([1, 2].map(() => runVoteRewardBatch(async () => {
    const first = getVoteRewardBatch().id;
    await new Promise(resolve => setImmediate(resolve));
    await runVoteRewardBatch(() => assert.equal(getVoteRewardBatch().id, first));
    return getVoteRewardBatch().id;
  })));
  assert.notEqual(ids[0], ids[1]);
});
