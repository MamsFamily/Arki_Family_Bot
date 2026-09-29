const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const pgStore = require('../pgStore');
const draft = require('../starter-pack/draft');

test('pack content validates quantities, text, empty pack and item count', () => {
  assert.deepEqual(draft.validateItems([
    { name: '  Viande cuite  ', quantity: 25, note: '  pour le départ  ' },
  ]), [{ name: 'Viande cuite', quantity: 25, note: 'pour le départ' }]);
  assert.deepEqual(draft.validateItems([]), []);
  assert.throws(() => draft.validateItems([{ name: 'Viande', quantity: 0 }]), /Quantité invalide/);
  assert.throws(() => draft.validateItems([{ name: 'Viande', quantity: 1.5 }]), /Quantité invalide/);
  assert.throws(() => draft.validateItems([null]), /Nom invalide/);
  assert.throws(() => draft.validateItems([{ name: ' ', quantity: 1 }]), /Nom invalide/);
  assert.throws(() => draft.validateItems(Array.from({ length: 51 }, () => ({ name: 'Bola', quantity: 1 }))), /50/);
});

test('draft saves are revision guarded and preserve every entry', async () => {
  const originalGetPool = pgStore.getPool;
  const originalIsPostgres = pgStore.isPostgres;
  let revision = 2;
  let saved = [{ name: 'Bola', quantity: 3, note: '' }];
  pgStore.isPostgres = () => true;
  pgStore.getPool = () => ({
    query: async (sql, params) => {
      if (sql.includes('UPDATE starter_pack_draft')) {
        if (params[1] !== revision) return { rowCount: 0, rows: [] };
        revision++;
        saved = JSON.parse(params[0]);
      }
      return { rowCount: 1, rows: [{ items: saved, revision, updated_at: new Date() }] };
    },
  });
  try {
    const result = await draft.saveDraft([
      { name: 'Gourde remplie', quantity: 1, note: 'eau pleine' },
      { name: 'Griffon niveau 450 en cryo', quantity: 1, note: '' },
    ], 2);
    assert.equal(result.revision, 3);
    assert.equal(result.items.length, 2);
    await assert.rejects(draft.saveDraft([{ name: 'Bola', quantity: 1 }], 2),
      error => error.status === 409);
    assert.equal(saved[0].name, 'Gourde remplie');
  } finally {
    pgStore.getPool = originalGetPool;
    pgStore.isPostgres = originalIsPostgres;
  }
});

test('admin page renders the saved pack and escapes hostile item names', async () => {
  const file = path.resolve(__dirname, '../web/views/starter-pack.ejs');
  const html = await ejs.renderFile(file, {
    role: 'admin', path: '/starter-pack', botUser: null,
    discordUser: { displayName: 'Admin', avatar: '' },
    draft: { revision: 1, updated_at: new Date(), items: [
      { name: '</script><script>alert(1)</script>', quantity: 1, note: '' },
    ] },
    error: null,
  });
  assert.match(html, /href="\/starter-pack"/);
  assert.match(html, /<summary>🧩 <span>Mod Arki<\/span><\/summary>/);
  assert.match(html, /BROUILLON · non distribué/);
  assert.doesNotMatch(html, /<\/script><script>alert\(1\)/);
  assert.match(html, /\\u003c\/script>/);
});

test('Mod Arki stays hidden from staff navigation', async () => {
  const file = path.resolve(__dirname, '../web/views/sidebar.ejs');
  const html = await ejs.renderFile(file, {
    role: 'staff', path: '/shop', botUser: null,
    discordUser: { displayName: 'Staff', avatar: '' },
  });
  assert.doesNotMatch(html, /Mod Arki/);
  assert.doesNotMatch(html, /href="\/starter-pack"/);
});