---
name: PIN de coffre de tribu
description: Décisions d'accès et de chiffrement pour le PIN stocké dans une fiche de tribu Arki.
---

Le PIN des coffres est consultable par les membres inscrits de la tribu et le staff du site. Seuls le propriétaire, les gérants de la fiche et le staff du site peuvent le modifier ou le supprimer. Dans un ticket shop et dans les catégories Inventaire ou Autres demandes d'un ticket Réclamation, le bot ne doit demander que les PIN des tribus liées au compte Discord qui a ouvert le ticket.

Le PIN est chiffré au repos avec une clé dérivée de `SESSION_SECRET`. Toute rotation de ce secret rendrait les PIN déjà stockés indéchiffrables.

**Why:** l'utilisateur a choisi ces droits pour que le PIN puisse être utilisé dans les tickets shop et dans les catégories Inventaire et Autres demandes des tickets Réclamation, sans être redemandé, tout en permettant aux responsables de le tenir à jour.

**How to apply:** conserver ces droits si les routes ou l'interface du PIN évoluent; dans les tickets shop, Inventaire et Autres demandes, ne récupérer que les PIN des tribus liées au créateur; ne jamais inclure le PIN dans les réponses publiques, les journaux ou l'historique d'activité.
