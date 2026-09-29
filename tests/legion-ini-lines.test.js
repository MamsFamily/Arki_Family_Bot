const test = require('node:test');
const assert = require('node:assert/strict');
const legion = require('../web/legionManager');
const booster = require('../boosterReproManager');
const lines = require('../web/legionIniLines');
const iniLock = require('../web/legionIniMutationLock');

const [first, second, third] = legion.MAPS.map(map => map.id);
const base = {
  ids: [first],
  file: 'Game.ini',
  operation: 'add',
  section: '[/Script/ShooterGame.ShooterGameMode]',
  after: 'XPMultiplier=2',
};

test('ajout, modification et suppression ciblent une section et préservent CRLF', () => {
  const original = '[One]\r\nKeep=1\r\n[/Script/ShooterGame.ShooterGameMode]\r\nOld=1\r\n\r\n[Other]\r\nKeep=2\r\n';
  const added = lines.editContent(original, lines.validate(base));
  assert.equal(added, '[One]\r\nKeep=1\r\n[/Script/ShooterGame.ShooterGameMode]\r\nOld=1\r\nXPMultiplier=2\r\n\r\n[Other]\r\nKeep=2\r\n');
  const changed = lines.editContent(added, lines.validate({
    ...base, operation: 'replace', before: 'Old=1', after: 'Old=3',
  }));
  assert.match(changed, /Old=3\r\nXPMultiplier=2/);
  const removed = lines.editContent(changed, lines.validate({
    ...base, operation: 'remove', before: 'XPMultiplier=2',
  }));
  assert.equal(removed, original.replace('Old=1', 'Old=3'));
});

test('refuse les cartes hors cluster, chemins arbitraires, clés sensibles et lignes ambiguës', () => {
  assert.throws(() => lines.validate({ ...base, ids: [] }), /invalide/);
  assert.throws(() => lines.validate({ ...base, ids: [first, 'serveur-test'] }), /autorisés/);
  assert.throws(() => lines.validate({ ...base, ids: [first, first] }), /invalide/);
  assert.throws(() => lines.validate({ ...base, file: '../Game.ini' }), /non autorisé/);
  assert.throws(() => lines.validate({ ...base, after: 'AdminPassword=abc' }), /sensibles/);
  assert.throws(() => lines.validate({ ...base, after: 'Line=1\nOther=2' }), /une seule ligne/);
  assert.throws(() => lines.editContent('[Other]\nX=1\n', lines.validate(base)), /Section absente/);
  assert.throws(() => lines.editContent(`${base.section}\nX=1\n${base.section}\n`, lines.validate(base)), /plusieurs fois/);
  assert.throws(() => lines.editContent(`${base.section}\n${base.after}\n`, lines.validate(base)), /existe déjà/);
  assert.throws(() => lines.editContent(`${base.section}\nXPMultiplier=1\n`, lines.validate(base)), /clé existe déjà/);
  assert.throws(() => lines.editContent(`${base.section}\nAnother=1\nXPMultiplier=1\n`,
    lines.validate({ ...base, operation:'replace', before:'Another=1' })), /nouvelle clé existe déjà/);
  assert.match(lines.editContent(`${base.section}\n+Array=(A=1)\n`,
    lines.validate({ ...base, after:'+Array=(A=2)' })), /\+Array=\(A=2\)/);
  assert.throws(() => lines.editContent(`${base.section}\nX=1\nX=1\n`,
    lines.validate({ ...base, operation: 'remove', before: 'X=1' })), /plusieurs fois/);
});

test('aperçu sans écriture puis écriture vérifiée sur plusieurs cartes', async () => {
  const originalRead = legion.readFile;
  const originalWrite = legion.writeFile;
  const originalSessions = booster.loadSessions;
  const originalLock = iniLock.withMapIniLock;
  const content = new Map([[first, `${base.section}\nOld=1\n`], [second, `${base.section}\nOld=1\n`]]);
  const writes = [];
  legion.readFile = async (id, file) => {
    assert.equal(file, lines.FILES['Game.ini']);
    return content.get(id);
  };
  legion.writeFile = async (id, file, value) => {
    assert.equal(file, lines.FILES['Game.ini']);
    writes.push(id);
    content.set(id, value);
  };
  booster.loadSessions = async () => [];
  iniLock.withMapIniLock = async (_id, work) => work();
  try {
    const input = { ...base, ids: [first, second] };
    const preview = await lines.preview(input);
    assert.equal(preview.ok, true);
    assert.equal(preview.maps.length, 2);
    assert.equal(writes.length, 0);
    assert.equal(JSON.stringify(preview).includes('Old=1'), false);
    const applied = await lines.apply({ ...input, expected: preview.maps.map(({ id, hash }) => ({ id, hash })) });
    assert.equal(applied.ok, true);
    assert.deepEqual(writes, [first, second]);
    assert.match(content.get(second), /XPMultiplier=2/);
  } finally {
    legion.readFile = originalRead;
    legion.writeFile = originalWrite;
    booster.loadSessions = originalSessions;
    iniLock.withMapIniLock = originalLock;
  }
});

test('refuse tout le lot si un fichier a changé, sans écriture', async () => {
  const originalRead = legion.readFile;
  const originalWrite = legion.writeFile;
  const originalSessions = booster.loadSessions;
  const originalLock = iniLock.withMapIniLock;
  const content = new Map([[first, `${base.section}\nOld=1\n`], [second, `${base.section}\nOld=1\n`]]);
  let writes = 0;
  legion.readFile = async id => content.get(id);
  legion.writeFile = async () => { writes++; };
  booster.loadSessions = async () => [];
  iniLock.withMapIniLock = async (_id, work) => work();
  try {
    const input = { ...base, ids: [first, second] };
    const preview = await lines.preview(input);
    content.set(second, `${base.section}\nOld=9\n`);
    await assert.rejects(lines.apply({
      ...input, expected: preview.maps.map(({ id, hash }) => ({ id, hash })),
    }), /changé/);
    assert.equal(writes, 0);
    await assert.rejects(lines.apply({ ...input, expected: [] }), /Prévisualisation/);
  } finally {
    legion.readFile = originalRead;
    legion.writeFile = originalWrite;
    booster.loadSessions = originalSessions;
    iniLock.withMapIniLock = originalLock;
  }
});

test('un échec après une première écriture laisse les résultats explicites et arrête le lot', async () => {
  const originalRead = legion.readFile;
  const originalWrite = legion.writeFile;
  const originalSessions = booster.loadSessions;
  const originalLock = iniLock.withMapIniLock;
  const content = new Map([first, second, third].map(id => [id, `${base.section}\nOld=1\n`]));
  const writes = [];
  legion.readFile = async id => content.get(id);
  legion.writeFile = async (id, _path, value) => {
    writes.push(id);
    if (id === second) throw new Error('GPanel indisponible');
    content.set(id, value);
  };
  booster.loadSessions = async () => [];
  iniLock.withMapIniLock = async (_id, work) => work();
  try {
    const input = { ...base, ids: [first, second, third] };
    const preview = await lines.preview(input);
    const applied = await lines.apply({
      ...input, expected: preview.maps.map(({ id, hash }) => ({ id, hash })),
    });
    assert.equal(applied.ok, false);
    assert.deepEqual(applied.results.map(result => result.ok), [true, false, false]);
    assert.match(applied.results[2].error, /Non traitée/);
    assert.deepEqual(writes, [first, second]);
  } finally {
    legion.readFile = originalRead;
    legion.writeFile = originalWrite;
    booster.loadSessions = originalSessions;
    iniLock.withMapIniLock = originalLock;
  }
});

test('aucune modification pendant un booster actif', async () => {
  const originalRead = legion.readFile;
  const originalSessions = booster.loadSessions;
  let reads = 0;
  booster.loadSessions = async () => [{ serviceId: first, status: 'active', iniApplied: false }];
  legion.readFile = async () => { reads++; return ''; };
  try {
    await assert.rejects(lines.preview(base), /Booster Repro/);
    assert.equal(reads, 0);
  } finally {
    legion.readFile = originalRead;
    booster.loadSessions = originalSessions;
  }
});

test('GameUserSettings.ini est pris en charge et une carte incompatible bloque tout le lot', async () => {
  const originalRead = legion.readFile;
  const originalWrite = legion.writeFile;
  const originalSessions = booster.loadSessions;
  let writes = 0;
  legion.readFile = async (id, file) => {
    assert.equal(file, lines.FILES['GameUserSettings.ini']);
    return id === first ? '[ServerSettings]\nTamingSpeedMultiplier=1\n' : '[Other]\nX=1\n';
  };
  legion.writeFile = async () => { writes++; };
  booster.loadSessions = async () => [];
  try {
    const input = {
      ids: [first, second], file: 'GameUserSettings.ini',
      section: '[ServerSettings]', operation: 'add', after: 'HarvestAmountMultiplier=2',
    };
    const preview = await lines.preview(input);
    assert.equal(preview.ok, false);
    assert.match(preview.maps[1].error, /Section absente/);
    await assert.rejects(lines.apply({
      ...input, expected: preview.maps.map(map => ({ id: map.id, hash: map.hash || '0'.repeat(64) })),
    }), /refais la prévisualisation/);
    assert.equal(writes, 0);
  } finally {
    legion.readFile = originalRead;
    legion.writeFile = originalWrite;
    booster.loadSessions = originalSessions;
  }
});

test('le verrou inter-processus est libéré après écriture et bloque les accès concurrents', async () => {
  const store = require('../pgStore');
  const originalPool = store.getPool;
  const statements = [];
  let releases = 0;
  let lockAvailable = true;
  store.getPool = () => ({
    connect: async () => ({
      query: async (sql, params) => {
        statements.push([sql, params]);
        return { rows: [{ acquired: lockAvailable }] };
      },
      release: () => { releases++; },
    }),
  });
  try {
    assert.equal(await iniLock.withMapIniLock(first, async () => 'écrit'), 'écrit');
    assert.match(statements[0][0], /pg_try_advisory_lock/);
    assert.match(statements[1][0], /pg_advisory_unlock/);
    assert.equal(releases, 1);
    lockAvailable = false;
    await assert.rejects(iniLock.withMapIniLock(first, async () => 'ne doit pas passer'), /en cours/);
    assert.equal(releases, 2);
    assert.equal(statements.length, 3);
    await assert.rejects(iniLock.withMapIniLock('serveur-test', async () => {}), /autorisés/);
    assert.equal(statements.length, 3);
  } finally {
    store.getPool = originalPool;
  }
});