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
  assert.throws(() => pollManager.parseClassicAnswers('x'.repeat(56) + ' | Non'), /55 caractères/);
  assert.throws(() => pollManager.parseClassicAnswers(
    Array.from({ length: 11 }, (_, index) => `Choix ${index + 1}`).join(' | '),
  ), /2 à 10 réponses/);
});

test('la commande sondage utilise un seul champ et expose les limites natives de Discord', () => {
  const command = commands.find(item => item.name === 'sondage');
  assert.ok(command);
  assert.equal(command.options.find(option => option.name === 'reponses')?.required, true);
  assert.equal(command.options.some(option => /^reponse_\d+$/.test(option.name)), false);
  assert.equal(command.options.some(option => option.name === 'anonyme'), false);
  assert.equal(command.options.find(option => option.name === 'duree')?.choices.some(choice => choice.value === 'unlimited'), false);
  assert.ok(commands.some(item => item.name === 'sondage_autonome'));
});

test('construit le payload natif avec choix, durée et mode multiple', () => {
  assert.deepEqual(pollManager.buildNativePoll({
    question: 'Quelle carte ?',
    answers: ['Valguero', 'Ragnarok'],
    durationHours: 168,
    allowMultiple: true,
  }), {
    question: { text: 'Quelle carte ?' },
    answers: [{ text: 'Valguero' }, { text: 'Ragnarok' }],
    duration: 168,
    allowMultiselect: true,
  });
});

test('refuse un payload natif hors limites Discord', () => {
  assert.throws(() => pollManager.buildNativePoll({
    question: 'Choix ?', answers: ['A', 'B'], durationHours: 769,
  }), /32 jours/);
  assert.throws(() => pollManager.buildNativePoll({
    question: 'Choix ?', answers: ['x'.repeat(56), 'B'],
  }), /55 caractères/);
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
