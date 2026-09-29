---
name: Secrets du bot Railway
description: Limite entre les environnements Replit et Railway pour le bot Discord.
---

Le dashboard de développement et le bot Discord en ligne tournent dans deux environnements distincts. La présence d'un secret dans Replit ne garantit pas sa présence dans le service Railway du bot.

**Why:** Une commande Legion fonctionnelle dans le code du bot a renvoyé « clé API client Legion non configurée » depuis Discord alors que le secret était présent dans Replit. Aucun wipe n'a été envoyé dans ce cas.

**How to apply:** Pour toute fonction serveur appelée directement par le bot Discord, vérifier l'existence de ses variables dans le service Railway concerné avant d'annoncer qu'elle fonctionne en ligne. Ne jamais lire, afficher ou transférer leurs valeurs dans le code ou le chat ; utiliser la gestion des variables du fournisseur.

Le verrou partagé des écritures INI ne coordonne le dashboard et les boosters que si les deux processus exécutent une version qui l'utilise. Un redémarrage du dashboard Replit ne met pas à jour le bot Railway.

**Why:** Le bot en ligne et le dashboard tournent séparément ; un verrou ajouté uniquement au code Replit ne peut empêcher une ancienne version du bot de modifier les mêmes fichiers au même moment.

**How to apply:** Après une modification du protocole d'écriture INI partagé, distinguer validation locale et mise à jour effective du bot Railway avant d'affirmer que la protection inter-processus est opérationnelle en ligne.