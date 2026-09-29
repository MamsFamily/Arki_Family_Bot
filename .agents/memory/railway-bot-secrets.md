---
name: Secrets du bot Railway
description: Limite entre les environnements Replit et Railway pour le bot Discord.
---

Le dashboard de développement et le bot Discord en ligne tournent dans deux environnements distincts. La présence d'un secret dans Replit ne garantit pas sa présence dans le service Railway du bot.

**Why:** Une commande Legion fonctionnelle dans le code du bot a renvoyé « clé API client Legion non configurée » depuis Discord alors que le secret était présent dans Replit. Aucun wipe n'a été envoyé dans ce cas.

**How to apply:** Pour toute fonction serveur appelée directement par le bot Discord, vérifier l'existence de ses variables dans le service Railway concerné avant d'annoncer qu'elle fonctionne en ligne. Ne jamais lire, afficher ou transférer leurs valeurs dans le code ou le chat ; utiliser la gestion des variables du fournisseur.