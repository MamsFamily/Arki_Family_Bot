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
    name: 'vote-rapport',
    description: 'Publie le rapport de distribution : qui a été payé, qui ne l\'a pas été (Admin et Modo)',
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
    name: 'classement',
    description: '🏆 Affiche le classement des diamants du serveur',
  },
  {
    name: 'compte',
    description: 'Affiche le contenu de ton porte-monnaie (diamants et fraises)',
    options: [
      { name: 'membre', type: 6, description: 'Voir le compte d\'un autre joueur (optionnel)', required: false },
    ],
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
  {
    name: 'inventaire-ajouter',
    description: 'Ajouter des items à un joueur (Admin et Modo)',
    options: [
      { name: 'joueur', type: 6, description: 'Le joueur', required: true },
      { name: 'item', type: 3, description: "L'item à ajouter (liste) ou ➕ Ajouter item occasionnel", required: true, autocomplete: true },
      { name: 'quantité', type: 4, description: 'La quantité à ajouter', required: true, min_value: 1 },
      { name: 'raison', type: 3, description: "Raison de l'ajout", required: false },
    ],
  },
  {
    name: 'inventaire-retirer',
    description: 'Retirer des items à un joueur (Admin et Modo)',
    options: [
      { name: 'joueur', type: 6, description: 'Le joueur', required: true },
      { name: 'item', type: 3, description: "L'item à retirer", required: true, autocomplete: true },
      { name: 'quantité', type: 4, description: 'La quantité à retirer', required: true, min_value: 1 },
      { name: 'raison', type: 3, description: 'Raison du retrait', required: false },
    ],
  },
  {
    name: 'ticket-shop',
    description: 'Ouvre un ticket shop interactif pour passer une commande (dinos, packs...)',
  },
  {
    name: 'ticket-shop-panel',
    description: 'Publie l\'embed shop avec le bouton d\'ouverture de ticket dans le salon courant (Admin)',
  },
  {
    name: 'spawn-panel',
    description: 'Publie le panneau d\'admission Spawn Joueur dans le salon courant (Admin)',
  },
  {
    name: 'event-panel',
    description: 'Publie un panneau de ticket événement temporaire dans le salon courant (Admin)',
    options: [
      {
        name: 'nom',
        type: 3,
        description: 'Nom de l\'événement (affiché dans le panel et les tickets)',
        required: true,
      },
    ],
  },
  {
    name: 'creer-giveway',
    description: 'Crée et publie un giveaway dans le salon courant (Admin et Modo)',
    options: [
      { name: 'ping_everyone', type: 5, description: 'Mentionner @everyone pour annoncer le giveaway', required: false },
    ],
  },
  {
    name: 'giveway-participants',
    description: 'Affiche les participants du giveaway en cours (ou du dernier terminé)',
    options: [
      { name: 'id', type: 3, description: 'ID du giveaway (optionnel — auto-détecté si absent)', required: false },
    ],
  },
  {
    name: 'giveway-retirer',
    description: 'Retire un participant du giveaway en cours (Admin et Modo)',
    options: [
      { name: 'utilisateur', type: 6, description: 'Membre à retirer du giveaway', required: true },
      { name: 'id', type: 3, description: 'ID du giveaway (optionnel — auto-détecté si absent)', required: false },
    ],
  },
  {
    name: 'relancer-giveway',
    description: 'Relance le tirage au sort d\'un giveaway terminé (Admin et Modo)',
    options: [
      { name: 'id', type: 3, description: 'ID du giveaway', required: true },
    ],
  },
  {
    name: 'inventaire-distribuer-item',
    description: 'Distribue un item à plusieurs joueurs en même temps (Admin et Modo)',
    options: [
      { name: 'joueurs', type: 3, description: 'Mentionnez les joueurs : @joueur1 @joueur2 ...', required: true },
      { name: 'item', type: 3, description: "L'item à distribuer ou ➕ Item occasionnel", required: true, autocomplete: true },
      { name: 'quantité', type: 4, description: 'Quantité par joueur', required: true, min_value: 1 },
      { name: 'nom', type: 3, description: "Nom de l'item (uniquement pour ➕ Item occasionnel)", required: false },
      { name: 'raison', type: 3, description: 'Raison de la distribution', required: false },
    ],
  },
  {
    name: 'migrer-ub',
    description: '🔒 Admin — Importe les soldes UnbelievaBoat (cash + banque) → Diamants Arki',
    default_member_permissions: '8',
  },
  {
    name: 'niveau',
    description: '⭐ Affiche ton niveau XP et ta progression',
    options: [
      { name: 'membre', type: 6, description: 'Voir le niveau d\'un autre joueur (optionnel)', required: false },
    ],
  },
  {
    name: 'classement-xp',
    description: '🏅 Classement des joueurs par niveau XP',
  },
  {
    name: 'xp-donner',
    description: '🔒 Admin — Donne de l\'XP à un joueur',
    default_member_permissions: '8',
    options: [
      { name: 'joueur', type: 6, description: 'Joueur ciblé', required: true },
      { name: 'montant', type: 4, description: 'Quantité d\'XP à donner', required: true, min_value: 1 },
    ],
  },
  {
    name: 'xp-retirer',
    description: '🔒 Admin — Retire de l\'XP à un joueur',
    default_member_permissions: '8',
    options: [
      { name: 'joueur', type: 6, description: 'Joueur ciblé', required: true },
      { name: 'montant', type: 4, description: 'Quantité d\'XP à retirer', required: true, min_value: 1 },
    ],
  },
  {
    name: 'xp-forcer-niveau',
    description: '🔒 Admin — Force le niveau d\'un joueur SANS distribuer les récompenses (migration)',
    default_member_permissions: '8',
    options: [
      { name: 'joueur', type: 6, description: 'Joueur ciblé', required: true },
      { name: 'niveau', type: 4, description: 'Niveau cible (0 = réinitialiser)', required: true, min_value: 0 },
    ],
  },
  {
    name: 'travail',
    description: '💼 Travaille pour gagner entre 50 et 250 💎 (utilisable toutes les 4h)',
  },
  {
    name: 'revenus',
    description: '💰 Récupère tes revenus hebdomadaires selon tes rôles',
  },
  {
    name: 'envoyer',
    description: '🤝 Envoie des diamants à un autre joueur',
    options: [
      { name: 'joueur',  type: 6, description: 'Le joueur qui reçoit les diamants', required: true },
      { name: 'montant', type: 4, description: 'Nombre de diamants à envoyer', required: true, min_value: 1 },
      { name: 'raison',  type: 3, description: 'Raison du transfert (vente, don, service…)', required: true },
    ],
  },
  {
    name: 'amende',
    description: '🔒 Admin — Inflige une amende en diamants à un joueur',
    default_member_permissions: '8',
    options: [
      { name: 'joueur', type: 6, description: 'Le joueur pénalisé', required: true },
      { name: 'montant', type: 4, description: 'Montant de l\'amende en diamants', required: true, min_value: 1 },
      { name: 'raison', type: 3, description: 'Motif de l\'amende', required: true },
      { name: 'photo', type: 11, description: 'Fichier justificatif (image, vidéo…)', required: false },
    ],
  },
  {
    name: 'revenus-debloquer',
    description: '🔒 Admin — Réinitialise le cooldown /revenus d\'un joueur (rôles nouveaux non détectés)',
    default_member_permissions: '8',
    options: [
      { name: 'joueur', type: 6, description: 'Le joueur à débloquer', required: true },
    ],
  },
  {
    name: 'aide',
    description: '📖 Liste toutes les commandes disponibles, par catégorie',
  },
  {
    name: 'aide-admin',
    description: '🔒 Admin — Liste toutes les commandes d\'administration, par catégorie',
    default_member_permissions: '8',
  },
  {
    name: 'restart-programmer',
    description: '🔄 Gérer les redémarrages automatiques des serveurs ARK SA (Admin)',
    default_member_permissions: '8',
    options: [
      {
        type: 1,
        name: 'voir',
        description: '📋 Lister tous les plannings de redémarrage',
      },
      {
        type: 1,
        name: 'créer',
        description: '➕ Programmer un redémarrage automatique quotidien',
        options: [
          { name: 'heure',          type: 3, description: 'Heure du redémarrage (format HH:MM, ex: 04:00)',                    required: true  },
          { name: 'nom',            type: 3, description: 'Nom du planning (ex: Redémarrage nocturne)',                        required: true  },
          { name: 'avertissements', type: 5, description: 'Envoyer des alertes in-game 30/15/5/1 min avant (défaut: oui)',     required: false },
        ],
      },
      {
        type: 1,
        name: 'supprimer',
        description: '🗑️ Supprimer un planning de redémarrage',
        options: [
          { name: 'id', type: 3, description: 'ID du planning (visible avec /restart-programmer voir)', required: true },
        ],
      },
      {
        type: 1,
        name: 'toggle',
        description: '⏸ Activer ou désactiver un planning',
        options: [
          { name: 'id', type: 3, description: 'ID du planning (visible avec /restart-programmer voir)', required: true },
        ],
      },
      {
        type: 1,
        name: 'lancer',
        description: '▶️ Lancer immédiatement le redémarrage d\'un planning (SaveWorld puis restart)',
        options: [
          { name: 'id', type: 3, description: 'ID du planning (visible avec /restart-programmer voir)', required: true },
        ],
      },
    ],
  },
  {
    name: 'casino',
    description: '🎰 Ouvre le menu du casino (Slots, Blackjack, Roulette, Roulette Russe, Poker)',
  },
  {
    name: 'giveaway-forcer-resultat',
    description: '🔧 Force l\'annonce d\'un résultat de giveaway manuellement (Admin uniquement)',
    options: [
      { name: 'titre',    type: 3, description: 'Titre du giveaway',                                         required: true  },
      { name: 'gain',     type: 3, description: 'Gain (ex: Fraises ×5000)',                                  required: true  },
      { name: 'gagnant',  type: 6, description: 'Le membre gagnant',                                         required: true  },
      { name: 'salon',    type: 7, description: 'Salon où envoyer l\'annonce',                                required: true  },
      { name: 'participants', type: 4, description: 'Nombre de participants (affiché uniquement)',            required: false },
    ],
  },
  {
    name: 'giveaway-republier',
    description: '📢 Ré-annonce les résultats du dernier giveaway terminé (Admin et Modo)',
    options: [
      {
        name: 'id',
        type: 3,
        description: 'ID du giveaway (laisser vide = dernier giveaway terminé avec gagnants)',
        required: false,
      },
    ],
  },
  {
    name: 'recap',
    description: 'Publie le récapitulatif de la commande dans le ticket (Admin uniquement)',
  },
  {
    name: 'casino-debloquer',
    description: '🎰 Retire un joueur de toutes les parties casino en cours (Admin et Modo)',
    options: [
      {
        name: 'membre',
        type: 6,
        description: 'Le joueur à débloquer',
        required: true,
      },
    ],
  },
  {
    name: 'activer-booster',
    description: '🧬 Active un booster de reproduction sur une map (si tu en possèdes un)',
  },
];

module.exports = commands;
