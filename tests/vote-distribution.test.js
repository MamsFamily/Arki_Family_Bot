const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
const start = source.indexOf('async function distributeWithChecks(');
const end = source.indexOf('\nfunction buildDistributionReport(', start);
if (start < 0 || end < 0) throw new Error('Could not extract distributeWithChecks from index.js');
const extracted = source.slice(start, end);

function harness({ credit, send = async () => {}, persist = async () => {}, loadPending = null, duplicates = () => [] }) {
  const pendingDistributions = new Map();
  const calls = [];
  const context = {
    pendingDistributions,
    pgStore: { isPostgres: () => true },
    loadPending: async () => loadPending ? loadPending() : Object.fromEntries(pendingDistributions),
    reloadPendingDistributions: async () => {
      const saved = loadPending ? await loadPending() : Object.fromEntries(pendingDistributions);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('pending state unavailable');
      for (const [id, pending] of Object.entries(saved)) pendingDistributions.set(id, pending);
    },
    detectDuplicates: typeof duplicates === 'function' ? duplicates : () => duplicates,
    resolvePlayer: (index, name) => index[name] || null,
    createPendingId: (type, period, names) => `${type}_${period}_${names.join('_')}`,
    persistPendingState: async (...args) => { calls.push(['persist', ...args]); await persist(...args); },
    creditVotePlayer: async input => { calls.push(['credit', input]); return credit(input); },
    ButtonBuilder: class {
      setCustomId() { return this; } setLabel() { return this; } setStyle() { return this; }
    },
    ActionRowBuilder: class { addComponents() { return this; } },
    ButtonStyle: { Secondary: 1, Primary: 2 },
    console: { warn() {}, error() {} },
  };
  const fn = new Function(...Object.keys(context), `return (${extracted});`)(...Object.values(context));
  return { fn, pendingDistributions, calls };
}

const config = {
  DIAMONDS_PER_VOTE: 2,
  TOP_DIAMONDS: {},
  STYLE: {},
};

test('une entrée ignorée ne rejoint pas un nouveau doublon après correction du mapping', async () => {
  let consideredNames;
  const ignored = {
    type: 'notfound', playername: 'A', periodKey: '2026-09',
    resolved: true, decision: 'ignore', creditResult: { status: 'ignored' },
  };
  const h = harness({
    loadPending: async () => ({ 'notfound_2026-09_A': ignored }),
    credit: async () => ({ status: 'success', credits: [], errors: [] }),
    duplicates: ranking => {
      consideredNames = ranking.map(player => player.playername);
      return ranking.length > 1 ? [{ memberId: 'member', players: ranking }] : [];
    },
  });
  const result = await h.fn(
    [{ playername: 'A', votes: 12 }, { playername: 'B', votes: 8 }],
    { A: 'member', B: 'member' }, config, 'SEPTEMBRE', null, '2026-09'
  );
  assert.deepEqual(consideredNames, ['B']);
  assert.equal(result.playerStatus.A, 'ignored');
  assert.equal(result.playerStatus.B, 'success');
  assert.equal(result.distributionResults.pendingDuplicates, 0);
  assert.deepEqual(h.calls.filter(call => call[0] === 'credit').map(call => call[1].playername), ['B']);
});

test('credits all configured reward components before counting a player as successful', async () => {
  const h = harness({ credit: async () => ({ status: 'success', credits: [{ itemTypeId: 'diamants', quantity: 10 }, { itemTypeId: 'pack-item', quantity: 1 }], errors: [] }) });
  const result = await h.fn([{ playername: 'Arki', votes: 5 }], { Arki: 'member-1' }, config, 'MAI', null, '2025-05');
  assert.equal(result.distributionResults.success, 1);
  assert.equal(result.playerStatus.Arki, 'success');
  assert.equal(result.distributionResults.inventoryResults.length, 2);
  assert.equal(h.calls[0][1].periodKey, '2025-05');
});

test('persists an unidentified-player request with period/config snapshot and continues after notifier failure', async () => {
  let persisted;
  const h = harness({
    credit: async () => ({ status: 'success', credits: [], errors: [] }),
    persist: async (id, pending) => { persisted = { id, pending }; },
    send: async () => { throw new Error('Discord unavailable'); },
  });
  const channel = { send: async (...args) => { await h.calls.push(['send', ...args]); throw new Error('Discord unavailable'); } };
  const result = await h.fn([
    { playername: 'Unknown', votes: 3 },
    { playername: 'Known', votes: 1 },
  ], { Known: 'member-2' }, config, 'MAI', channel, '2025-05');
  assert.equal(persisted.pending.periodKey, '2025-05');
  assert.deepEqual(persisted.pending.votesConfig, config);
  assert.equal(result.distributionResults.pendingNotFound, 1);
  assert.equal(result.distributionResults.success, 1);
});

test('a failed reward does not report success and a later retry can succeed idempotently', async () => {
  let attempt = 0;
  const h = harness({
    credit: async () => (++attempt === 1
      ? { status: 'failed', credits: [], errors: ['pack unavailable'] }
      : { status: 'success', credits: [{ itemTypeId: 'diamants', quantity: 6 }, { itemTypeId: 'pack-item', quantity: 1 }], errors: [] }),
  });
  const ranking = [{ playername: 'Retry', votes: 3 }];
  const memberIndex = { Retry: 'member-3' };
  const first = await h.fn(ranking, memberIndex, config, 'MAI', null, '2025-05');
  assert.equal(first.distributionResults.success, 0);
  assert.equal(first.distributionResults.failed, 1);
  assert.equal(first.playerStatus.Retry, 'failed');
  const second = await h.fn(ranking, memberIndex, config, 'MAI', null, '2025-05');
  assert.equal(second.distributionResults.success, 1);
  assert.equal(attempt, 2);
});

test('partial reward is never counted as full success', async () => {
  const h = harness({ credit: async () => ({ status: 'partial', credits: [{ itemTypeId: 'diamants', quantity: 8 }], errors: ['pack invalide'] }) });
  const result = await h.fn([{ playername: 'Partial', votes: 4 }], { Partial: 'member-4' }, config, 'MAI', null, '2025-05');
  assert.equal(result.distributionResults.success, 0);
  assert.equal(result.distributionResults.partial, 1);
  assert.equal(result.playerStatus.Partial, 'partial');
});

test('unexpected reward error is reported without escaping the distribution loop', async () => {
  const h = harness({ credit: async () => { throw new Error('database timeout'); } });
  const result = await h.fn([{ playername: 'Error', votes: 2 }], { Error: 'member-5' }, config, 'MAI', null, '2025-05');
  assert.equal(result.distributionResults.failed, 1);
  assert.equal(result.playerStatus.Error, 'failed');
  assert.match(result.distributionResults.errors[0].error, /database timeout/);
});

test('a previously resolved ignore decision is reported, not recreated or re-notified', async () => {
  let notified = 0;
  const h = harness({ credit: async () => ({ status: 'success', credits: [], errors: [] }) });
  const pendingId = 'notfound_2025-05_Unknown';
  h.pendingDistributions.set(pendingId, {
    type: 'notfound', playername: 'Unknown', votes: 3, rankIdx: 1, monthName: 'MAI',
    periodKey: '2025-05', votesConfig: config, resolved: true,
    decision: 'ignore', creditResult: { status: 'ignored', credits: [] },
  });
  const channel = { send: async () => { notified++; } };
  const result = await h.fn([{ playername: 'Unknown', votes: 3 }], { Unknown: 'member-1' }, config, 'MAI', channel, '2025-05');
  assert.equal(result.distributionResults.ignored, 1);
  assert.equal(result.playerStatus.Unknown, 'ignored');
  assert.equal(notified, 0);
});

test('pending persistence failure is recorded without preventing credits for unrelated players', async () => {
  const h = harness({
    persist: async () => { throw new Error('PG write failed'); },
    credit: async () => ({ status: 'success', credits: [{ itemTypeId: 'diamants', quantity: 2 }], errors: [] }),
  });
  const channel = { send: async () => { throw new Error('Discord unavailable'); } };
  const result = await h.fn([
    { playername: 'Unknown', votes: 3 },
    { playername: 'Known', votes: 1 },
  ], { Known: 'member-6' }, config, 'MAI', channel, '2025-05');
  assert.equal(result.distributionResults.failed, 1);
  assert.equal(result.distributionResults.success, 1);
  assert.equal(result.playerStatus.Known, 'success');
});

test('a rejected pending-state restore blocks every reward credit', async () => {
  let creditCalls = 0;
  const h = harness({
    loadPending: async () => { throw new Error('PG read unavailable'); },
    credit: async () => { creditCalls++; return { status: 'success', credits: [], errors: [] }; },
  });
  await assert.rejects(
    h.fn([{ playername: 'Known', votes: 1 }], { Known: 'member-7' }, config, 'MAI', null, '2025-05'),
    /PG read unavailable/
  );
  assert.equal(creditCalls, 0);
});

test('resolved keep marks only its selected duplicate as credited; merge is counted and labeled once', async () => {
  const players = [
    { playername: 'A', votes: 4 },
    { playername: 'B', votes: 3 },
  ];
  const duplicates = [{ memberId: 'member-8', players }];
  const credit = async () => ({ status: 'success', credits: [{ itemTypeId: 'diamants', quantity: 10 }], errors: [] });
  const keep = harness({ credit, duplicates });
  keep.pendingDistributions.set('duplicate_2025-05_A_B', {
    type: 'duplicate', memberId: 'member-8', entries: [
      { playername: 'A', votes: 4, rankIdx: 1 }, { playername: 'B', votes: 3, rankIdx: 2 },
    ], periodKey: '2025-05', resolved: true, decision: 'keep', choiceIdx: 0,
    creditResult: { status: 'success', credits: [{ itemTypeId: 'diamants', quantity: 10 }] },
  });
  const kept = await keep.fn(players, { A: 'member-8', B: 'member-8' }, config, 'MAI', null, '2025-05');
  assert.equal(kept.playerStatus.A, 'success');
  assert.equal(kept.playerStatus.B, 'ignored');
  assert.equal(kept.distributionResults.success, 1);
  assert.equal(kept.distributionResults.ignored, 1);

  const merge = harness({ credit, duplicates });
  merge.pendingDistributions.set('duplicate_2025-05_A_B', {
    type: 'duplicate', memberId: 'member-8', entries: [
      { playername: 'A', votes: 4, rankIdx: 1 }, { playername: 'B', votes: 3, rankIdx: 2 },
    ], periodKey: '2025-05', resolved: true, decision: 'merge',
    creditResult: { status: 'success', credits: [{ itemTypeId: 'diamants', quantity: 10 }] },
  });
  const merged = await merge.fn(players, { A: 'member-8', B: 'member-8' }, config, 'MAI', null, '2025-05');
  assert.equal(merged.playerStatus.A, 'merged');
  assert.equal(merged.playerStatus.B, 'merged');
  assert.equal(merged.distributionResults.success, 1);
  assert.equal(merged.distributionResults.merged, 1);
});