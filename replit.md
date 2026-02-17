# Bot Discord Arki Roulette

## Vue d'ensemble
Bot Discord avec trois fonctionnalités principales :
1. **Roulette de la chance** - Roue animée style Nintendo avec choix personnalisables
2. **Système de votes mensuels** - Suivi et récompenses automatiques des votants via TopServeurs API
3. **Traduction et reformulation** - Traduction par réaction (🇫🇷/🇬🇧), commande /traduction, et reformulation style Kaamelott via IA (réaction emoji Arthur)

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

### Permissions
- Système de permissions pour les administrateurs et le rôle Modo (ID: 1157803768893689877)

## Structure du projet
```
├── index.js               # Bot principal Discord
├── deploy-commands.js     # Script pour enregistrer les commandes slash
├── rouletteWheel.js       # Génération de l'image de la roue et animation
├── config.json            # Configuration des choix de roulette
├── votesConfig.js         # Configuration du système de votes
├── topserveursService.js  # Service API TopServeurs
├── unbelievaboatService.js# Service API UnbelievaBoat (diamants)
├── database.js            # Service de base de données SQLite
├── votesUtils.js          # Utilitaires de normalisation et formatage
├── data/db/meta.sqlite    # Base de données SQLite
├── package.json           # Dépendances Node.js
└── .env.example           # Exemple de variables d'environnement
```

## Technologies
- Node.js 20
- Discord.js (pour l'API Discord)
- Canvas (pour générer les images de la roue)
- GIF Encoder 2 (pour créer les animations GIF)
- Axios (pour les appels API)
- Better-SQLite3 (pour la base de données locale)
- unb-api (pour l'API UnbelievaBoat)
- OpenAI via Replit AI Integrations (pour la reformulation style Kaamelott)
- @vitalets/google-translate-api (pour la traduction gratuite)

## Configuration requise
1. Créer une application Discord sur https://discord.com/developers/applications
2. Créer un bot et copier le token
3. Activer l'intent "Server Members" dans Bot → Privileged Gateway Intents
4. Ajouter les secrets Replit:
   - `DISCORD_TOKEN`: Token du bot Discord
   - `DISCORD_CLIENT_ID`: ID client de l'application Discord
   - `UNBELIEVABOAT_TOKEN`: Token API UnbelievaBoat

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

## Changements récents
- 2026-02-17: Ajout reformulation style Kaamelott via réaction emoji Arthur (IA OpenAI)
- 2026-02-01: Nouveau format de publication avec gains affichés, bouton liste complète, et roulette Dino Shiny automatique
- 2026-02-01: Amélioration du matching de noms (globalName, nickname, fuzzy matching)
- 2026-01-03: Ajout de la commande /pay-votes pour distribution seule
- 2026-01-03: Distribution automatique des diamants via UnbelievaBoat API
- 2026-01-03: Génération automatique des commandes DraftBot à copier-coller
- 2026-01-03: Ajout du système de votes mensuels avec TopServeurs API
- 2025-10-15: Création initiale du bot avec animation de roulette
