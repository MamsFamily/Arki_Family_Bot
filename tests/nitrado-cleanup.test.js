'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const serverSource = read('web/server.js');
const removedFiles = [
  'web/nitradoManager.js',
  'web/views/nitrado.ejs',
  'web/views/restart-history.ejs',
  'nitradoService.js',
  'restartLogger.js',
];

test('les modules et vues Nitrado inutilisés ont été retirés sans retirer Legion', () => {
  for (const file of removedFiles) assert.equal(fs.existsSync(path.join(root, file)), false, file);
  assert.equal(fs.existsSync(path.join(root, 'nitradoRestartScheduler.js')), true);
  assert.match(read('index.js'), /require\('\.\/nitradoRestartScheduler'\)/);
  assert.match(serverSource, /app\.get\('\/legion', requireAdmin/);
  assert.match(serverSource, /app\.post\('\/legion\/api\/schedules', requireAdmin/);
  assert.doesNotMatch(serverSource, /if\s*\(false\)|app\.(?:get|post|patch|delete)\('\/nitrado/);
  assert.doesNotMatch(read('web/public/css/style.css'), /\.nitrado-/);
});

test('aucun import actif ne dépend des modules supprimés ou des clients FTP/RCON', () => {
  const removedImport = /require\s*\(\s*['"][^'"]*(?:nitradoManager|nitradoService|restartLogger|basic-ftp|rcon-client)(?:\.js)?['"]\s*\)/;
  const removedRender = /(?:res\.render|include)\s*\(\s*['"](?:nitrado|restart-history)['"]/;
  function check(dir) {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) check(file);
      else if (/\.(?:js|ejs)$/.test(entry.name)) {
        assert.doesNotMatch(read(file), removedImport, file);
        assert.doesNotMatch(read(file), removedRender, file);
      }
    }
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) {
      assert.doesNotMatch(read(entry.name), removedImport, entry.name);
    }
  }
  for (const dir of ['web', 'casino', 'starter-pack', 'scripts']) check(dir);
});

test('seules les dépendances exclusives Nitrado sont absentes du manifeste et du lockfile', () => {
  const manifest = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  for (const dependency of ['basic-ftp', 'rcon-client']) {
    assert.equal(manifest.dependencies[dependency], undefined);
    assert.equal(lock.packages[''].dependencies[dependency], undefined);
    assert.equal(lock.packages[`node_modules/${dependency}`], undefined);
  }
  for (const dependency of ['axios', 'node-cron', 'pg']) {
    assert.ok(manifest.dependencies[dependency]);
    assert.ok(lock.packages[`node_modules/${dependency}`]);
  }
  // form-data reste une dépendance transitive d'Axios.
  assert.ok(lock.packages['node_modules/axios'].dependencies['form-data']);
});

test('les anciens liens redirigent et toutes les anciennes opérations restent bloquées', () => {
  // Exécute le vrai middleware sans démarrer le bot ni accéder à PostgreSQL.
  const guard = serverSource.match(/app\.use\('\/nitrado', \(req, res\) => \{[\s\S]*?\n  \}\);/);
  assert.ok(guard, 'Le garde de compatibilité Nitrado doit rester présent');
  let handler;
  vm.runInNewContext(guard[0], {
    app: { use(prefix, callback) { assert.equal(prefix, '/nitrado'); handler = callback; } },
  });
  for (const [method, requestPath, expectedStatus] of [
    ['GET', '/', 302],
    ['POST', '/', 410],
    ['GET', '/api/servers', 410],
    ['GET', '/restart-history', 410],
    ['POST', '/api/restart-all', 410],
    ['POST', '/api/ini/apply-with-restart', 410],
    ['PATCH', '/api/scheduled/ancien/toggle', 410],
    ['DELETE', '/api/restart-schedules', 410],
  ]) {
    let status;
    const response = {
      redirect(target) { assert.equal(target, '/legion'); status = 302; },
      status(code) { status = code; return this; },
      json(body) { assert.equal(body.ok, false); assert.match(body.error, /Nitrado retiré/); },
    };
    handler({ method, path: requestPath }, response);
    assert.equal(status, expectedStatus, `${method} ${requestPath}`);
  }
});

test('le nettoyage ne remet pas en service et ne réécrit pas les anciennes données', () => {
  assert.doesNotMatch(serverSource, /nitrado_(?:restart_logs|restart_schedules|scheduled_cmds|rcon_direct|last_ini_apply)|nitradoFtp/);
  const schedulerSource = read('nitradoRestartScheduler.js');
  assert.match(schedulerSource, /const STORE_KEY = 'legion_restart_schedules'/);
  assert.doesNotMatch(schedulerSource, /['"]nitrado_[^'"]+['"]/);
});
