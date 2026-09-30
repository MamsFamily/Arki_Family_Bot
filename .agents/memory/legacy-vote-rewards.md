---
name: Récompenses votes historiques
description: Limite des nouveaux reçus pour les mois distribués avant leur introduction.
---

L’absence d’un nouveau reçu ne prouve pas qu’une récompense historique n’a jamais été créditée. Les mois déjà publiés avant l’introduction des reçus ne doivent pas être redistribués automatiquement.

**Why:** Les anciens crédits ne possèdent pas ces reçus. Une relance d’un ancien mois peut donc doubler les gains malgré une nouvelle distribution correctement protégée. Une erreur de lecture du marqueur historique ne doit pas être interprétée comme une absence de distribution.

**How to apply:** Avant de reprendre une période historique, vérifier les anciennes transactions et les décisions admin sur la base réellement utilisée par le bot. Ne pas effacer un marqueur de publication pour « réparer » un mois sans cet audit. Les nouveaux reçus sécurisent uniquement les crédits effectués avec eux.

Une ancienne annonce « récompensés » dans les journaux n’est pas, à elle seule, une preuve de sauvegarde des crédits.

**Why:** L’ancien chemin d’inventaire pouvait annoncer un succès après un retour d’échec de sauvegarde PostgreSQL. Les messages historiques ne permettent donc pas de distinguer un crédit confirmé d’un faux succès.

**How to apply:** Après une mise à jour arrivée après le cycle mensuel, exclure explicitement les anciens cycles du rattrapage et vérifier les données réelles avant toute réparation. Ne pas déduire une réussite complète, ni un échec complet, des seules annonces de l’ancienne version.