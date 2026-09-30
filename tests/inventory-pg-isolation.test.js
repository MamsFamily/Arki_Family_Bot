const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createInventoryPersistence } = require('../inventoryPersistence');
const { createVoteRewardsService } = require('../voteRewards');

test('SQL réel : crédits, reçus et rollback dans une table temporaire isolée', {
  skip: process.env.RUN_PG_ISOLATION !== '1',
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 1 });
  const client = await pool.connect();
  try {
    // Restrict name resolution to this session's temporary schema. No application
    // table, inventory, player or production data can be read or modified here.
    await client.query('SET search_path TO pg_temp');
    await client.query(`CREATE TEMP TABLE app_data (
      key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMP DEFAULT NOW()
    )`);
    const store = {
      isPostgres: () => true,
      getPool: () => ({
        query: client.query.bind(client),
        connect: async () => ({ query: client.query.bind(client), release: () => {} }),
      }),
      getData: async key => (await client.query('SELECT value FROM app_data WHERE key = $1', [key])).rows[0]?.value,
    };
    const persistence = createInventoryPersistence({ pgStore: store });
    const credits = [{ itemTypeId: 'test-diamond', quantity: 100 }, { itemTypeId: 'test-pack', quantity: 2 }];
    const input = ['isolated-test', credits, 'test', 'Test isolé', {
      idempotencyKeys: ['test-base', 'test-pack'], idempotencyFingerprint: 'decision-keep',
    }];
    await persistence.applyInventoryCredits(...input);
    const retry = await persistence.applyInventoryCredits(...input);
    assert.equal(retry.result.alreadyApplied, true);
    assert.equal((await store.getData('inventory_data'))['isolated-test']['test-diamond'], 100);
    assert.equal((await store.getData('inventory_transactions')).length, 2);
    assert.equal((await persistence.getInventoryCreditReceipt('test-base')).playerId, 'isolated-test');
    await assert.rejects(persistence.applyInventoryCredits(
      'isolated-test', credits, 'test', 'Décision contradictoire', {
        idempotencyKeys: ['test-base', 'test-pack'], idempotencyFingerprint: 'decision-all',
      }
    ), /autre décision/);

    await client.query(`ALTER TABLE app_data ADD CONSTRAINT block_transaction_update
      CHECK (key != 'inventory_transactions' OR jsonb_array_length(value) <= 2)`);
    await assert.rejects(persistence.applyInventoryCredits(
      'isolated-test', [{ itemTypeId: 'test-diamond', quantity: 50 }], 'test', 'Échec simulé',
      { idempotencyKey: 'test-failure' }
    ));
    assert.equal((await store.getData('inventory_data'))['isolated-test']['test-diamond'], 100);
    assert.equal(await persistence.getInventoryCreditReceipt('test-failure'), null);
    const service = createVoteRewardsService({ pgStore: store });
    await service.persistPending('isolated-request', { type: 'notfound', resolved: false, resolving: true });
    assert.equal((await service.loadPending())['isolated-request'].resolving, false);
    await service.persistPending('isolated-request', {
      type: 'notfound', resolved: true, decision: 'ignore', creditResult: { status: 'ignored' },
    });
    await service.persistPending('isolated-request', { type: 'notfound', resolved: false });
    const terminal = (await service.loadPending())['isolated-request'];
    assert.equal(terminal.resolved, true);
    assert.equal(terminal.decision, 'ignore');
  } finally {
    client.release();
    await pool.end(); // PostgreSQL drops the session-local table automatically.
  }
});