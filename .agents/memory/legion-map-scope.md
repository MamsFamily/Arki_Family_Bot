---
name: Périmètre des cartes Legion
description: Limite de sécurité pour les commandes groupées du cluster ARK chez Legion Hosting.
---

Les commandes groupées du cluster doivent cibler uniquement les 12 cartes ARK approuvées, et non l'ensemble des serveurs retournés par GPanel. Le serveur d'essai et les futurs serveurs ajoutés au compte restent exclus tant qu'ils ne sont pas explicitement approuvés.

**Why:** Le compte GPanel contient déjà un serveur d'essai distinct des cartes du cluster. Une opération « tous les serveurs » basée sur la seule liste API pourrait l'arrêter ou le redémarrer par erreur.

**How to apply:** Lors de la migration des commandes Discord, RCON, redémarrages programmés et Booster Repro, partager le même périmètre explicite et vérifier les identifiants avant les actions d'écriture.