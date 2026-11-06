const test = require('node:test');
const assert = require('node:assert/strict');
const inventory = require('../inventoryManager');
const { showVoteRollbackPreview, handleVoteRollbackConfirmation } = require('../voteRollbackCommand');
const commands = require('../commands');
const id = '11111111-1111-4111-8111-111111111111';

function interaction(options = {}) {
  const calls = [];
  return {
    calls, user: { id: 'admin' }, guildId: 'guild',
    customId: `vote_rollback_confirm::${id}`,
    options: { getString: name => options[name] || null },
    deferReply: async data => { calls.push(['deferReply', data]); },
    deferUpdate: async () => { calls.push(['deferUpdate']); },
    editReply: async data => { calls.push(['editReply', data]); return data; },
  };
}

test('command publishes optional month and explicit legacy boundary, with Discord-valid descriptions', () => {
  const list = Array.isArray(commands) ? commands : commands.commands;
  const command = list.find(c => c.name === 'annuler-votes-mois');
  assert.ok(command);
  assert.ok(command.description.length <= 100);
  assert.deepEqual(command.options.map(o => o.name), ['mois', 'depuis']);
  for (const option of command.options) assert.ok(option.description.length <= 100);
});

test('preview is private, forwards exact filters and never confirms a debit', async t => {
  const prepare = inventory.prepareVoteRollback;
  const confirm = inventory.confirmVoteRollback;
  t.after(() => { inventory.prepareVoteRollback = prepare; inventory.confirmVoteRollback = confirm; });
  let input;
  inventory.prepareVoteRollback = async value => {
    input = value;
    return {
      id, legacy: true, since: value.since, startedAt: '2026-11-06T09:00:00Z',
      endedAt: '2026-11-06T09:01:00Z',
      transactions: [{ id: 'a' }], summary: { player: { diamants: 100, fraises: 5 } },
    };
  };
  inventory.confirmVoteRollback = async () => { throw new Error('must not debit'); };
  const i = interaction({ mois: 'octobre', depuis: '2026-11-06T10:00:00+01:00' });
  const reply = await showVoteRollbackPreview(i);
  assert.equal(i.calls[0][1].ephemeral, true);
  assert.deepEqual(input, { actorId: 'admin', guildId: 'guild', month: 'octobre', since: '2026-11-06T10:00:00+01:00' });
  const embed = reply.embeds[0].toJSON();
  assert.match(embed.description, /Ancien versement/);
  assert.match(embed.description, /100 × diamants/);
  assert.equal(reply.components[0].toJSON().components[0].custom_id, `vote_rollback_confirm::${id}`);
});

test('old broad confirmation buttons are refused without reaching inventory mutation', async t => {
  const confirm = inventory.confirmVoteRollback;
  t.after(() => { inventory.confirmVoteRollback = confirm; });
  inventory.confirmVoteRollback = async () => { throw new Error('must not debit'); };
  for (const payload of ['DATE:2026-11-01T00:00:00Z', 'NAME:OCTOBRE']) {
    const i = interaction();
    i.customId = `vote_rollback_confirm::${payload}`;
    const reply = await handleVoteRollbackConfirmation(i);
    assert.match(reply.content, /ancien aperçu/);
    assert.deepEqual(reply.components, []);
  }
});

test('confirmation uses the frozen plan and handles duplicate clicks and failures explicitly', async t => {
  const confirm = inventory.confirmVoteRollback;
  t.after(() => { inventory.confirmVoteRollback = confirm; });
  let input;
  inventory.confirmVoteRollback = async value => {
    input = value;
    return { count: 3, players: 2, alreadyApplied: false };
  };
  assert.match((await handleVoteRollbackConfirmation(interaction())).content, /3 transaction/);
  assert.deepEqual(input, { actorId: 'admin', guildId: 'guild', planId: id });
  inventory.confirmVoteRollback = async () => ({ alreadyApplied: true });
  assert.match((await handleVoteRollbackConfirmation(interaction())).content, /Aucun retrait supplémentaire/);
  inventory.confirmVoteRollback = async () => { throw new Error('Solde insuffisant'); };
  assert.match((await handleVoteRollbackConfirmation(interaction())).content, /Solde insuffisant/);
});
