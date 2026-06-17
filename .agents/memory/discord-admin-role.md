---
name: Discord admin role
description: ID du rôle administrateur Discord du serveur Arki Family, utilisé pour les permissions bot et panneau serveur.
---

# Rôle Admin Discord

**ID** : `1157044417526509578`

**Why:** Ce rôle doit avoir accès aux boutons sensibles du bot (panneau serveurs, commandes admin). Il est configuré dans `settings.serverPanel.adminRoleIds` et dans les DEFAULTS de `settingsManager.js`.

**How to apply:** Quand l'utilisateur demande de restreindre une fonctionnalité aux admins, inclure cet ID dans la vérification de rôle. Ne jamais exiger uniquement la permission `Administrator` Discord sans aussi vérifier ce rôle.
