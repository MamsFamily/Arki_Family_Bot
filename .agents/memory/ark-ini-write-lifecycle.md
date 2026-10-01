---
name: Écritures INI et cycle de vie ARK
description: Pourquoi une relecture immédiate ne garantit pas la persistance d'une modification INI faite à chaud.
---

Les modifications INI destinées à persister doivent être faites après l'arrêt effectif des cartes concernées, et non pendant leur fonctionnement. Une relecture immédiatement après écriture prouve seulement le contenu à cet instant.

**Why:** La documentation de configuration ARK Survival Ascended de Legion indique qu'ARK peut réécrire ses fichiers à l'arrêt et perdre les changements effectués pendant son fonctionnement. Une confirmation d'écriture ne permet donc pas de promettre leur conservation après un redémarrage.

**How to apply:** Pour les éditeurs INI et les rotations Shiny, vérifier l'état des cartes réellement à modifier et expliquer la nécessité de l'arrêt avant l'écriture. Ne pas arrêter ou redémarrer les serveurs sans l'accord de l'utilisateur. Lors d'un diagnostic de valeurs disparues, garder cette explication comme hypothèse jusqu'à connaître les cartes, les réglages et leur état au moment des changements.