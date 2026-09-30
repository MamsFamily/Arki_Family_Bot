const crypto = require('node:crypto');
const legion = require('./legionManager');
const journal = require('./legionJournal');
const booster = require('../boosterReproManager');
const iniLock = require('./legionIniMutationLock');

const ROOT = '/ShooterGame/Saved/Config/WindowsServer/';
const FILES = Object.freeze({
  'Game.ini': `${ROOT}Game.ini`,
  'GameUserSettings.ini': `${ROOT}GameUserSettings.ini`,
});
const OPERATIONS = new Set(['add', 'replace', 'remove']);
const SENSITIVE_KEY = /(?:password|secret|token|api.?key|auth)/i;
const SENSITIVE_SUGGESTION_KEY = /(?:password|passwd|pwd|passphrase|secret|token|api.?key|auth|rcon|webhook|url|uri|credential|private|pin|otp|dsn)/i;
const SAFE_SUGGESTION_VALUE = /^(?:[+-]?\d{1,12}(?:\.\d{1,8})?(?:[smhd])?|true|false|yes|no)$/i;
const PUBLIC_VALUE_KEYS = /^(?:ItemStatClamps\[\d+\]|XPMultiplier|MatingIntervalMultiplier|HarvestAmountMultiplier|TamingSpeedMultiplier|SpawnIntervalMin|SpawnIntervalMax|DinoLifetimeMin|DinoLifetimeMax|DinoLevelMin|DinoLevelMax|MaxNumShinies|NumSearchLoops|RandomSelectionBias|CanCarryShinies)$/i;
const PUBLIC_TEXT_KEYS = /^(?:SessionName|ServerName)$/i;
let applying = false;

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validLine(line) {
  if (typeof line !== 'string' || !line.trim() || line.length > 4096 ||
      /[\r\n\u0000-\u001F\u007F]/.test(line)) {
    throw requestError('Chaque valeur doit être une seule ligne INI non vide (4096 caractères maximum).');
  }
  const equals = line.indexOf('=');
  const key = equals > 0 ? line.slice(0, equals).trim() : '';
  // ARK uses indexed INI keys such as ItemStatClamps[1] alongside plain keys.
  if (!/^[+!.-]?[A-Za-z_][A-Za-z0-9_.]*(?:\[\d+\])?$/.test(key)) {
    throw requestError('La ligne doit être une affectation INI de la forme Clé=Valeur.');
  }
  if (SENSITIVE_KEY.test(key)) throw requestError('Les clés sensibles ne sont pas modifiables ici.');
  return line;
}

function keyOf(line) {
  const equals = line.indexOf('=');
  return equals > 0 ? line.slice(0, equals).trim().toLowerCase() : null;
}

function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    let minimum = current[0];
    for (let j = 0; j < b.length; j++) {
      current[j + 1] = Math.min(current[j] + 1, previous[j + 1] + 1,
        previous[j] + Number(a[i] !== b[j]));
      minimum = Math.min(minimum, current[j + 1]);
    }
    if (minimum > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

function closestLine(sectionLines, before) {
  const wantedKey = keyOf(before);
  const wantedValue = before.slice(before.indexOf('=') + 1);
  const indexedRoot = key => key.replace(/\[\d+\]$/, '');
  let best = null;
  for (const line of sectionLines) {
    try { validLine(line); } catch { continue; }
    const key = keyOf(line);
    if (SENSITIVE_SUGGESTION_KEY.test(key)) continue;
    let rank;
    if (key === wantedKey) rank = 0;
    else if (indexedRoot(key) === indexedRoot(wantedKey) && key !== indexedRoot(key)) rank = 1;
    else rank = 2;
    if (best && rank > best.rank) continue;
    const keyDistance = rank === 0 ? 0 :
      distance(key.slice(0, 160), wantedKey.slice(0, 160), 160) +
      Math.abs(key.length - wantedKey.length);
    const value = line.slice(line.indexOf('=') + 1);
    const safeValue = (PUBLIC_VALUE_KEYS.test(key) && SAFE_SUGGESTION_VALUE.test(value)) ||
      (PUBLIC_TEXT_KEYS.test(key) && /^[\p{L}\p{N} _'.-]{1,80}$/u.test(value));
    const wantedNumber = Number(wantedValue);
    const candidateNumber = Number(value);
    const valueDistance = /^\d+$/.test(wantedValue) && /^\d+$/.test(value) &&
        Number.isSafeInteger(wantedNumber) && Number.isSafeInteger(candidateNumber)
      ? Math.log1p(Math.abs(wantedNumber - candidateNumber))
      : distance(wantedValue.slice(0, 120), value.slice(0, 120), 120) +
        Math.min(120, Math.abs(wantedValue.length - value.length));
    const score = [rank, keyDistance, Number(!safeValue), valueDistance];
    if (!best || score.some((part, index) =>
      part < best.score[index] && score.slice(0, index).every((prior, i) => prior === best.score[i]))) {
      best = {
        line: safeValue ? line : `${line.slice(0, line.indexOf('=') + 1)}[valeur masquée]`,
        sameKey: rank === 0, redacted: !safeValue, rank, score,
      };
    }
  }
  return best && { line: best.line, sameKey: best.sameKey, redacted: best.redacted };
}

function validate(input) {
  if (!input || typeof input !== 'object') throw requestError('Formulaire INI invalide.');
  let ids;
  try { ids = journal.validateIds(input.ids); }
  catch (error) { throw requestError(error.message); }
  if (!Object.hasOwn(FILES, input.file)) throw requestError('Fichier INI non autorisé.');
  if (!OPERATIONS.has(input.operation)) throw requestError('Action INI inconnue.');
  const section = input.section;
  if (typeof section !== 'string' || section.length > 160 ||
      !/^\[[^\]\[\r\n\u0000-\u001F\u007F]+\]$/.test(section)) {
    throw requestError('Indique une section INI, par exemple [ServerSettings].');
  }
  const before = input.operation === 'add' ? null : validLine(input.before);
  const after = input.operation === 'remove' ? null : validLine(input.after);
  return { ids, file: input.file, operation: input.operation, section, before, after };
}

function editContent(original, request) {
  if (typeof original !== 'string' || original.length > 2_000_000) {
    throw requestError('Fichier INI trop volumineux ou invalide.');
  }
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const sections = lines.flatMap((line, index) =>
    line.replace(/^\uFEFF/, '').trim() === request.section ? [index] : []);
  if (sections.length !== 1) throw requestError('Section absente ou présente plusieurs fois dans ce fichier.');
  const start = sections[0] + 1;
  let end = start;
  while (end < lines.length && !/^\s*\[[^\]\r\n]+\]\s*$/.test(lines[end])) end++;
  const afterKey = request.after && keyOf(request.after);
  if (request.operation === 'add') {
    if (lines.slice(start, end).includes(request.after)) {
      throw requestError('Cette ligne existe déjà dans la section.');
    }
    if (!afterKey.startsWith('+') && !afterKey.startsWith('-') &&
        lines.slice(start, end).some(line => keyOf(line) === afterKey)) {
      throw requestError('Cette clé existe déjà dans la section : modifie la ligne existante plutôt que de l’ajouter.');
    }
    while (end > start && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, request.after);
  } else {
    const matches = [];
    for (let i = start; i < end; i++) if (lines[i] === request.before) matches.push(i);
    if (matches.length !== 1) {
      if (matches.length) throw requestError('Ligne présente plusieurs fois dans la section.');
      const error = requestError('Ligne exacte introuvable dans la section.');
      error.suggestion = closestLine(lines.slice(start, end), request.before);
      throw error;
    }
    if (request.operation === 'remove') lines.splice(matches[0], 1);
    else {
      if (!afterKey.startsWith('+') && !afterKey.startsWith('-') &&
          lines.slice(start, end).some((line, offset) =>
            start + offset !== matches[0] && keyOf(line) === afterKey)) {
        throw requestError('La nouvelle clé existe déjà dans la section.');
      }
      lines[matches[0]] = request.after;
    }
  }
  const updated = lines.join(newline);
  if (updated === original) throw requestError('Aucun changement à appliquer.');
  if (updated.length > 2_000_000) throw requestError('Fichier INI trop volumineux après modification.');
  return updated;
}

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function guardBoosts(ids) {
  const active = (await booster.loadSessions()).some(session =>
    ids.includes(session.serviceId) && session.status === 'active');
  if (active) throw requestError('Une session Booster Repro est active sur une carte sélectionnée.', 409);
}

async function prepare(request) {
  await guardBoosts(request.ids);
  const filePath = FILES[request.file];
  const maps = [];
  for (const id of request.ids) {
    const name = legion.MAPS.find(map => map.id === id).name;
    try {
      const original = await legion.readFile(id, filePath);
      const updated = editContent(original, request);
      maps.push({ id, name, hash: digest(original), updated });
    } catch (error) {
      maps.push({ id, name, error: error.message, suggestion: error.suggestion });
    }
  }
  return maps;
}

async function preview(input) {
  const request = validate(input);
  const maps = await prepare(request);
  return {
    ok: maps.every(map => !map.error),
    maps: maps.map(({ id, name, hash, error, suggestion }) => ({ id, name, hash, error, suggestion })),
  };
}

async function apply(input) {
  if (applying) throw requestError('Une autre écriture INI est en cours. Réessaie après une nouvelle prévisualisation.', 409);
  applying = true;
  try {
    const request = validate(input);
    const expected = input.expected;
    if (!Array.isArray(expected) || expected.length !== request.ids.length ||
        new Set(expected.map(item => item?.id)).size !== request.ids.length ||
        expected.some(item => !request.ids.includes(item?.id) || !/^[a-f0-9]{64}$/.test(item?.hash || ''))) {
      throw requestError('Prévisualisation manquante : recommence avant de confirmer.');
    }
    const versions = new Map(expected.map(item => [item.id, item.hash]));
    const maps = await prepare(request);
    if (maps.some(map => map.error)) {
      throw requestError('Un fichier ne correspond plus à la demande : refais la prévisualisation.', 409);
    }
    if (maps.some(map => map.hash !== versions.get(map.id))) {
      throw requestError('Un fichier a changé depuis l’aperçu : refais la prévisualisation.', 409);
    }
    const results = [];
    for (const map of maps) {
      try {
        await iniLock.withMapIniLock(map.id, async () => {
          // This lock is also taken by Booster Repro and the preset INI editor.
          const current = await legion.readFile(map.id, FILES[request.file]);
          if (digest(current) !== map.hash) throw requestError('Fichier modifié entre-temps : aucune écriture sur cette carte.', 409);
          await guardBoosts([map.id]);
          await legion.writeFile(map.id, FILES[request.file], map.updated);
          if (await legion.readFile(map.id, FILES[request.file]) !== map.updated) {
            throw requestError('Écriture non confirmée par relecture : vérifie cette carte dans GPanel.', 502);
          }
        });
        results.push({ id: map.id, name: map.name, ok: true });
      } catch (error) {
        results.push({ id: map.id, name: map.name, ok: false, error: error.message });
        // A partial failure needs manual review; do not silently proceed to more maps.
        break;
      }
    }
    for (const map of maps.slice(results.length)) {
      results.push({ id: map.id, name: map.name, ok: false, error: 'Non traitée après un échec précédent.' });
    }
    return { ok: results.every(result => result.ok), results };
  } finally {
    applying = false;
  }
}

module.exports = { FILES, validate, editContent, preview, apply };