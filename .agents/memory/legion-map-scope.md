---
name: Périmètre des cartes Legion
description: Limite de sécurité pour les commandes groupées du cluster ARK chez Legion Hosting.
---

Les commandes groupées du cluster doivent cibler uniquement les 12 cartes ARK approuvées, et non l'ensemble des serveurs retournés par GPanel. Le serveur d'essai et les futurs serveurs ajoutés au compte restent exclus tant qu'ils ne sont pas explicitement approuvés.

**Why:** Le compte GPanel contient déjà un serveur d'essai distinct des cartes du cluster. Une opération « tous les serveurs » basée sur la seule liste API pourrait l'arrêter ou le redémarrer par erreur.

**How to apply:** Lors de la migration des commandes Discord, RCON, redémarrages programmés et Booster Repro, partager le même périmètre explicite et vérifier les identifiants avant les actions d'écriture. Ne jamais interpréter une ancienne sélection vide ou absente comme « les 12 cartes » : elle peut provenir d'un planning Nitrado historique. Exiger une nouvelle sélection explicite avant de remettre un tel planning en service.

La liste de mods ASA des cartes Legion doit être gérée via la variable de démarrage GPanel « Mod IDs », une carte à la fois et carte hors ligne. Ne pas modifier `ActiveMods` dans l'INI : GPanel donne priorité à sa variable de démarrage. Le démarrage doit rester manuel pour laisser le téléchargement des mods se terminer.

**Why:** la documentation Legion recommande la variable de démarrage et prévient qu'elle peut remplacer la valeur INI; un démarrage interrompu pendant le téléchargement peut laisser la carte indisponible.

**How to apply:** conserver l'ordre de chargement et limiter les changements aux 12 identifiants approuvés; ne jamais arrêter ou démarrer automatiquement une carte dans le gestionnaire de mods.