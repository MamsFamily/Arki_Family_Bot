# Bot Discord Arki Roulette

## Vue d'ensemble
Bot Discord avec quatre fonctionnalités principales :
1. **Roulette de la chance** - Roue animée style Nintendo avec choix personnalisables
2. **Système de votes mensuels** - Suivi et récompenses automatiques des votants via TopServeurs API
3. **Traduction et reformulation** - Traduction par réaction (🇫🇷/🇬🇧), commande /traduction, et reformulation style Kaamelott via IA (réaction emoji Arthur)
4. **Système d'inventaire joueurs** - Gestion complète des inventaires (items, monnaies, dinos, équipements) avec historique des transactions

## Dashboard Web
Dashboard d'administration accessible sur le port 5000, avec triple authentification :
- **Mot de passe** (admin ou staff) puis **Discord OAuth2** pour identifier l'utilisateur
- **Admin** (mot de passe admin dans settings.json > auth.adminPassword) : accès complet à tout le dashboard
- **Staff** (mot de passe staff dans settings.json > auth.staffPassword) : accès uniquement au Shop, Prix Dinos et Inventaires joueurs
- **Identification Discord** : après le mot de passe, redirection vers Discord OAuth2 pour identifier qui se connecte ; le nom Discord apparaît dans la sidebar et dans les logs d'inventaire
- **Tableau de bord** : Vue d'ensemble (serveurs, membres, uptime, config roulette)
- **Roulette** : Modifier le titre et les choix depuis le navigateur
- **Classement Votes** : Voir le classement des votes en temps réel depuis TopServeurs
- **Récompenses** : Modifier diamants/vote, bonus top 4-5, lots du top 3 (emojis + quantités)
- **Message publié** : Personnaliser tous les textes du message de résultats (intro, crédits, packs, mémo, dino shiny) avec aperçu en direct
- **Paramètres** : Configurer les IDs de canaux, rôles, emojis, URL API, ping @everyone, et aliases joueurs
- **Inventaires** : Gestion des types d'items, recherche joueur, modification d'inventaire, historique des transactions (admin uniquement)

## Fonctionnalités

### Roulette
- **Commande /roulette**: Lance la roue avec animation GIF fluide (admin et Modo)
- **Commande /set-choices**: Modifie le titre et les choix de la roulette (admin et Modo)
- **Commande /show-choices**: Affiche le titre et les choix actuels
- Animation GIF fluide sans écran noir (60 frames + 9 tours complets)
- Image de roue colorée avec dégradés 3D et les choix affichés

### Votes mensuels
- **Commande /votes**: Affiche le classement des votes du mois dernier (admin et Modo)
- **Commande /publish-votes**: Publie les résultats avec gains, bouton liste complète, et lance la roulette Dino Shiny
- **Commande /pay-votes**: Distribue uniquement les diamants sans publier de message public
- **Commande /test-votes**: Prévisualise les résultats sans rien publier ni distribuer
- Intégration avec l'API TopServeurs pour récupérer les données de votes
- **Distribution automatique des diamants** via l'API UnbelievaBoat (100 💎 par vote)
- **Génération des commandes DraftBot** à copier-coller pour les items du top 3
- **Bouton interactif** pour afficher la liste complète des votants (10+ votes)
- **Roulette Dino Shiny automatique** après publication des résultats
- Récompenses spéciales pour le top 5 (lots pour top 3, diamants bonus pour 4-5)

### Shop
- **Dashboard Shop** : Créer, modifier, supprimer des packs depuis le dashboard web
- **Publication Discord** : Un embed stylé par pack, publié dans un salon choisi
- **Mise à jour** : Modifier un pack et mettre à jour l'embed Discord existant
- **Options** : Toggle donation, indisponibilité, réductions non applicables
- **Aperçu live** : Prévisualisation de l'embed Discord dans le formulaire
- **Publication groupée** : Bouton pour publier/mettre à jour tous les packs d'un coup

### Prix Dinos
- **Dashboard Dinos** : Créer, modifier, supprimer des dinos depuis le dashboard web
- **Classement alphabétique** : Dinos groupés par lettre (A, B, C...)
- **Dinos moddés** : Catégorie séparée avec message d'avertissement, option `isModded` sur chaque dino
- **Variants** : Support des variants (R, A, X) avec prix différents, visibilité par type
- **Options** : Un seul par tribu, réductions non applicables, x2 inventaire, couple inventaire, non dispo dona, dino modé
- **Publication Discord** : Un embed par lettre + catégorie Moddés, publié/mis à jour dans un salon choisi
- **Publication groupée** : Publier toutes les lettres + moddés d'un coup
- **Aperçu live** : Prévisualisation de l'embed Discord dans le formulaire
- **Flash Sale** : Système de soldes avec sélection dino, pourcentage de réduction, calcul automatique des prix, publication embed Discord

### Permissions
- Système de permissions pour les administrateurs et le rôle Modo (ID: 1157803768893689877)

## Structure du projet
```
├── index.js               # Bot principal Discord + démarrage serveur web
├── deploy-commands.js     # Script pour enregistrer les commandes slash
├── rouletteWheel.js       # Génération de l'image de la roue et animation
├── config.json            # Configuration des choix de roulette
├── settings.json          # Configuration centralisée (généré automatiquement)
├── settingsManager.js     # Gestionnaire centralisé des paramètres (lecture/écriture/defaults)
├── shopManager.js         # Gestionnaire du shop (packs, embeds, publication)
├── shop.json              # Données des packs du shop (généré automatiquement)
├── dinoManager.js         # Gestionnaire des dinos (prix, variants, publication par lettre)
├── dinos.json             # Données des dinos (généré automatiquement)
├── inventoryManager.js    # Gestionnaire inventaires joueurs (items, transactions, CRUD)
├── inventory.json         # Données inventaires (généré automatiquement, fallback JSON)
├── votesConfig.js         # Export dynamique getVotesConfig() depuis settingsManager
├── topserveursService.js  # Service API TopServeurs
├── unbelievaboatService.js# Service API UnbelievaBoat (diamants)
├── database.js            # Service de base de données SQLite
├── votesUtils.js          # Utilitaires de normalisation et formatage
├── web/
│   ├── server.js          # Serveur Express (dashboard)
│   ├── views/             # Templates EJS
│   │   ├── sidebar.ejs    # Barre latérale commune
│   │   ├── login.ejs      # Page de connexion
│   │   ├── dashboard.ejs  # Tableau de bord
│   │   ├── roulette.ejs   # Gestion roulette
│   │   ├── votes.ejs      # Classement votes
│   │   ├── rewards.ejs    # Récompenses votes (diamants, lots, bonus)
│   │   ├── message.ejs    # Template du message publié
│   │   ├── shop.ejs       # Gestion du shop (packs, embeds)
│   │   ├── dinos.ejs      # Gestion des prix dinos (par lettre, variants)
│   │   ├── inventory.ejs  # Gestion inventaires (types items, joueurs, historique)
│   │   └── settings.ejs   # Paramètres (canaux, rôles, emojis, aliases)
│   └── public/css/        # Styles CSS
├── pgStore.js             # Module PostgreSQL (connexion, lecture/écriture, fallback JSON)
├── configManager.js       # Gestionnaire async de la config roulette (PostgreSQL/JSON)
├── data/db/meta.sqlite    # Base de données SQLite (votes/historique)
└── package.json           # Dépendances Node.js
```

## Technologies
- Node.js 20
- Discord.js (pour l'API Discord)
- Express + EJS (pour le dashboard web)
- Canvas (pour générer les images de la roue)
- GIF Encoder 2 (pour créer les animations GIF)
- Axios (pour les appels API)
- PostgreSQL via pg (pour la persistance des données sur Railway)
- Better-SQLite3 (pour la base de données locale votes/historique)
- unb-api (pour l'API UnbelievaBoat)
- OpenAI via Replit AI Integrations (pour la reformulation style Kaamelott)
- @vitalets/google-translate-api (pour la traduction gratuite)
- node-cron (pour la publication automatique mensuelle des votes)

## Configuration requise
1. Créer une application Discord sur https://discord.com/developers/applications
2. Créer un bot et copier le token
3. Activer l'intent "Server Members" dans Bot → Privileged Gateway Intents
4. Ajouter les secrets Replit:
   - `DISCORD_TOKEN`: Token du bot Discord
   - `DISCORD_CLIENT_ID`: ID client de l'application Discord
   - `DISCORD_CLIENT_SECRET`: Secret client Discord (pour OAuth2 dashboard)
   - `UNBELIEVABOAT_TOKEN`: Token API UnbelievaBoat
   - `SESSION_SECRET`: Clé de session pour le dashboard
   - `DASHBOARD_PASSWORD`: Mot de passe du dashboard web
5. Ajouter l'URL de callback OAuth2 dans Discord Developer Portal → OAuth2 → Redirects : `https://<votre-domaine>/auth/discord/callback`

## Configuration des votes (votesConfig.js)
- `GUILD_ID`: ID du serveur Discord (1156256997403000874)
- `RESULTS_CHANNEL_ID`: ID du canal où publier les résultats (1157994586774442085)
- `ADMIN_LOG_CHANNEL_ID`: ID du canal admin pour les rapports (1457048610939207769)
- `TOPSERVEURS_RANKING_URL`: URL de l'API TopServeurs
- `DIAMONDS_PER_VOTE`: Diamants par vote (100 par défaut)
- `TOP_LOTS`: Récompenses spéciales pour le top 3 (items DraftBot)
- `TOP_DIAMONDS`: Bonus diamants pour places 4 et 5

## Utilisation
1. Exécuter `deploy-commands.js` pour enregistrer les commandes slash
2. Lancer le bot avec `index.js`
3. Inviter le bot sur votre serveur Discord
4. Utiliser les commandes disponibles
5. Accéder au dashboard via le port 5000

## Changements récents
- 2026-03-26: Giveaway V2 : items inventaire + occasionnels crédités dans l'inventaire, autocomplete gain dans /creer-giveway, @everyone option, images via URL, fix dashboard create (multer.none), messages victoire corrigés
- 2026-03-26: Système Giveaway complet : `giveawayManager.js` (CRUD, tirage, reroll), page dashboard `/giveaways` (créer avec image, voir participants, terminer manuellement, relancer tirage, supprimer), bouton Discord "Je participe" (toggle + mise à jour embed), commandes `/giveway-participants` et `/relancer-giveway`, timers auto (fin + refresh embed toutes les minutes), DM gagnants, distribution auto items inventaire
- 2026-03-19: Shop repensé : champ type (Pack/Unitaire), image/thumbnail par produit, 4 salons configurables (packs, unitaires, accueil index, tickets), message index avec liens directs, commande /shop interactive éphémère (navigation par type, détail produit, bouton Commander → ticket-thread avec panier)
- 2026-03-18: Dashboard simplifié : suppression nombre de serveurs, choix roulette, roulette actuelle, config votes ; ajout top 5 voteurs du mois via TopServeurs API avec barre de progression et médailles
- 2026-03-18: Gestion des catégories shop (CRUD complet depuis le dashboard, persisté PostgreSQL) avec sélecteur de couleur
- 2026-03-18: Bouton toggle mode clair/sombre en haut à droite du dashboard, persisté dans localStorage
- 2026-03-06: Authentification Discord OAuth2 sur le dashboard (mot de passe + identification Discord, nom réel dans les logs inventaire et sidebar)
- 2026-03-06: Système d'inventaire joueurs complet (inventoryManager.js) avec types d'items personnalisables, CRUD joueur, historique des transactions
- 2026-03-06: Commandes Discord /inventaire et /inventaire-admin (ajouter/retirer/reset/historique) avec autocomplete items
- 2026-03-06: Dashboard inventaires (types d'items, recherche joueur, modification inventaire, historique filtrable)
- 2026-03-05: Système de détection de doublons et joueurs non trouvés avec notifications interactives admin (boutons pour résoudre)
- 2026-03-05: Commande /distribution_recompenses pour publier la liste complète des votes avec @here
- 2026-03-04: Publication automatique des résultats votes le 1er de chaque mois à 00h00 (Europe/Paris) via node-cron
- 2026-03-04: Champ note optionnel sur chaque dino (affiché sous le prix dans les embeds Discord)
- 2026-03-04: Police DejaVu Sans Bold embarquée pour la roue (corrige les carrés sur Railway)
- 2026-02-20: Migration PostgreSQL pour persistance sur Railway (pgStore.js, configManager.js, async toutes les opérations d'écriture)
- 2026-02-19: Double authentification dashboard (admin = accès complet, staff = shop/dinos uniquement)
- 2026-02-19: Dinos d'épaule (isShoulder) avec catégorie dédiée dans le menu déroulant Discord
- 2026-02-19: Dinos moddés (catégorie séparée avec avertissement) + Flash Sale (soldes avec calcul prix automatique, publication embed)
- 2026-02-19: Système Prix Dinos avec dashboard CRUD, variants (R/A/X), options (unique tribu, x2 inventaire, couple, non dispo dona), publication par lettre alphabétique
- 2026-02-18: Système Shop avec dashboard CRUD, publication Discord (embeds par pack), aperçu live, donation/dispo/réduction toggles
- 2026-02-17: Dashboard complet avec pages Récompenses, Message publié, Paramètres (tout configurable depuis le web)
- 2026-02-17: Système de configuration centralisé (settingsManager.js + settings.json) avec support env vars
- 2026-02-17: Ajout du dashboard web d'administration (Express + EJS)
- 2026-02-17: Ajout reformulation style Kaamelott via réaction emoji Arthur (IA OpenAI)
- 2026-02-01: Nouveau format de publication avec gains affichés, bouton liste complète, et roulette Dino Shiny automatique
- 2026-02-01: Amélioration du matching de noms (globalName, nickname, fuzzy matching)
- 2026-01-03: Ajout de la commande /pay-votes pour distribution seule
- 2026-01-03: Distribution automatique des diamants via UnbelievaBoat API
- 2026-01-03: Génération automatique des commandes DraftBot à copier-coller
- 2026-01-03: Ajout du système de votes mensuels avec TopServeurs API
- 2025-10-15: Création initiale du bot avec animation de roulette
