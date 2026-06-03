---
name: Discord modal timing
description: showModal() doit être la première réponse à une interaction — aucun await avant l'appel.
---

## Règle

`interaction.showModal()` doit être appelé **sans aucun `await` préalable** dans le handler de la commande. Discord impose un délai de 3 secondes pour la première réponse ; tout `await` (requête DB, appel API, etc.) risque de dépasser ce délai et provoque l'erreur côté Discord : "Erreur lors de l'ouverture du formulaire."

**Why:** Railway PostgreSQL peut être lent sur une connexion froide, faisant échouer le showModal() même pour une requête simple.

**How to apply:** Si le modal doit afficher des données existantes (pre-fill), les récupérer APRÈS le submit du modal, pas avant. Construire le modal avec des champs vides et laisser l'utilisateur remplir.
