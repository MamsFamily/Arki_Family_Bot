const fs = require('fs');
const path = require('path');

const INVENTORY_PATH = path.join(__dirname, 'inventory.json');
const PG_KEYS = ['inventory_data', 'inventory_transactions', 'inventory_credit_receipts'];
let fileMutationQueue = Promise.resolve();

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

function defaultState() {
  return { inventories: {}, transactions: [], receipts: {} };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validatePersistedState(state) {
  if (!isPlainObject(state.inventories)) {
    throw new Error('Persisted inventory_data must be a plain object');
  }
  for (const [playerId, inventory] of Object.entries(state.inventories)) {
    if (!isPlainObject(inventory)) {
      throw new Error(`Persisted inventory for player "${playerId}" must be a plain object`);
    }
  }
  if (!Array.isArray(state.transactions)) {
    throw new Error('Persisted inventory_transactions must be an array');
  }
  if (!isPlainObject(state.receipts)) {
    throw new Error('Persisted inventory_credit_receipts must be a plain object');
  }
}

function normalizeIdempotencyKeys({ idempotencyKey, idempotencyKeys } = {}) {
  const keys = [];
  if (idempotencyKey !== undefined) keys.push(idempotencyKey);
  if (idempotencyKeys !== undefined) {
    if (!Array.isArray(idempotencyKeys)) throw new TypeError('idempotencyKeys must be an array');
    keys.push(...idempotencyKeys);
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !key.trim()) {
      throw new TypeError('Idempotency keys must be non-empty strings');
    }
  }
  return [...new Set(keys)];
}

function validateCredits(playerId, credits, options) {
  if (typeof playerId !== 'string' || !playerId.trim()) {
    throw new TypeError('playerId must be a non-empty string');
  }
  if (!Array.isArray(credits) || credits.length === 0) {
    throw new TypeError('credits must be a non-empty array');
  }
  normalizeIdempotencyKeys(options);
  if (options?.idempotencyFingerprint !== undefined &&
      (typeof options.idempotencyFingerprint !== 'string' || !options.idempotencyFingerprint.trim())) {
    throw new TypeError('idempotencyFingerprint must be a non-empty string');
  }
  for (const credit of credits) {
    if (!credit || typeof credit.itemTypeId !== 'string' || !credit.itemTypeId.trim()) {
      throw new TypeError('Each credit requires a non-empty itemTypeId');
    }
    if (typeof credit.quantity !== 'number' || !Number.isFinite(credit.quantity) || credit.quantity < 0) {
      throw new TypeError('Credit quantities must be finite, non-negative numbers');
    }
  }
}

function createInventoryPersistence({
  pgStore,
  filePath = INVENTORY_PATH,
  fsImpl = fs,
  getFileDefaults = defaultState,
}) {
  async function withPostgresMutation(mutator) {
    const pool = pgStore.getPool();
    if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL pool is unavailable');
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      // Insert and lock in the same stable order in every inventory transaction.
      for (const key of PG_KEYS) {
        await client.query(
          `INSERT INTO app_data (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO NOTHING`,
          [key, JSON.stringify(key === 'inventory_transactions' ? [] : {})]
        );
      }
      const locked = await client.query(
        'SELECT key, value FROM app_data WHERE key = ANY($1::text[]) ORDER BY key FOR UPDATE',
        [PG_KEYS]
      );
      const values = Object.fromEntries(locked.rows.map(row => [row.key, parseJson(row.value, null)]));
      const state = {
        inventories: values.inventory_data === undefined ? {} : values.inventory_data,
        transactions: values.inventory_transactions === undefined ? [] : values.inventory_transactions,
        receipts: values.inventory_credit_receipts === undefined ? {} : values.inventory_credit_receipts,
      };
      validatePersistedState(state);
      const result = await mutator(state);
      for (const [key, value] of [
        ['inventory_data', state.inventories],
        ['inventory_transactions', state.transactions],
        ['inventory_credit_receipts', state.receipts],
      ]) {
        const update = await client.query(
          'UPDATE app_data SET value = $2::jsonb, updated_at = NOW() WHERE key = $1',
          [key, JSON.stringify(value)]
        );
        if (update.rowCount === 0) throw new Error(`Failed to persist ${key}`);
      }
      await client.query('COMMIT');
      inTransaction = false;
      return { result, state };
    } catch (error) {
      if (inTransaction) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  function readFileState() {
    let data = getFileDefaults();
    if (fsImpl.existsSync(filePath)) {
      data = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    }
    return {
      inventories: data.inventories === undefined ? {} : data.inventories,
      transactions: data.transactions === undefined ? [] : data.transactions,
      receipts: data.receipts === undefined ? {} : data.receipts,
      fileData: data,
    };
  }

  function persistFileState(state, fileData) {
    const data = {
      ...fileData,
      inventories: state.inventories,
      transactions: state.transactions,
      receipts: state.receipts,
    };
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fsImpl.writeFileSync(temporaryPath, JSON.stringify(data, null, 2));
      fsImpl.renameSync(temporaryPath, filePath);
    } catch (error) {
      try { if (fsImpl.existsSync(temporaryPath)) fsImpl.unlinkSync(temporaryPath); } catch {}
      throw error;
    }
  }

  async function mutateInventory(mutator) {
    if (pgStore.isPostgres()) return withPostgresMutation(mutator);
    const operation = fileMutationQueue.then(async () => {
      const loaded = readFileState();
      const state = {
        inventories: loaded.inventories,
        transactions: loaded.transactions,
        receipts: loaded.receipts,
      };
      validatePersistedState(state);
      const result = await mutator(state);
      persistFileState(state, loaded.fileData);
      return { result, state };
    });
    fileMutationQueue = operation.catch(() => {});
    return operation;
  }

  async function applyInventoryCredits(playerId, credits, adminId, reason, options = {}) {
    const keys = normalizeIdempotencyKeys(options);
    validateCredits(playerId, credits, options);
    const fingerprint = options.idempotencyFingerprint;
    const { result, state } = await mutateInventory(state => {
      const existing = keys.map(key => ({ key, receipt: state.receipts[key] })).filter(entry => entry.receipt);
      for (const { key, receipt } of existing) {
        if (receipt.playerId !== playerId) {
          throw new Error(`Idempotency key "${key}" was already applied to another player`);
        }
        if (fingerprint !== undefined && receipt.fingerprint !== fingerprint) {
          throw new Error('Une autre décision a déjà été enregistrée pour ces récompenses');
        }
      }
      if (existing.length > 0 && existing.length !== keys.length) {
        throw new Error('Some idempotency keys were already applied; manual review is required');
      }
      if (existing.length === keys.length && keys.length > 0) {
        return { ...existing[0].receipt.result, alreadyApplied: true };
      }

      const transactions = [];
      let newQuantity = 0;
      for (const { itemTypeId, quantity } of credits) {
        const inventory = state.inventories[playerId] || (state.inventories[playerId] = {});
        const hasCurrentBalance = Object.prototype.hasOwnProperty.call(inventory, itemTypeId);
        const current = hasCurrentBalance ? inventory[itemTypeId] : 0;
        if (typeof current !== 'number' || !Number.isFinite(current) || current < 0) {
          throw new Error(`Persisted inventory balance for "${playerId}/${itemTypeId}" must be a finite non-negative number`);
        }
        newQuantity = current + quantity;
        if (!Number.isFinite(newQuantity)) {
          throw new Error(`Inventory balance overflow for "${playerId}/${itemTypeId}"`);
        }
        inventory[itemTypeId] = newQuantity;
        transactions.push({
          id: generateId(),
          playerId,
          itemTypeId,
          quantity,
          adminId: adminId || 'system',
          reason: reason || '',
          type: 'add',
          timestamp: new Date().toISOString(),
        });
      }
      state.transactions.push(...transactions);
      trimHistory(state.transactions);
      const applied = {
        newQuantity,
        transaction: transactions[0] || null,
        transactions,
        alreadyApplied: false,
      };
      for (const key of keys) {
        state.receipts[key] = {
          playerId,
          ...(fingerprint !== undefined ? { fingerprint } : {}),
          result: applied,
        };
      }
      return applied;
    });
    return { result, state };
  }

  async function getInventoryCreditReceipt(idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      throw new TypeError('idempotencyKey must be a non-empty string');
    }
    if (pgStore.isPostgres()) {
      const receipts = await pgStore.getData('inventory_credit_receipts', {}, { throwOnError: true });
      return receipts?.[idempotencyKey] || null;
    }
    return readFileState().receipts[idempotencyKey] || null;
  }

  return { mutateInventory, applyInventoryCredits, getInventoryCreditReceipt };
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function trimHistory(transactions, limit = 50000) {
  if (transactions.length > limit) transactions.splice(0, transactions.length - limit);
}

module.exports = { createInventoryPersistence, trimHistory, validateCredits };