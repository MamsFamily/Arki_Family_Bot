# Liaison ArkiFamily → Lenexus : consultation uniquement

Cette liaison ne migre aucune base et ne modifie aucun inventaire, paiement,
commande, ticket ou salon Discord. ArkiFamily reste responsable de ces données ;
Lenexus reste responsable des tribus. Les sessions et tokens Discord restent séparés.

## Avant activation

1. Examiner et fusionner les branches des **deux** dépôts séparément.
2. Déployer uniquement après vérification des configurations de chaque service.
3. Choisir une même clé aléatoire forte d'au moins 32 caractères, réservée à cette
   liaison. La créer/conserver avec les outils Secrets ; jamais dans Git, un message,
   une URL ou une variable `VITE_`.
4. Dans le service ArkiFamily réellement appelé (Railway ou Dashboard publié),
   définir `NEXUS_BRIDGE_TOKEN` et `NEXUS_BRIDGE_ENABLED=true`. Le service doit
   disposer de sa connexion PostgreSQL et de son propre `DISCORD_TOKEN`.
5. Dans le **backend** Lenexus, définir `ARKI_BRIDGE_TOKEN` avec la même clé,
   et `ARKI_BRIDGE_URL` avec l'origine HTTPS publiée d'ArkiFamily, sans chemin
   (pas une URL de preview, pas une URL de base PostgreSQL).
6. Configurer le même serveur Discord : `settings.guild.guildId` dans ArkiFamily
   et `DISCORD_GUILD_ID` dans Lenexus. Le bot ArkiFamily doit pouvoir vérifier les
   membres et rôles de ce serveur.

Les Secrets Replit ne sont pas automatiquement transmis au processus Railway.
Ne pas réutiliser un token Discord comme clé de liaison.

Sans configuration, les écrans affichent une erreur explicite ; les anciens
écrans Lenexus et les bots continuent de fonctionner. Mettre
`NEXUS_BRIDGE_ENABLED=false` coupe la liaison sans supprimer de données.

## Contrat versionné

Requêtes GET seulement vers `/api/nexus/v1/account`, `/catalog`, `/staff?page=1` et `/map-status`.
Les trois routes de compte exigent `Authorization: Bearer …`, `X-Arki-Actor-Id` et
`X-Arki-Guild-Id`. Lenexus déduit l'acteur de sa session Discord et la source
vérifie son appartenance au serveur.

`GET /api/nexus/v1/map-status` est l'unique exception à l'identité Discord : la
clé de liaison reste obligatoire. Il ne renvoie que 12 objets `{slug, state}`,
sans identifiant GPanel ni détail de ressource. Une erreur GPanel sur une map
devient `unknown`; une panne générale renvoie `503`. La réponse est mise en cache
10 secondes côté bot pour limiter les appels GPanel. Toutes les réponses restent
`no-store`.

- Compte : uniquement son inventaire, ses 50 dernières commandes, ses tickets
  shop/spawn/reclaim et 30 mouvements d'inventaire. Pas de notes staff ni de
  transcriptions.
- Catalogue : prix de base, variantes/options disponibles. Les promotions et
  réductions finales restent calculées par le parcours ticket existant.
- Staff : 50 commandes par page. Il faut être autorisé sur Lenexus **et** être
  propriétaire/administrateur Discord ou posséder un rôle shop configuré dans
  ArkiFamily. Un droit sur un seul site ne suffit pas.

Un lien vers un ancien ticket fermé peut ne plus fonctionner si son salon a été
supprimé. `paid` signifie encaissé, pas une nouvelle preuve de livraison.

## Contrôles avant mise en ligne

- Joueur A : ne voit jamais les données du joueur B, même avec un ID dans l'URL.
- Visiteur anonyme : refusé par Lenexus.
- Staff sans autorisation ArkiFamily : refusé.
- Clé absente/invalide, serveur différent, Discord ou PostgreSQL indisponibles :
  erreur explicite, aucun repli local ou écriture.
- Vérifier les écrans avec des comptes réellement connectés après configuration.

Tests ArkiFamily : `node --test tests/nexus-bridge.test.js`.
