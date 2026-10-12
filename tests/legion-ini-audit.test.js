const test = require('node:test');
const assert = require('node:assert/strict');
const pgStore = require('../pgStore');
const legion = require('../web/legionManager');
let audit = require('../web/legionIniAudit');
const map = legion.MAPS[0].id;
const file = 'GameUserSettings.ini';
const section = '[Shiny]';
const entry = audit.target(file, section, 'MaxNumShinies=6');

test('allowlist stricte : aucune clé inconnue, secret ou valeur opaque dans le suivi', () => {
  for (const line of ['ServerPassword=1234', 'Pwd=1234', 'Webhook=https://secret.example/token',
    'UnknownGameKey=2', 'MaxNumShinies=https://secret.example/token']) {
    assert.equal(audit.target(file, section, line), null);
  }
  assert.equal(audit.target('Game.ini', section, 'MaxNumShinies=6'), null);
  assert.equal(audit.target(file, '[Unknown]', 'MaxNumShinies=6'), null);
  assert.equal(audit.target('Game.ini', '[/Script/ShooterGame.ShooterGameMode]', 'ItemStatClamps[12]=100').expected, '100');
  assert.equal(audit.target('Game.ini', '[/Script/ShooterGame.ShooterGameMode]', 'ItemStatClamps[99]=100'), null);
  assert.throws(() => audit.validateAfter(file, section, 'MaxNumShinies=opaque'), /non validée/);
});

test('ajout, suppression et changement de clé : seules les attentes autorisées sont enregistrées', () => {
  assert.deepEqual(audit.lineTargets({ file, section, before: null, after: 'MaxNumShinies=6' }), [entry]);
  assert.deepEqual(audit.lineTargets({ file, section, before: 'MaxNumShinies=6', after: null }),
    [{ ...entry, expected: null }]);
  const renamed = audit.lineTargets({ file, section, before: 'MaxNumShinies=6', after: 'NumSearchLoops=15' });
  assert.equal(renamed[0].expected, null);
  assert.equal(renamed[1].key, 'numsearchloops');
  assert.equal(audit.lineTargets({ file, section, before: 'MaxNumShinies=6', after: 'MaxNumShinies=opaque' }).length, 0);
});

test('comparaison ciblée : absent, invalide masqué, doublons et sections répétées', () => {
  assert.deepEqual(audit.inspect('[Shiny]\nMaxNumShinies=6\nPwd=hidden', entry), { result: 'match', observed: '6' });
  assert.equal(audit.inspect('[Shiny]\nMaxNumShinies=0', entry).result, 'mismatch');
  assert.equal(audit.inspect('[Shiny]\n', entry).result, 'missing');
  assert.deepEqual(audit.inspect('[Shiny]\nMaxNumShinies=private-token', entry),
    { result: 'invalid', observed: null });
  assert.deepEqual(audit.inspect('[Shiny]\nMaxNumShinies=6\nMaxNumShinies=0', entry),
    { result: 'ambiguous', observed: null });
  assert.equal(audit.inspect('[Shiny]\nMaxNumShinies=6\n[Shiny]\nMaxNumShinies=6', entry).result, 'ambiguous');
  assert.equal(audit.inspect('[Shiny]\nMaxNumShinies=6\nMaxNumShinies=6', entry).result, 'match');
  assert.equal(audit.inspect('[Shiny]\n', { ...entry, expected: null }).result, 'match');
});

test('PostgreSQL réel : confirmation, dérive, reprise, erreurs, supersession et périmètre', async () => {
  // Exercise the application's connection in a disposable schema, never its live tables.
  assert.equal(pgStore.initPool(), true, 'PostgreSQL de l’application requis pour ce test');
  const db = pgStore.getPool();
  const client = await db.connect();
  const schema = `ini_audit_test_${process.pid}`;
  const oldPool = pgStore.getPool;
  const old = { readFile: legion.readFile, writeFile: legion.writeFile, getMapState: legion.getMapState };
  const facade = { query: (...args) => client.query(...args),
    connect: async () => ({ query: (...args) => client.query(...args), release() {} }) };
  let content = '[Shiny]\nMaxNumShinies=6\nPwd=private-test-marker\n';
  const reads = [];
  let throwRead = false;
  let throwState = false;
  const due = () => client.query(`UPDATE legion_ini_edits SET next_check=NOW() - INTERVAL '1 second'`);
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    pgStore.getPool = () => facade;
    legion.readFile = async (id, path) => {
      reads.push({ id, path });
      if (throwRead) throw new Error('private-test-marker');
      return content;
    };
    legion.writeFile = async () => { throw new Error('La surveillance ne doit jamais écrire'); };
    legion.getMapState = async () => {
      if (throwState) throw new Error('private-test-marker');
      return 'running';
    };
    const batch = await audit.begin(map, [entry]);
    await audit.confirm(batch, content);
    let data = await audit.list();
    assert.equal(data.current[0].initial_result, 'confirmed');
    assert.equal(data.current[0].check_status, null);
    assert.equal(data.checks.length, 0);
    await due();
    await audit.runDueChecks();
    data = await audit.list();
    assert.equal(data.current[0].last_result, 'match');
    assert.equal(data.current[0].server_state, 'running');
    assert.equal(data.checks.length, 1);
    await due();
    await audit.runDueChecks();
    assert.equal((await audit.list()).checks.length, 1, 'Résultat inchangé non dupliqué');

    content = '[Shiny]\nMaxNumShinies=0\nPwd=private-test-marker\n';
    await audit.onRestart(map);
    data = await audit.list();
    assert.equal(data.current[0].check_reason, 'restart_observed');
    await due();
    // Simulate a new process/module: durable due dates, expectations and confirmations survive.
    delete require.cache[require.resolve('../web/legionIniAudit')];
    audit = require('../web/legionIniAudit');
    await audit.runDueChecks();
    data = await audit.list();
    assert.equal(data.current[0].last_result, 'mismatch');
    assert.equal(data.checks[0].reason, 'restart_observed');
    assert.equal(data.current[0].observed, '0');

    throwRead = true;
    await due();
    await audit.runDueChecks();
    data = await audit.list();
    assert.equal(data.current[0].check_status, 'unavailable');
    assert.equal(data.current[0].last_result, 'mismatch', 'Une panne ne supprime pas la dernière alerte fiable');
    assert.ok(!JSON.stringify(data).includes('private-test-marker'));
    throwRead = false;
    throwState = true;
    content = '[Shiny]\nMaxNumShinies=private-test-marker\n';
    await due();
    await audit.runDueChecks();
    data = await audit.list();
    assert.equal(data.current[0].check_status, 'invalid');
    assert.equal(data.current[0].observed, null);
    assert.equal(data.current[0].server_state, 'unknown');
    assert.ok(!JSON.stringify(data).includes('private-test-marker'));

    content = '[Shiny]\nMaxNumShinies=8\n';
    const next = audit.target(file, section, 'MaxNumShinies=8');
    const newer = await audit.begin(map, [next]);
    await audit.confirm(newer, content);
    await due();
    const readCount = reads.length;
    await audit.runDueChecks();
    data = await audit.list();
    assert.equal(data.current.length, 1);
    assert.equal(data.current[0].expected, '8');
    assert.equal(data.current[0].last_result, 'match');
    assert.equal(data.history.length, 2);
    assert.equal(reads.length, readCount + 1, 'Ancienne attente remplacée, jamais réappliquée');

    const pending = await audit.begin(map, [entry]);
    await client.query(`UPDATE legion_ini_edits SET created_at=NOW() - INTERVAL '10 minutes' WHERE batch_id=$1`, [pending]);
    await due();
    const beforePending = reads.length;
    await audit.runDueChecks();
    data = await audit.list();
    assert.equal(data.current[0].initial_result, 'unconfirmed');
    assert.equal(reads.length, beforePending, 'Reprise : une écriture interrompue n’est pas confirmée a posteriori');
    const ambiguous = await audit.begin(map, [entry]);
    await assert.rejects(audit.confirm(ambiguous, '[Shiny]\nMaxNumShinies=6\nMaxNumShinies=0'), /dès la relecture initiale/);
    assert.equal((await audit.list()).current[0].initial_result, 'unconfirmed');
    await assert.rejects(audit.begin('not-approved', [entry]), /12 serveurs/);
    await assert.rejects(audit.begin(map, [{ ...entry, key: 'Pwd', expected: '1234' }]), /non autorisé/);
    assert.ok(reads.every(r => r.id === map && r.path.endsWith('/GameUserSettings.ini')));

    pgStore.getPool = () => ({ query: async () => { throw new Error('private-test-marker'); } });
    await assert.rejects(audit.begin(map, [entry]), /avant écriture/);
    await assert.rejects(audit.confirm(newer, content), /confirmation historique indisponible/);
  } finally {
    Object.assign(legion, old);
    pgStore.getPool = oldPool;
    await client.query('RESET search_path');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await db.end();
  }
});
