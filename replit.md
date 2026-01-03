# Bot Discord Arki Roulette

## Vue d'ensemble
Bot Discord avec deux fonctionnalités principales :
1. **Roulette de la chance** - Roue animée style Nintendo avec choix personnalisables
2. **Système de votes mensuels** - Suivi et récompenses des votants via TopServeurs API

## Fonctionnalités

### Roulette
- **Commande /roulette**: Lance la roue avec animation GIF fluide (admin et Modo)
- **Commande /set-choices**: Modifie le titre et les choix de la roulette (admin et Modo)
- **Commande /show-choices**: Affiche le titre et les choix actuels
- Animation GIF fluide sans écran noir (60 frames + 9 tours complets)
- Image de roue colorée avec dégradés 3D et les choix affichés

### Votes mensuels
- **Commande /votes**: Affiche le classement des votes du mois dernier (admin et Modo)
- **Commande /publish-votes**: Publie les résultats formatés avec récompenses (admin et Modo)
- Intégration avec l'API TopServeurs pour récupérer les données de votes
- Calcul automatique des diamants (100 par vote)
- Récompenses spéciales pour le top 5 (lots pour top 3, diamants bonus pour 4-5)

### Permissions
- Système de permissions pour les administrateurs et le rôle Modo (ID: 1157803768893689877)

## Structure du projet
```
├── index.js              # Bot principal Discord
├── deploy-commands.js    # Script pour enregistrer les commandes slash
├── rouletteWheel.js      # Génération de l'image de la roue et animation
├── config.json           # Configuration des choix de roulette
├── votesConfig.js        # Configuration du système de votes
├── topserveursService.js # Service API TopServeurs
├── database.js           # Service de base de données SQLite
├── votesUtils.js         # Utilitaires de normalisation et formatage
├── data/db/meta.sqlite   # Base de données SQLite
├── package.json          # Dépendances Node.js
└── .env.example          # Exemple de variables d'environnement
```

## Technologies
- Node.js 20
- Discord.js (pour l'API Discord)
- Canvas (pour générer les images de la roue)
- GIF Encoder 2 (pour créer les animations GIF)
- Axios (pour les appels API)
- Better-SQLite3 (pour la base de données locale)

## Configuration requise
1. Créer une application Discord sur https://discord.com/developers/applications
2. Créer un bot et copier le token
3. Ajouter les secrets Replit:
   - `DISCORD_TOKEN`: Token du bot Discord
   - `DISCORD_CLIENT_ID`: ID client de l'application Discord

## Configuration des votes (votesConfig.js)
- `RESULTS_CHANNEL_ID`: ID du canal où publier les résultats
- `TOPSERVEURS_RANKING_URL`: URL de l'API TopServeurs
- `DIAMONDS_PER_VOTE`: Diamants par vote (100 par défaut)
- `TOP_LOTS`: Récompenses spéciales pour le top 3
- `TOP_DIAMONDS`: Bonus diamants pour places 4 et 5

## Utilisation
1. Exécuter `deploy-commands.js` pour enregistrer les commandes slash
2. Lancer le bot avec `index.js`
3. Inviter le bot sur votre serveur Discord
4. Utiliser les commandes disponibles

## Changements récents
- 2026-01-03: Ajout du système de votes mensuels avec TopServeurs API
- 2026-01-03: Nouvelles commandes /votes et /publish-votes
- 2025-10-15: Création initiale du bot avec animation de roulette
- 2025-10-15: Amélioration majeure du visuel de la roulette avec dégradés, effets 3D, et animations plus fluides
- 2025-10-15: Conversion en animation GIF pour éliminer les écrans noirs
- 2025-10-15: Ajout de la commande /set-choices avec titre et choix
- 2025-10-15: Augmentation à 9 tours complets pour une animation plus longue
- 2025-10-15: Ajout du rôle "Modo" aux permissions
