---
name: Journal Legion et incidents
description: Limites de preuve de l'API GPanel pour les incidents ARK et les commandes console.
---

Un compteur de fonctionnement remis à zéro permet de constater un redémarrage entre deux relevés, mais pas d'établir pourquoi il s'est produit. Une réponse favorable à une commande console signifie seulement que GPanel l'a acceptée ; elle ne confirme pas son effet en jeu.

**Why:** Les activités GPanel documentent les commandes et les actions explicites, mais ne fournissent pas de diagnostic fiable de crash. Afficher « bug confirmé » ou « wipe terminé » serait trompeur.

**How to apply:** Dans tout journal, notification ou planning Legion, distinguer action reçue, interruption observée et cause confirmée. Comparer l'historique des actions récentes avant de qualifier un redémarrage d'inattendu.

Pour les commandes administrateur ARK, ne pas considérer la réponse « acceptée » de GPanel comme une preuve d'exécution : même un essai depuis la console du panel peut rester sans effet dans le jeu. Une alternative RCON directe exige séparément un port alloué à chaque carte, une connexion TCP et une authentification réussie ; un port TCP ouvert ne prouve pas que RCON fonctionne.

**Why:** Une commande de suppression des dinos sauvages paraissait acceptée depuis les deux interfaces et depuis la console GPanel, mais les dinos restaient présents. Les contrôles du port et de l'authentification RCON ont ensuite donné des résultats distincts : aucun de ces contrôles pris seul ne valide l'exécution en jeu.

**How to apply:** Avant d'annoncer qu'une action sensible fonctionne, vérifier une commande RCON non destructive puis l'effet réel d'une action sur une seule carte ; signaler honnêtement les cartes non configurées ou non authentifiées au lieu de présenter un acquittement API comme une réussite.