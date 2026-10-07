---
name: Liaison avec Arkifamily-Lenexus
description: Relation entre les deux produits et périmètre de partage demandé par l'utilisateur.
---

L'utilisateur possède un deuxième bot, « Arkifamily-Lenexus », avec son propre site internet, créé sur Replit avec le même compte. Il souhaite envisager une fusion ou une liaison de données pour rendre la gestion « plus simple et plus fluide ».

Les domaines de partage qu'il a sélectionnés sont :
- Joueurs, comptes et inventaires.
- Shop, prix et commandes.
- Tickets, annonces et activités.

**Why:** demande explicite de l'utilisateur pour coordonner ses deux produits.

**How to apply:** tenir compte des deux produits lorsqu'on conçoit la liaison. Ne pas confondre cette demande de conseil et de préparation avec une autorisation de migrer les bases ou de déployer les deux bots.

Le site Lenexus est l'interface choisie pour afficher les informations communes aux deux bots.

**Why:** choix explicite de l'utilisateur entre le site Lenexus, ce Dashboard et les deux sites.

**How to apply:** prévoir les nouveaux écrans de consultation communs sur Lenexus, sans supposer que ce choix autorise à supprimer les fonctions existantes de ce Dashboard.

Les sources du site Lenexus peuvent être ajoutées au dépôt Arki_Identite dans une
branche séparée. Le bot Python, ses données et son hébergement restent distincts
du site et de son API.

**Why:** l'utilisateur a autorisé cet import après constat que le dépôt ne contenait
que le bot, puis a donné son accord pour l'intégration et la mise en service de la liaison.

**How to apply:** les restrictions initiales de préparation en branches seules
ne sont plus en vigueur. Conserver le périmètre lecture seule et les données
existantes ; ne pas remplacer le bot ou partager ses secrets Discord entre produits.

Le site existant appartient au projet Replit distinct « ArkiFamily-LeNexus ».
Une fusion dans le dépôt du bot Python et son déploiement Railway ne mettent
pas automatiquement à jour ce site.

**Why:** l'utilisateur a fourni les liens du projet et du site d'origine,
confirmant la séparation entre le site Replit et le bot Railway.

**How to apply:** intégrer les changements dans le projet du site en conservant
ses propres données et sa configuration. Ne pas publier la copie importée ici
comme remplacement du site existant.

L'utilisateur indique que la clé de liaison a déjà été enregistrée dans les
secrets du projet Lenexus et dans les variables de son service Railway.

**Why:** confirmation explicite de l'utilisateur.

**How to apply:** ne jamais lui demander la valeur de cette clé dans le chat.
Les services la lisent depuis leur configuration ; ne pas ajouter un doublon
au projet Replit du bot Python.

L'absence de SQLite dans un export de sources Lenexus ne prouve pas que les
tribus ou identités ont disparu en production.

**Why:** l'archive fournie contenait le code mais aucune base SQLite ; vouloir
reproduire ses tests à partir d'une base supposée présente était une mauvaise
hypothèse.

**How to apply:** distinguer sources exportées et état de production. Utiliser
des schémas et comptes fictifs pour les tests, sans reconstruire les tribus,
copier les données réelles ou hériter d'une connexion PostgreSQL active.
