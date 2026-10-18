const test = require('node:test');
const assert = require('node:assert/strict');
const legion = require('../web/legionManager');
const lines = require('../web/legionIniLines');

test('valide une liste CurseForge ordonnée et accepte une liste vide', () => {
  assert.deepEqual(legion.parseModIds('929420, 926956,927131'), ['929420', '926956', '927131']);
  assert.deepEqual(legion.parseModIds(''), []);
  assert.deepEqual(legion.parseModIds(null), []);
});

test('refuse IDs non numériques, doublons et listes trop longues', () => {
  assert.throws(() => legion.parseModIds('929420,abc'), /IDs CurseForge numériques/);
  assert.throws(() => legion.parseModIds('929420,929420'), /une seule fois/);
  assert.throws(() => legion.parseModIds(Array.from({ length: 51 }, (_, i) => String(i + 1)).join(',')), /maximum 50/);
});

test('ne retourne que la variable de démarrage des mods', () => {
  const result = legion.getModStartupVariable({
    data: [
      { attributes: { env_variable: 'ADMIN_PASSWORD', server_value: 'do-not-return' } },
      { attributes: { env_variable: 'MODS', name: 'Mod IDs', server_value: '929420,926956' } },
    ],
  });
  assert.deepEqual(result, { key: 'MODS', modIds: ['929420', '926956'], editable: true });
  assert.throws(() => legion.getModStartupVariable({ data: [] }), /Mod IDs.*introuvable/);
});

test('réserve ActiveMods au gestionnaire de mods dédié', () => {
  const request = {
    ids: [legion.MAPS[0].id],
    file: 'GameUserSettings.ini',
    operation: 'add',
    section: '[ServerSettings]',
    after: 'ActiveMods=929420',
  };
  assert.throws(() => lines.validate(request), /onglet « Mods »/);
});
