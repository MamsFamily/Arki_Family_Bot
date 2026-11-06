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

L’utilisateur a confirmé le 6 novembre 2026 que les récompenses du mois précédent (octobre 2026) avaient déjà été distribuées avant leur relance au redémarrage. Ce mois est clôturé : ne pas le recréditer, y compris via les anciennes demandes de validation.

**Why:** l’utilisateur signale une redistribution au redémarrage alors que les gains avaient déjà été versés. Un marqueur absent ne doit pas autoriser un rattrapage.

**How to apply:** ne jamais déclencher de distribution de votes au démarrage du bot. Conserver la programmation mensuelle et les commandes explicites du staff pour les périodes non clôturées. Auditer les transactions du bot Railway avant de proposer une correction des soldes, et demander l’accord de l’utilisateur avant tout retrait.

L’annulation doit cibler uniquement le dernier versement, jamais tous les gains d’un mois ni le versement précédent après une première annulation.

**Why:** l’utilisateur veut retirer le dernier versement erroné tout en conservant le premier paiement légitime. Les anciens historiques ne permettent pas de distinguer sûrement les lots à partir d’un simple écart de temps.

**How to apply:** conserver un identifiant commun pour les futurs crédits d’une même exécution. Pour un versement ancien sans lot, demander une borne horaire explicite plutôt que deviner. La confirmation doit porter sur les seules transactions de l’aperçu ; garder les reçus d’origine pour empêcher un recrédit et des reçus d’annulation persistants pour empêcher un second retrait.