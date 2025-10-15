# Bot Discord Arki Roulette

## Vue d'ensemble
Bot Discord qui simule une roue de la chance animée. Les administrateurs peuvent lancer la roulette et un choix aléatoire est sélectionné avec une animation visuelle.

## Fonctionnalités
- **Commande /roulette**: Lance la roue avec animation GIF fluide (admin uniquement)
- **Commande /set-choices**: Modifie les choix et optionnellement le titre en une seule commande (admin uniquement)
- **Commande /set-title**: Personnalise uniquement le titre au centre de la roulette (admin uniquement)
- **Commande /show-choices**: Affiche les choix actuels et le titre
- Animation GIF fluide sans écran noir (60 frames + 6 tours complets)
- Image de roue colorée avec dégradés 3D et les choix affichés
- Système de permissions pour limiter aux administrateurs

## Structure du projet
```
├── index.js              # Bot principal Discord
├── deploy-commands.js    # Script pour enregistrer les commandes slash
├── rouletteWheel.js      # Génération de l'image de la roue et animation
├── config.json           # Configuration des choix de roulette
├── package.json          # Dépendances Node.js
└── .env.example          # Exemple de variables d'environnement
```

## Technologies
- Node.js 20
- Discord.js (pour l'API Discord)
- Canvas (pour générer les images de la roue)
- GIF Encoder 2 (pour créer les animations GIF)

## Configuration requise
1. Créer une application Discord sur https://discord.com/developers/applications
2. Créer un bot et copier le token
3. Ajouter les secrets Replit:
   - `DISCORD_TOKEN`: Token du bot Discord
   - `DISCORD_CLIENT_ID`: ID client de l'application Discord

## Utilisation
1. Exécuter `deploy-commands.js` pour enregistrer les commandes slash
2. Lancer le bot avec `index.js`
3. Inviter le bot sur votre serveur Discord
4. Utiliser `/roulette` pour lancer la roue (admin uniquement)

## Changements récents
- 2025-10-15: Création initiale du bot avec animation de roulette
- 2025-10-15: Amélioration majeure du visuel de la roulette avec dégradés, effets 3D, et animations plus fluides
- 2025-10-15: Conversion en animation GIF pour éliminer les écrans noirs
- 2025-10-15: Ajout de la commande /set-title pour personnaliser le titre central
- 2025-10-15: Augmentation à 6 tours complets pour une animation plus spectaculaire
