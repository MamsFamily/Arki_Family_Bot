'use strict';

const fs = require('fs');
const path = require('path');
const pgStore = require('./pgStore');
const inventoryManager = require('./inventoryManager');

const LOCAL_SETTLEMENTS_PATH = path.join(__dirname, 'summer-event-settlements.json');
const SETTLEMENTS_KEY = 'summer_event_settlements';
const locks = new Map();

function readLocalSettlements() {
  try {
    if (fs.existsSync(LOCAL_SETTLEMENTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(LOCAL_SETTLEMENTS_PATH, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    }
  } catch (err) {
    console.error('[SummerEvent] Impossible de lire les clôtures locales:', err.message);
  }
  return {};
}

function writeLocalSettlements(data) {
  const tempPath = `${LOCAL_SETTLEMENTS_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, LOCAL_SETTLEMENTS_PATH);
}

async function getSettlements() {
  if (pgStore.isPostgres()) return (await pgStore.getData(SETTLEMENTS_KEY, null)) || {};
  return readLocalSettlements();
}

async function saveSettlements(data) {
  if (pgStore.isPostgres()) {
    await pgStore.setData(SETTLEMENTS_KEY, data);
  } else {
    writeLocalSettlements(data);
  }
}

function normalizeWallets(wallets) {
  if (!Array.isArray(wallets)) {
    throw new Error('wallets doit être un tableau');
  }

  const merged = new Map();
  for (const wallet of wallets) {
    const userId = String(wallet?.discordId || wallet?.user_id || wallet?.userId || '').trim();
    const balance = Number(wallet?.soleils ?? wallet?.balance);
    if (!/^\d{17,20}$/.test(userId)) {
      throw new Error(`Identifiant Discord invalide : ${userId || '(vide)'}`);
    }
    if (!Number.isInteger(balance) || balance < 0) {
      throw new Error(`Solde de Soleils invalide pour ${userId}`);
    }
    merged.set(userId, (merged.get(userId) || 0) + balance);
  }

  return [...merged.entries()].map(([discordId, soleils]) => ({ discordId, soleils }));
}

function withClosureLock(closureId, work) {
  const previous = locks.get(closureId) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  locks.set(closureId, current.finally(() => {
    if (locks.get(closureId) === current) locks.delete(closureId);
  }));
  return current;
}

async function settleSummerEvent({ closureId, wallets, memberResolver = null }) {
  const normalizedClosureId = String(closureId || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(normalizedClosureId)) {
    throw new Error('closureId invalide');
  }

  const normalizedWallets = normalizeWallets(wallets);
  return withClosureLock(normalizedClosureId, async () => {
    const settlements = await getSettlements();
    if (settlements[normalizedClosureId]) {
      return {
        ...settlements[normalizedClosureId],
        duplicate: true,
      };
    }

    const reason = `Arki' Summer — conversion Soleils (${normalizedClosureId})`;
    const report = {
      closureId: normalizedClosureId,
      ratio: '1:1',
      createdAt: new Date().toISOString(),
      credited: [],
      skipped: [],
      unknownUsers: [],
      errors: [],
    };

    for (const { discordId, soleils } of normalizedWallets) {
      if (soleils === 0) {
        report.skipped.push({ discordId, soleils, reason: 'solde nul' });
        continue;
      }

      if (memberResolver) {
        const member = await memberResolver(discordId);
        if (!member) {
          report.unknownUsers.push({ discordId, soleils });
          continue;
        }
      }

      const existing = inventoryManager
        .getTransactions({ playerId: discordId, itemTypeId: 'diamants', limit: 50000 })
        .transactions
        .some((transaction) => transaction.reason === reason);

      if (existing) {
        report.skipped.push({ discordId, soleils, reason: 'déjà crédité' });
        continue;
      }

      try {
        const result = await inventoryManager.addToInventory(
          discordId,
          'diamants',
          soleils,
          'summer-event',
          reason,
        );
        report.credited.push({
          discordId,
          soleils,
          diamants: soleils,
          newQuantity: result.newQuantity,
        });
      } catch (err) {
        report.errors.push({ discordId, soleils, error: err.message });
      }
    }

    report.success = report.errors.length === 0 && report.unknownUsers.length === 0;
    // Une clôture partielle reste rejouable : les crédits déjà effectués sont
    // détectés par leur raison idempotente et les membres introuvables pourront
    // être repris lors d'un nouvel envoi du même snapshot.
    if (report.success) {
      await saveSettlements(settlementsWithResult(settlements, normalizedClosureId, report));
    }
    return report;
  });
}

function settlementsWithResult(settlements, closureId, report) {
  return { ...settlements, [closureId]: report };
}

module.exports = { settleSummerEvent };