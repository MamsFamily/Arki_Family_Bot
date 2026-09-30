---
name: Suggestions INI sûres
description: Principe de confidentialité des suggestions de lignes INI proches.
---

Une suggestion de ligne INI voisine ne doit pas afficher librement la valeur d'une clé quelconque. L'affichage de la ligne complète est réservé aux réglages de jeu explicitement reconnus et à des valeurs de forme attendue ; pour les autres réglages, masquer la valeur ou ne pas suggérer la clé si elle semble sensible. La suggestion ne doit jamais se substituer à une correspondance exacte pour l'écriture.

**Why:** Une simple recherche de mots comme « password » laisse passer des secrets numériques (`Pwd`) et des URL de webhook contenant des jetons. À l'inverse, masquer toutes les valeurs empêche de copier une ligne ordinaire comme un nom de session. La forme de la valeur seule n'établit pas sa confidentialité.

**How to apply:** Lors de tout aperçu ou diagnostic basé sur des fichiers INI, considérer la réponse API comme une divulgation du contenu serveur. Tester les identifiants sensibles atypiques et les valeurs opaques avant d'ajouter une clé à la liste des réglages pouvant être montrés intégralement.