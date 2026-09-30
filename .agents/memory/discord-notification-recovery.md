---
name: Reprise des annonces Discord
description: Éviter de renvoyer une annonce après un envoi Discord réussi mais un checkpoint de sauvegarde échoué.
---

Une annonce dont l’envoi est incertain ne doit pas être renvoyée sans vérifier les permissions effectives du bot et l’historique du salon.

**Why:** Discord peut renvoyer un historique vide lorsque le bot n’a pas `ReadMessageHistory`, même s’il peut envoyer des messages. Ce résultat ne prouve pas l’absence d’une annonce précédente. Le dédoublonnage par nonce ne couvre qu’une fenêtre récente et ne suffit pas après une reprise tardive.

**How to apply:** Persister une intention d’envoi avant de contacter Discord. Lors d’une reprise, exiger les droits de voir le salon et de lire son historique, puis rechercher le message de ce bot avec un identifiant stable de commande. Si l’absence ne peut pas être établie, afficher un échec explicite sans renvoyer l’annonce. Garder cette reprise indépendante du paiement et des crédits d’inventaire déjà enregistrés.