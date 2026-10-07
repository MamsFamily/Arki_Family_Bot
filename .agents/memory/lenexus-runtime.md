---
name: Isolation des runtimes Lenexus
description: Pourquoi isoler le workspace du site et son runtime de ceux du bot Python et du bot principal.
---

Garder le workspace JavaScript de Lenexus dans un sous-dossier du dépôt du bot
Python, sans ajouter son package.json à la racine du bot.

**Why:** Railway utilise l'autodétection des langages et commandes de build.
Le manifeste du site à la racine risquait d'ajouter son build global et ses
erreurs de type au déploiement du bot, même sans modification de Python.

**How to apply:** vérifier les fichiers et commandes du bot avant de fusionner un
import web. Les services du site doivent utiliser leur propre racine de workspace.

Ne pas modifier le runtime global du bot principal uniquement pour démarrer ou
tester l'API Lenexus.

**Why:** l'API dépend du SQLite natif absent de l'ancien runtime du bot ; les
contraintes vocales du bot sont un autre sujet.

**How to apply:** sélectionner un runtime compatible pour le processus API ou
pour son propre projet de déploiement, sans déplacer ses données persistantes.

Éviter les globaux de découverte sur tout /nix/store.

**Why:** l'expansion du répertoire a bloqué le démarrage de l'API au-delà du délai
de détection du port alors qu'un runtime compatible était déjà disponible.

**How to apply:** choisir explicitement le runtime avec les outils de configuration
ou un chemin déjà vérifié, au lieu de parcourir le store pendant le démarrage.
