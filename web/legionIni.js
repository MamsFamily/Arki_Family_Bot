const legion = require('./legionManager');
const iniLock = require('./legionIniMutationLock');
const booster = require('../boosterReproManager');
const iniSafety = require('./legionIniSafety');

const ROOT = '/ShooterGame/Saved/Config/WindowsServer/';
const GAME = { path: `${ROOT}Game.ini`, section: '/Script/ShooterGame.ShooterGameMode' };
const SETTINGS = { path: `${ROOT}GameUserSettings.ini`, section: 'ServerSettings' };
// Former dashboard presets only. Passwords, RCON settings and arbitrary paths
// are deliberately excluded from the writable interface.
const PRESETS = Object.freeze({
  MatingIntervalMultiplier: GAME,
  BabyImprintAmountMultiplier: GAME,
  BabyMatureSpeedMultiplier: GAME,
  BabyFoodConsumptionSpeedMultiplier: GAME,
  EggHatchSpeedMultiplier: GAME,
  TamingSpeedMultiplier: SETTINGS,
  HarvestAmountMultiplier: SETTINGS,
  XPMultiplier: SETTINGS,
  PlayerDamageMultiplier: SETTINGS,
});

function replaceKey(content, section, key, value) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const header = `[${section}]`.toLowerCase();
  let inside = false;
  let lastSection = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].replace(/^\uFEFF/, '').trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inside = trimmed.toLowerCase() === header;
      if (inside) lastSection = i;
    } else if (inside && trimmed.includes('=') &&
               trimmed.slice(0, trimmed.indexOf('=')).trim().toLowerCase() === key.toLowerCase()) {
      lines[i] = `${key}=${value}`;
      return lines.join(newline);
    }
  }
  if (lastSection < 0) {
    if (lines.at(-1) !== '') lines.push('');
    lines.push(`[${section}]`, `${key}=${value}`);
  } else {
    let index = lastSection + 1;
    while (index < lines.length && !/^\s*\[.*\]\s*$/.test(lines[index])) index++;
    lines.splice(index, 0, `${key}=${value}`);
  }
  return lines.join(newline);
}

async function updateSettingUnlocked(mapId, key, value) {
  legion.assertMap(mapId);
  if (!Object.hasOwn(PRESETS, key)) throw new Error('Paramètre INI non autorisé');
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ||
      !Number.isFinite(Number(value)) || Number(value) <= 0 || value.length > 30) {
    throw new Error('Valeur INI invalide : nombre positif requis');
  }
  // A manual breeding edit during a boost would invalidate the saved backup.
  const active = (await booster.loadSessions()).some(s =>
    s.serviceId === mapId && s.status === 'active' && s.iniApplied);
  if (active) throw new Error('Modification refusée pendant une session Booster Repro active');
  const preset = PRESETS[key];
  const original = await legion.readFile(mapId, preset.path);
  const updated = replaceKey(original, preset.section, key, value);
  if (updated === original) return { changed: false, verified: false };
  // The preflight is performed only once an actual change is known.
  await iniSafety.assertMapsOffline([mapId]);
  // Abort when the file changed since the first read; do not overwrite an
  // unrelated panel edit that happened in between.
  if (await legion.readFile(mapId, preset.path) !== original) {
    throw new Error('Fichier modifié simultanément : recommencez');
  }
  // Recheck immediately before the write while the per-map advisory lock is held.
  await iniSafety.assertMapsOffline([mapId]);
  await legion.writeFile(mapId, preset.path, updated);
  if (await legion.readFile(mapId, preset.path) !== updated) {
    throw new Error('Écriture INI non confirmée par relecture ; vérifiez le fichier dans GPanel');
  }
  return { changed: true, verified: true };
}

async function updateSetting(mapId, key, value) {
  return iniLock.withMapIniLock(mapId, () => updateSettingUnlocked(mapId, key, value));
}

module.exports = { PRESETS, updateSetting, replaceKey };