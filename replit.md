# Bot Discord Arki Roulette

## Vue d'ensemble
Bot Discord qui simule une roue de la chance animée. Les administrateurs peuvent lancer la roulette et un choix aléatoire est sélectionné avec une animation visuelle.

## Fonctionnalités
- **Commande /roulette**: Lance la roue avec animation GIF fluide (admin et Modo)
- **Commande /set-choices**: Modifie le titre et les choix de la roulette (admin et Modo)
- **Commande /show-choices**: Affiche le titre et les choix actuels
- Animation GIF fluide sans écran noir (60 frames + 9 tours complets)
- Image de roue colorée avec dégradés 3D et les choix affichés
- Système de permissions pour les administrateurs et le rôle Modo

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
- 2025-10-15: Ajout de la commande /set-choices avec titre et choix (en premier option titre puis choix)
- 2025-10-15: Augmentation à 9 tours complets pour une animation plus longue et spectaculaire
- 2025-10-15: Simplification : une seule commande /set-choices pour titre + choix (suppression /set-title)
- 2025-10-15: Augmentation de la limite du titre à 20 caractères (au lieu de 15)
- 2025-10-15: Ajout du rôle "Modo" aux permissions (admin + Modo peuvent utiliser /roulette et /set-choices)
- 2025-10-15: Configuration de l'ID du rôle Modo (1157803768893689877) pour les permissions
