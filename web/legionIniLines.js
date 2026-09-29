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
  if (!/^[+!.-]?[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
    throw requestError('La ligne doit être une affectation INI de la forme Clé=Valeur.');
  }
  if (SENSITIVE_KEY.test(key)) throw requestError('Les clés sensibles ne sont pas modifiables ici.');
  return line;
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
  const keyOf = line => {
    const equals = line.indexOf('=');
    return equals > 0 ? line.slice(0, equals).trim().toLowerCase() : null;
  };
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
      throw requestError(matches.length ? 'Ligne présente plusieurs fois dans la section.' :
        'Ligne exacte introuvable dans la section.');
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
      maps.push({ id, name, error: error.message });
    }
  }
  return maps;
}

async function preview(input) {
  const request = validate(input);
  const maps = await prepare(request);
  return {
    ok: maps.every(map => !map.error),
    maps: maps.map(({ id, name, hash, error }) => ({ id, name, hash, error })),
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