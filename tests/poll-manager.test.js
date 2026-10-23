const test = require('node:test');
const assert = require('node:assert/strict');
const pollManager = require('../pollManager');
const commands = require('../commands');

test('parse les réponses du sondage classique séparées par des barres verticales', () => {
  assert.deepEqual(pollManager.parseClassicAnswers(' Valguero | Ragnarok | The Island '), [
    'Valguero', 'Ragnarok', 'The Island',
  ]);
});

test('refuse une liste de réponses incomplète, trop longue ou avec doublons', () => {
  assert.throws(() => pollManager.parseClassicAnswers('Valguero'), /2 à 10 réponses/);
  assert.throws(() => pollManager.parseClassicAnswers('Oui || Non'), /2 à 10 réponses/);
  assert.throws(() => pollManager.parseClassicAnswers('Oui | oui'), /toutes être différentes/);
  assert.throws(() => pollManager.parseClassicAnswers('x'.repeat(81) + ' | Non'), /80 caractères/);
  assert.throws(() => pollManager.parseClassicAnswers(
    Array.from({ length: 11 }, (_, index) => `Choix ${index + 1}`).join(' | '),
  ), /2 à 10 réponses/);
});

test('la commande sondage utilise un seul champ pour saisir les choix', () => {
  const command = commands.find(item => item.name === 'sondage');
  assert.ok(command);
  assert.equal(command.options.find(option => option.name === 'reponses')?.required, true);
  assert.equal(command.options.some(option => /^reponse_\\d+$/.test(option.name)), false);
  assert.ok(commands.some(item => item.name === 'sondage_autonome'));
});

test('les résultats classiques séparent les choix et indiquent compteurs, pourcentages et votants', () => {
  const embed = pollManager.buildClassicEmbed({
    question: 'Quelle carte ?',
    options: [
      { text: 'Valguero', voters: [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }] },
      { text: 'Ragnarok', voters: [{ id: '3', name: 'Charlie' }, { id: '4', name: 'Dana' }] },
    ],
    allowMultiple: false,
    anonymous: false,
    closed: false,
  }).toJSON();

  assert.equal(embed.fields.length, 2);
  assert.match(embed.description, /4 votes au total/);
  assert.match(embed.description, /part des votes exprimés/);
  assert.match(embed.fields[0].name, /Valguero/);
  assert.match(embed.fields[0].value, /50%/);
  assert.match(embed.fields[0].value, /Alice, Bob/);
});

test('les votes anonymes masquent les noms et les sondages clos signalent les ex æquo', () => {
  const embed = pollManager.buildClassicEmbed({
    question: 'Quel choix ?',
    options: [
      { text: 'Premier', voters: [{ id: '1', name: 'Nom privé' }] },
      { text: 'Second', voters: [{ id: '2', name: 'Autre nom privé' }] },
    ],
    allowMultiple: false,
    anonymous: true,
    closed: true,
  }).toJSON();

  assert.doesNotMatch(JSON.stringify(embed), /Nom privé|Autre nom privé/);
  assert.match(embed.fields[0].name, /🏆/);
  assert.match(embed.fields[1].name, /🏆/);
});

test('les réponses du sondage autonome sont affichées séparément avec leur auteur', () => {
  const embed = pollManager.buildEmbed({
    question: 'Quelle idée ?',
    options: [
      { text: 'Construire une arène', addedBy: 'Alice' },
      { text: 'Organiser un événement', addedBy: 'Bob' },
    ],
    closed: false,
  }).toJSON();

  assert.equal(embed.fields.length, 2);
  assert.match(embed.fields[0].name, /Construire une arène/);
  assert.match(embed.fields[0].value, /Alice/);
  assert.match(embed.fields[1].name, /Organiser un événement/);
  assert.match(embed.fields[1].value, /Bob/);
});
