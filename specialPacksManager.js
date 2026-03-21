const fs = require('fs');
const path = require('path');
const pgStore = require('./pgStore');

const FILE_PATH = path.join(__dirname, 'special-packs.json');
const PG_KEY = 'special_packs';

let cachedData = null;

function loadFromFile() {
  try {
    if (fs.existsSync(FILE_PATH)) return JSON.parse(fs.readFileSync(FILE_PATH, 'utf-8'));
  } catch (e) {}
  return { packs: [] };
}

function saveToFile(data) {
  try { fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2)); } catch (e) {}
}

async function initSpecialPacks() {
  if (pgStore.isPostgres()) {
    const pg = await pgStore.getData(PG_KEY);
    if (!pg) {
      const file = loadFromFile();
      await pgStore.setData(PG_KEY, file);
    }
    cachedData = await pgStore.getData(PG_KEY);
  } else {
    cachedData = loadFromFile();
  }
  if (!cachedData) cachedData = { packs: [] };
}

function getSpecialPacks() {
  const data = cachedData || loadFromFile();
  if (!data.packs) data.packs = [];
  return data;
}

async function saveSpecialPacks(data) {
  cachedData = data;
  if (pgStore.isPostgres()) await pgStore.setData(PG_KEY, data);
  saveToFile(data);
}

function getSpecialPack(id) {
  return getSpecialPacks().packs.find(p => p.id === id) || null;
}

async function addSpecialPack(pack) {
  const data = getSpecialPacks();
  pack.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  pack.createdAt = new Date().toISOString();
  data.packs.push(pack);
  await saveSpecialPacks(data);
  return pack;
}

async function updateSpecialPack(id, updates) {
  const data = getSpecialPacks();
  const idx = data.packs.findIndex(p => p.id === id);
  if (idx === -1) return null;
  data.packs[idx] = { ...data.packs[idx], ...updates };
  await saveSpecialPacks(data);
  return data.packs[idx];
}

async function deleteSpecialPack(id) {
  const data = getSpecialPacks();
  data.packs = data.packs.filter(p => p.id !== id);
  await saveSpecialPacks(data);
}

module.exports = { initSpecialPacks, getSpecialPacks, getSpecialPack, addSpecialPack, updateSpecialPack, deleteSpecialPack };
