# 🎰 Bot Discord Arki Roulette

Un bot Discord avec une roue de la chance animée ! Les administrateurs peuvent lancer la roulette et un choix aléatoire est sélectionné avec une belle animation visuelle.

## ✨ Fonctionnalités

- **🎲 /roulette** - Lance la roue de la chance avec animation GIF (admin et Modo)
- **⚙️ /set-choices** - Modifie le titre et les choix de la roulette (admin et Modo)
- **📋 /show-choices** - Affiche le titre et les choix actuels de la roulette
- Animation GIF fluide sans écran noir (9 tours complets)
- Image de roue colorée avec dégradés 3D générée dynamiquement
- Système de permissions pour les administrateurs et le rôle Modo

## 🚀 Installation et Configuration

### 1. Créer votre application Discord

1. Allez sur [Discord Developer Portal](https://discord.com/developers/applications)
2. Cliquez sur **"New Application"**
3. Donnez un nom à votre application (par exemple "Arki Roulette")
4. Cliquez sur **"Create"**

### 2. Créer le bot

1. Dans le menu de gauche, cliquez sur **"Bot"**
2. Cliquez sur **"Add Bot"** puis confirmez
3. Sous "TOKEN", cliquez sur **"Reset Token"** puis copiez le token
   - ⚠️ Gardez ce token secret !
4. Activez ces options sous "Privileged Gateway Intents":
   - ✅ Presence Intent
   - ✅ Server Members Intent
   - ✅ Message Content Intent

### 3. Obtenir l'ID Client

1. Dans le menu de gauche, cliquez sur **"General Information"**
2. Copiez l'**"APPLICATION ID"** (c'est votre CLIENT_ID)

### 4. Ajouter les secrets dans Replit

1. Dans Replit, cliquez sur l'icône **"Secrets"** (🔒) dans le panneau de gauche
2. Ajoutez deux secrets :
   - **Nom:** `DISCORD_TOKEN` → **Valeur:** Le token que vous avez copié
   - **Nom:** `DISCORD_CLIENT_ID` → **Valeur:** L'APPLICATION ID

### 5. Inviter le bot sur votre serveur

1. Retournez sur le [Discord Developer Portal](https://discord.com/developers/applications)
2. Cliquez sur **"OAuth2"** → **"URL Generator"**
3. Cochez ces permissions :
   - **Scopes:**
     - ✅ `bot`
     - ✅ `applications.commands`
   - **Bot Permissions:**
     - ✅ Send Messages
     - ✅ Attach Files
     - ✅ Use Slash Commands
4. Copiez l'URL générée en bas et collez-la dans votre navigateur
5. Sélectionnez votre serveur et cliquez sur **"Authorize"**

### 6. Enregistrer les commandes slash

Avant de démarrer le bot, vous devez enregistrer les commandes :

```bash
npm run deploy
```

### 7. Démarrer le bot

Cliquez sur le bouton **"Run"** dans Replit ou exécutez :

```bash
npm start
```

Si tout fonctionne, vous verrez :
```
✅ Bot Discord Arki Roulette est en ligne !
📝 Connecté en tant que VotreBot#1234
🎰 8 choix de roulette chargés
```

## 🎮 Utilisation

### Commandes disponibles

#### `/roulette`
Lance la roue de la chance avec une animation GIF fluide. Le bot affichera une roue qui tourne pendant 9 tours complets et sélectionnera un choix aléatoire.
- **Permission requise:** Administrateur ou rôle Modo
- **Animation:** GIF animé sans écran noir, parfaitement fluide

#### `/set-choices [title] [choices]`
Modifie le titre et les choix de la roulette.
- **Paramètre title (requis):** Le titre au centre de la roulette (max 20 caractères)
- **Paramètre choices (requis):** Liste de choix séparés par des virgules
- **Exemples:** 
  - `/set-choices title:ARKI choices:mams,caille,tracteur,zero,death`
  - `/set-choices title:CHAMPION choices:Prix1,Prix2,Prix3,Essayez encore`
- **Limites:** Minimum 2 choix, maximum 12 choix, titre max 20 caractères
- **Permission requise:** Administrateur ou rôle Modo

#### `/show-choices`
Affiche la liste de tous les choix actuels configurés sur la roulette ainsi que le titre.
- **Permission requise:** Aucune (tous les utilisateurs)

## 📝 Configuration personnalisée

Vous pouvez modifier les choix par défaut de la roulette en éditant le fichier `config.json` :

```json
{
  "rouletteChoices": [
    "🎁 Cadeau surprise",
    "⭐ Prix spécial",
    "🎮 Jeu gratuit",
    "💎 Bonus premium",
    "🎯 Essayez encore",
    "🏆 Grand prix",
    "🎨 Récompense créative",
    "🌟 Chance exceptionnelle"
  ]
}
```

## 🛠️ Dépannage

### Le bot ne démarre pas
- Vérifiez que `DISCORD_TOKEN` et `DISCORD_CLIENT_ID` sont bien configurés dans les secrets Replit
- Assurez-vous que le token est valide (pas expiré)

### Les commandes slash n'apparaissent pas
- Exécutez d'abord `npm run deploy` pour enregistrer les commandes
- Attendez quelques minutes (Discord peut prendre du temps pour synchroniser)
- Essayez de taper `/` dans Discord pour voir les commandes

### "Seuls les administrateurs peuvent lancer la roulette"
- C'est normal ! Cette commande est réservée aux administrateurs du serveur
- Assurez-vous d'avoir le rôle d'administrateur sur le serveur

## 📦 Technologies utilisées

- **Node.js 20** - Runtime JavaScript
- **Discord.js v14** - Bibliothèque pour l'API Discord
- **Canvas** - Génération d'images de la roue
- **GIF Encoder 2** - Création d'animations GIF fluides

## 📄 Licence

ISC

## 🤝 Support

Si vous rencontrez des problèmes, vérifiez que :
1. Les secrets `DISCORD_TOKEN` et `DISCORD_CLIENT_ID` sont bien configurés
2. Le bot a les bonnes permissions sur votre serveur Discord
3. Les commandes ont été enregistrées avec `npm run deploy`

Bon amusement avec votre roue de la chance ! 🎰✨
