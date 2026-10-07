---
name: Workflow startup
description: Démarrage du bot et précautions lors du redémarrage des workflows web/API.
---

Le workflow Dashboard doit exécuter `node index.js` pour démarrer ensemble le bot et le web; `createWebServer(null)` seul ne remplace pas ce point d’entrée.

**Why:** le Dashboard partage le runtime du bot et du site; un lancement web seul laisse le bot arrêté.

**How to apply:** garder `node index.js` pour le workflow principal.

Un workflow d'artefact peut échouer avec `EADDRINUSE` alors que son ancien processus enfant écoute encore sur le port attendu.

**Why:** le shell de lancement peut s'arrêter sans arrêter le processus Vite ou API qu'il a démarré.

**How to apply:** après cet échec, vérifier le port et l'arbre des processus, arrêter uniquement le listener orphelin lié à l'artefact concerné, puis redémarrer une fois.
