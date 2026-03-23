const commands = [
  {
    name: 'roulette',
    description: 'Lance la roue de la chance Arki (Admin et Modo)',
  },
  {
    name: 'set-choices',
    description: 'Modifie le titre et les choix de la roulette (Admin et Modo)',
    options: [
      { name: 'title', type: 3, description: 'Le titre au centre (max 20 caractères)', required: true },
      { name: 'choices', type: 3, description: 'Les choix séparés par des virgules (ex: Choix1,Choix2,Choix3)', required: true },
    ],
  },
  {
    name: 'show-choices',
    description: 'Affiche les choix actuels de la roulette',
  },
  {
    name: 'votes',
    description: 'Affiche le classement des votes du mois dernier (Admin et Modo)',
  },
  {
    name: 'publish-votes',
    description: 'Publie les résultats des votes mensuels (Admin et Modo)',
  },
  {
    name: 'test-votes',
    description: 'Prévisualise les résultats sans rien publier ni distribuer (Admin et Modo)',
  },
  {
    name: 'pay-votes',
    description: 'Distribue uniquement les diamants sans publier de message (Admin et Modo)',
  },
  {
    name: 'distribution_recompenses',
    description: 'Publie la liste complète des votes avec récompenses distribuées (Admin et Modo)',
  },
  {
    name: 'dino-roulette',
    description: 'Lance la roulette Dino Shiny avec le top 10 des votants (Admin et Modo)',
  },
  {
    name: 'traduction',
    description: 'Traduit un message en français',
    options: [
      { name: 'message', type: 3, description: "Le lien ou l'identifiant du message à traduire", required: true },
    ],
  },
  {
    name: 'inventaire',
    description: "Affiche l'inventaire d'un joueur",
    options: [
      { name: 'joueur', type: 6, description: 'Le joueur dont vous voulez voir l\'inventaire (par défaut: vous-même)', required: false },
    ],
  },
  {
    name: 'inventaire-historique',
    description: "Affiche ton historique de transactions (visible uniquement par toi)",
    options: [],
  },
  {
    name: 'shop',
    description: 'Parcourir et commander dans le shop Arki (éphémère)',
  },
  {
    name: 'attribuer-pack',
    description: 'Attribue les items d\'un pack spécial à un joueur (Admin et Modo)',
    options: [
      { name: 'joueur', type: 6, description: 'Le joueur qui reçoit le pack', required: true },
      { name: 'pack', type: 3, description: 'Le pack à attribuer', required: true, autocomplete: true },
    ],
  },
  {
    name: 'inventaire-admin',
    description: 'Gestion des inventaires (Admin et Modo)',
    options: [
      {
        name: 'ajouter',
        type: 1,
        description: 'Ajouter des items à un joueur',
        options: [
          { name: 'joueur', type: 6, description: 'Le joueur', required: true },
          { name: 'item', type: 3, description: "L'item à ajouter", required: true, autocomplete: true },
          { name: 'quantité', type: 4, description: 'La quantité à ajouter', required: true, min_value: 1 },
          { name: 'raison', type: 3, description: "Raison de l'ajout", required: false },
        ],
      },
      {
        name: 'retirer',
        type: 1,
        description: 'Retirer des items à un joueur',
        options: [
          { name: 'joueur', type: 6, description: 'Le joueur', required: true },
          { name: 'item', type: 3, description: "L'item à retirer", required: true, autocomplete: true },
          { name: 'quantité', type: 4, description: 'La quantité à retirer', required: true, min_value: 1 },
          { name: 'raison', type: 3, description: 'Raison du retrait', required: false },
        ],
      },
      {
        name: 'reset',
        type: 1,
        description: "Réinitialiser l'inventaire d'un joueur",
        options: [
          { name: 'joueur', type: 6, description: "Le joueur dont l'inventaire sera réinitialisé", required: true },
        ],
      },
      {
        name: 'historique',
        type: 1,
        description: "Voir l'historique des transactions d'un joueur",
        options: [
          { name: 'joueur', type: 6, description: "Le joueur dont vous voulez voir l'historique", required: true },
        ],
      },
    ],
  },
];

module.exports = commands;
