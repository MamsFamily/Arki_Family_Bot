const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePlayer } = require('../votesUtils');

test('un pseudo exact partagé par deux membres reste en attente', () => {
  const index = {
    'zztestambiguous': ['a', 'b'],
    _membersList: [{ id: 'a', names: ['ZZTestAmbiguous'] }, { id: 'b', names: ['ZZTestAmbiguous'] }],
  };
  assert.equal(resolvePlayer(index, 'ZZTestAmbiguous'), null);
});

test('une correspondance approximative ambiguë ne choisit pas le premier membre', () => {
  const index = { _membersList: [
    { id: 'a', names: ['zzsamplewinner alpha'] },
    { id: 'b', names: ['zzsamplewinner beta'] },
  ] };
  assert.equal(resolvePlayer(index, 'zzsamplewinner'), null);
});

test('une correspondance exacte unique prime sur les correspondances approximatives', () => {
  const index = {
    zzsamplewinner: ['a'],
    _membersList: [{ id: 'a', names: ['zzsamplewinner'] }, { id: 'b', names: ['zzsamplewinner beta'] }],
  };
  assert.equal(resolvePlayer(index, 'zzsamplewinner'), 'a');
});