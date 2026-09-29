---
name: Journal Legion et incidents
description: Limites de preuve de l'API GPanel pour les incidents ARK et les commandes console.
---

Un compteur de fonctionnement remis à zéro permet de constater un redémarrage entre deux relevés, mais pas d'établir pourquoi il s'est produit. Une réponse favorable à une commande console signifie seulement que GPanel l'a acceptée ; elle ne confirme pas son effet en jeu.

**Why:** Les activités GPanel documentent les commandes et les actions explicites, mais ne fournissent pas de diagnostic fiable de crash. Afficher « bug confirmé » ou « wipe terminé » serait trompeur.

**How to apply:** Dans tout journal, notification ou planning Legion, distinguer action reçue, interruption observée et cause confirmée. Comparer l'historique des actions récentes avant de qualifier un redémarrage d'inattendu.