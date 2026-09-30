---
name: Espaces dans les lignes INI
description: Leçon d’ergonomie sur la saisie de lignes INI ARK indexées dans le dashboard.
---

Pour l’édition INI par ligne exacte, conserver les espaces tels que saisis : ne pas corriger silencieusement une ligne supposée déjà présente sur les cartes. En revanche, rendre les erreurs de syntaxe autour des indices entre crochets faciles à comprendre.

**Why:** Un espace peu visible entre le nom d’une clé ARK et son indice a bloqué la prévisualisation ; le signalement de cet espace a permis à l’utilisateur de corriger sa saisie, ce qu’il a confirmé.

**How to apply:** Dans les formulaires qui comparent des lignes Game.ini exactes, montrer clairement les différences de caractères et expliquer qu’une ligne saisie doit correspondre au fichier. Ne pas normaliser la ligne actuelle au risque de prétendre modifier une ligne différente.