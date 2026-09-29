# Starter pack ARK Ascended — intégration à terminer sur PC Windows

Le code du bot et du registre est dans ce dossier. **Aucun mod ARK n'est encore compilé ou publié.**
Le contenu demandé est dans `pack.json` : ce fichier est un cahier des charges,
**pas** une liste de commandes ou de blueprints ARK exécutables. Ne pas activer
la remise avant d'avoir testé *tous* les objets, notamment la gourde remplie,
la tenue camouflage complète et le Griffon apprivoisé niveau 450 déjà en cryo.
Les deux cryopodes vides sont **en plus** de celle du Griffon.

## Prérequis de sécurité

- Mod ARK Survival Ascended **ordinaire**, pas un mod « Custom Cosmetics » :
  ces derniers ne peuvent pas émettre de requêtes réseau.
- DevKit sous Windows, test local puis serveur Legion d'essai. Le mod doit
  obtenir l'identité EOS depuis le joueur réellement connecté, côté serveur
  de jeu. Ne jamais accepter un EOS fourni librement par le joueur.
- Le mod téléchargeable est **public** : aucun mot de passe, clé API Legion ou
  `STARTER_PACK_MOD_TOKEN` ne doit y être intégré. Un pont de confiance **privé
  côté serveur** doit relayer les messages authentifiés du mod vers le backend.
  Sa faisabilité sur Legion et la façon dont le DevKit prouve la provenance
  serveur sont à valider avant la mise en service. Le seul fait qu'un Blueprint
  sache faire une requête HTTP ne constitue **pas** une preuve d'identité.
- Le pont doit être limité aux 12 identifiants de cartes approuvés. HTTPS,
  accès réseau restreint, journaux sans codes de liaison ni jetons. Sur les
  Blueprints utilisant HTTP, implémenter `BPSecureNetworkingInterface` et sa
  fonction d'audit, en n'autorisant que les URL et méthodes attendues.
- Le bot Railway et le dashboard doivent utiliser la **même base PostgreSQL**.
  Les secrets Replit ne sont pas automatiquement présents sur Railway.

## Protocole préparé (désactivé par défaut)

1. `/starterpack lier` sur Discord produit un code privé valable 10 minutes.
2. Le joueur présente ce code dans une interaction en jeu. Le pont observe son
   EOS authentifié et la carte ; il transmet en HTTPS :
   `POST /api/starter-pack/link` avec `{ "code": "...", "eosId": "...", "mapId": "..." }`.
   Les liaisons EOS et Discord sont toutes deux uniques et le code est consommé.
3. `/starterpack recevoir` place **une** demande en attente pour cet EOS (et ce
   Discord). La commande est inactive tant que la remise n'est pas validée.
4. Quand le joueur est connecté, le pont appelle
   `POST /api/starter-pack/next` avec `{ "eosId": "...", "mapId": "...",
   "packVersion": "starter-ark-1" }`. Si `claim` est `null`, aucune action.
   Sinon, le mod doit remettre **exactement** la version validée du pack.
5. Seulement après vérification de tous les objets dans l'inventaire, le pont
   appelle `POST /api/starter-pack/delivered` avec `eosId`, `mapId`, `packVersion`
   et `claimId`. Une remise `delivering` n'est **jamais** relancée
   automatiquement : en cas de crash/timeout, le staff vérifie l'inventaire
   avant toute intervention manuelle, pour ne pas dupliquer le Griffon.

Le pont privé envoie `Authorization: Bearer <secret>` pour ces trois routes.
Le secret doit être provisionné **côté serveur**, sur le service qui expose
l'API et sur le pont, jamais dans un fichier de mod ni dans Git.
Les routes répondent 503 si la liaison est désactivée ou si le secret manque.
`STARTER_PACK_LINK_ENABLED=true` annonce la commande Discord et active la
liaison ; `STARTER_PACK_DELIVERY_ENABLED=true` active la demande et la remise.
La remise reste également bloquée par le statut non validé dans `pack.json` ;
il devra être passé à `validated-in-devkit` **après** les essais ci-dessous.
Ne configurer ces options qu'après test du mod et du pont sur le serveur d'essai.

## Validation DevKit indispensable

- Vérifier le type et l'exposition Blueprint de l'EOS du joueur connecté ;
  valider ce point avant de figer le pont serveur.
- Valider pour chaque objet les assets/blueprints, DLC/mods nécessaires, poids,
  qualité, quantité et état de la gourde.
- Vérifier comment créer un Griffon **apprivoisé de niveau final 450** et
  sérialiser ce même animal dans une cryopode valide. Ne pas substituer un objet
  vide ou un Griffon sauvage.
- Tester un compte neuf, deux comptes Discord sur un même EOS, un Discord sur
  deux EOS, la reconnexion sur une autre carte et un crash au milieu du grant.
- Distribuer d'abord sur le serveur d'essai ; aucune activation sur les 12
  cartes tant que la preuve en jeu et la récupération des erreurs ne sont pas
  établies.

Références officielles :
[réseau Blueprint](https://devkit.studiowildcard.com/systems-tools/blueprint-secure-networking),
[tests du mod](https://devkit.studiowildcard.com/getting-started/testing),
[publication](https://devkit.studiowildcard.com/getting-started/cooking-publishing).