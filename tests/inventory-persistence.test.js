const test = require('node:test');
const assert = require('node:assert/strict');

const initialData = () => ({
  inventory_item_types: [{ id: 'ore', name: 'Ore' }],
  inventory_data: { player: { ore: 10 } },
  inventory_transactions: [],
  inventory_categories: [],
  inventory_credit_receipts: {},
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPostgresHarness(seed = initialData()) {
  const committed = new Map(Object.entries(seed));
  let failureKey = null;
  let readFailureKey = null;
  let migrationRace = null;
  const readOptions = new Map();
  let lock = Promise.resolve();

  const pool = {
    async query(sql, params = []) {
      if (!sql.startsWith('INSERT INTO app_data')) throw new Error(`Unexpected pool SQL: ${sql}`);
      const key = params[0];
      if (migrationRace?.key === key) {
        committed.set(key, clone(migrationRace.value));
        migrationRace = null;
      }
      if (!committed.has(key)) committed.set(key, JSON.parse(params[1]));
      return { rows: [], rowCount: committed.has(key) ? 0 : 1 };
    },
    async connect() {
      let unlock;
      const previous = lock;
      lock = new Promise(resolve => { unlock = resolve; });
      await previous;
      let working;
      let inTransaction = false;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN') {
            working = new Map([...committed].map(([key, value]) => [key, clone(value)]));
            inTransaction = true;
            return { rows: [] };
          }
          if (sql === 'COMMIT') {
            committed.clear();
            for (const [key, value] of working) committed.set(key, value);
            inTransaction = false;
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') {
            working = null;
            inTransaction = false;
            return { rows: [] };
          }
          if (sql.startsWith('INSERT INTO app_data')) {
            if (!working.has(params[0])) working.set(params[0], {});
            return { rows: [] };
          }
          if (sql.startsWith('SELECT key, value FROM app_data')) {
            const keys = [...params[0]].sort();
            return { rows: keys.map(key => ({ key, value: working.get(key) })).filter(row => row.value !== undefined) };
          }
          if (sql.startsWith('UPDATE app_data')) {
            const key = params[0];
            if (failureKey === key) {
              failureKey = null;
              throw new Error(`mock write failure: ${key}`);
            }
            if (!working.has(key)) return { rows: [], rowCount: 0 };
            working.set(key, JSON.parse(params[1]));
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
        release() {
          if (inTransaction) inTransaction = false;
          unlock();
        },
      };
    },
  };

  const pgStore = {
    isPostgres: () => true,
    getPool: () => pool,
    async getData(key, fallback, options) {
      if (readFailureKey === key) throw new Error(`mock read failure: ${key}`);
      readOptions.set(key, options || {});
      return committed.has(key) ? clone(committed.get(key)) : null;
    },
    async setData(key, value) {
      committed.set(key, clone(value));
      return true;
    },
  };

  return {
    pgStore,
    data: key => clone(committed.get(key)),
    setData: (key, value) => committed.set(key, clone(value)),
    failNextWrite: key => { failureKey = key; },
    failNextRead: key => { readFailureKey = key; },
    removeData: key => committed.delete(key),
    raceMigrationWith: (key, value) => { migrationRace = { key, value }; },
    readOptions,
  };
}

function loadManager(harness, beforeInit) {
  const Module = require('node:module');
  const pgPath = require.resolve('../pgStore');
  const managerPath = require.resolve('../inventoryManager');
  const persistencePath = require.resolve('../inventoryPersistence');
  const originalPgModule = require.cache[pgPath];
  const originalManagerModule = require.cache[managerPath];
  const originalPersistenceModule = require.cache[persistencePath];
  const files = new Map();
  const fakeFs = {
    existsSync: file => files.has(file),
    readFileSync: file => {
      if (!files.has(file)) throw new Error(`Mock file not found: ${file}`);
      return files.get(file);
    },
    writeFileSync: (file, contents) => files.set(file, contents),
    renameSync: (from, to) => {
      if (!files.has(from)) throw new Error(`Mock temporary file not found: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlinkSync: file => files.delete(file),
  };
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'fs') return fakeFs;
    return originalLoad.call(this, request, parent, isMain);
  };
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: harness.pgStore };
  delete require.cache[managerPath];
  delete require.cache[persistencePath];
  try {
    const manager = require('../inventoryManager');
    harness.setData('inventory_item_types', [
      ...manager.DEFAULT_ITEM_TYPES,
      { id: 'ore', name: 'Ore' },
    ]);
    if (beforeInit) beforeInit(manager);
    return manager.initInventory().then(() => ({ manager, files, filePath: require('node:path').join(__dirname, '..', 'inventory.json') }));
  } finally {
    Module._load = originalLoad;
    if (originalPgModule) require.cache[pgPath] = originalPgModule;
    else delete require.cache[pgPath];
    if (originalManagerModule) require.cache[managerPath] = originalManagerModule;
    else delete require.cache[managerPath];
    if (originalPersistenceModule) require.cache[persistencePath] = originalPersistenceModule;
    else delete require.cache[persistencePath];
  }
}

test('credit bundles commit together, duplicate keys never credit twice, and cross-player reuse is rejected', async () => {
  const harness = createPostgresHarness();
  const { manager } = await loadManager(harness);

  const first = await manager.applyInventoryCredits(
    'player', [{ itemTypeId: 'ore', quantity: 2 }, { itemTypeId: 'gem', quantity: 3 }],
    'admin', 'vote reward', {
      idempotencyKey: 'vote-1',
      idempotencyKeys: ['vote-2'],
      idempotencyFingerprint: 'decision:keep',
    }
  );
  assert.equal(first.newQuantity, 3);
  assert.equal(first.transactions.length, 2);
  assert.equal(harness.data('inventory_data').player.ore, 12);
  assert.equal(harness.data('inventory_data').player.gem, 3);

  const duplicate = await manager.applyInventoryCredits(
    'player', [{ itemTypeId: 'ore', quantity: 99 }], 'admin', 'retry',
    { idempotencyKey: 'vote-1', idempotencyKeys: ['vote-2'] }
  );
  assert.equal(duplicate.alreadyApplied, true);
  assert.equal(harness.data('inventory_data').player.ore, 12);
  assert.equal((await manager.getInventoryCreditReceipt('vote-2')).playerId, 'player');
  assert.equal((await manager.getInventoryCreditReceipt('vote-2')).fingerprint, 'decision:keep');

  await assert.rejects(
    manager.applyInventoryCredits('player', [{ itemTypeId: 'ore', quantity: 1 }], 'admin', 'merge retry', {
      idempotencyKey: 'vote-1',
      idempotencyFingerprint: 'decision:merge',
    }),
    /Une autre décision a déjà été enregistrée pour ces récompenses/
  );

  await assert.rejects(
    manager.applyInventoryCredits('other', [{ itemTypeId: 'ore', quantity: 1 }], null, null, { idempotencyKey: 'vote-1' }),
    /another player/
  );
  await assert.rejects(
    manager.applyInventoryCredits('player', [{ itemTypeId: 'ore', quantity: 1 }], null, null, {
      idempotencyKeys: ['vote-1', 'not-yet-used'],
    }),
    /manual review/
  );
  assert.equal(harness.data('inventory_data').player.ore, 12);
});

test('database failures roll back bundles and leave manager cache unchanged', async () => {
  const harness = createPostgresHarness();
  const { manager } = await loadManager(harness);
  harness.failNextWrite('inventory_transactions');

  await assert.rejects(
    manager.applyInventoryCredits('player', [
      { itemTypeId: 'ore', quantity: 1 },
      { itemTypeId: 'gem', quantity: 4 },
    ], 'admin', 'all or nothing'),
    /mock write failure/
  );
  assert.equal(harness.data('inventory_data').player.ore, 10);
  assert.equal(harness.data('inventory_data').player.gem, undefined);
  assert.equal(manager.getPlayerInventory('player').ore, 10);
  assert.equal(harness.data('inventory_transactions').length, 0);
});

test('concurrent stale manager instances apply against the latest locked inventory', async () => {
  const harness = createPostgresHarness();
  const [{ manager: first }, { manager: second }] = await Promise.all([loadManager(harness), loadManager(harness)]);
  await Promise.all([
    first.addToInventory('player', 'ore', 2, 'a', 'credit'),
    second.addToInventory('player', 'ore', 3, 'b', 'credit'),
  ]);
  assert.equal(harness.data('inventory_data').player.ore, 15);
});

test('remove, set, and reset mutate latest PostgreSQL state rather than cached snapshots', async () => {
  const harness = createPostgresHarness();
  const { manager } = await loadManager(harness);

  // Simulate another application updating the shared JSON snapshot after this
  // manager loaded its local cache.
  harness.setData('inventory_data', { player: { ore: 10, vote_token: 7 } });
  await manager.setInventoryItem('player', 'ore', 8, 'admin', 'set');
  assert.equal(harness.data('inventory_data').player.vote_token, 7);
  await manager.removeFromInventory('player', 'ore', 3, 'admin', 'remove');
  assert.equal(harness.data('inventory_data').player.ore, 5);
  assert.equal(harness.data('inventory_data').player.vote_token, 7);
  const reset = await manager.resetPlayerInventory('player', 'admin', 'reset');
  assert.equal(reset.itemsCleared, 2);
  assert.equal(harness.data('inventory_data').player, undefined);
  assert.equal(harness.data('inventory_transactions').length, 4);
});

test('malformed credits are rejected before persistence', async () => {
  const harness = createPostgresHarness();
  const { manager } = await loadManager(harness);
  await assert.rejects(manager.applyInventoryCredits('player', [{ itemTypeId: 'ore', quantity: -1 }]), /non-negative/);
  await assert.rejects(manager.applyInventoryCredits('player', [{ itemTypeId: 'ore', quantity: Infinity }]), /finite/);
  await assert.rejects(
    manager.applyInventoryCredits('player', [{ itemTypeId: 'ore', quantity: 1 }], null, null, { idempotencyFingerprint: ' ' }),
    /idempotencyFingerprint/
  );
  assert.equal(harness.data('inventory_data').player.ore, 10);
});

test('metadata file saves preserve inventory snapshots and idempotency receipts', async () => {
  const harness = createPostgresHarness();
  const { manager, files, filePath } = await loadManager(harness);
  const fileState = {
    itemTypes: [{ id: 'ore', name: 'Ore' }],
    categories: [],
    inventories: { player: { ore: 41 } },
    transactions: [{ id: 'durable-transaction' }],
    receipts: { 'durable-receipt': { playerId: 'player' } },
  };
  files.set(filePath, JSON.stringify(fileState));

  await manager.addCategory({ id: 'new-category', name: 'New category' });
  const saved = JSON.parse(files.get(filePath));
  assert.deepEqual(saved.inventories, fileState.inventories);
  assert.deepEqual(saved.transactions, fileState.transactions);
  assert.deepEqual(saved.receipts, fileState.receipts);
  assert.equal(saved.categories[0].id, 'new-category');
});

test('strict cache refresh throws instead of silently retaining stale inventory', async () => {
  const harness = createPostgresHarness();
  const { manager } = await loadManager(harness);
  harness.setData('inventory_data', { player: { ore: 22 } });
  harness.failNextRead('inventory_data');

  await assert.rejects(manager.refreshInventoryCache(), /mock read failure/);
  assert.equal(manager.getPlayerInventory('player').ore, 10);

  harness.failNextRead(null);
  await manager.refreshInventoryCache({ throwOnError: true });
  assert.equal(manager.getPlayerInventory('player').ore, 22);
});

test('initialization reads strictly and insert-only migrations preserve a racing row', async () => {
  const harness = createPostgresHarness();
  const concurrentInventory = { player: { ore: 88, dashboard_item: 4 } };
  const { manager } = await loadManager(harness, () => {
    harness.removeData('inventory_data');
    harness.raceMigrationWith('inventory_data', concurrentInventory);
  });

  assert.deepEqual(harness.data('inventory_data'), concurrentInventory);
  assert.deepEqual(manager.getAllInventories(), concurrentInventory);
  for (const key of ['inventory_item_types', 'inventory_data', 'inventory_transactions', 'inventory_categories']) {
    assert.equal(harness.readOptions.get(key).throwOnError, true);
  }
});

test('corrupt persisted snapshots and balances abort before credit or receipt commit', async () => {
  const harness = createPostgresHarness();
  const { manager } = await loadManager(harness);

  harness.setData('inventory_data', []);
  await assert.rejects(
    manager.applyInventoryCredits('player', [{ itemTypeId: 'ore', quantity: 5 }], 'admin', 'credit', {
      idempotencyKey: 'corrupt-state',
    }),
    /inventory_data must be a plain object/
  );
  assert.deepEqual(harness.data('inventory_credit_receipts'), {});

  harness.setData('inventory_data', { player: { ore: '10' } });
  await assert.rejects(
    manager.applyInventoryCredits('player', [{ itemTypeId: 'ore', quantity: 5 }], 'admin', 'credit', {
      idempotencyKey: 'invalid-balance',
    }),
    /finite non-negative number/
  );
  assert.deepEqual(harness.data('inventory_data'), { player: { ore: '10' } });
  assert.deepEqual(harness.data('inventory_credit_receipts'), {});

  harness.setData('inventory_data', 'not-json');
  await assert.rejects(
    manager.applyInventoryCredits('player', [{ itemTypeId: 'ore', quantity: 5 }]),
    SyntaxError
  );
});