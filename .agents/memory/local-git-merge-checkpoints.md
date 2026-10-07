---
name: Reprises de fusion Git
description: Comportement observé des fusions locales après une interruption de tour dans ce workspace.
---

Après une interruption utilisateur pendant une fusion en conflit, ne pas supposer que `MERGE_HEAD` et les entrées non fusionnées sont encore présents. Dans ce workspace, le tour suivant a retrouvé un nouvel état local propre avec les changements précédents checkpointés, mais sans la fusion distante ; il a fallu vérifier les références et relancer la fusion.

**Why:** une fusion interrompue a été suivie d’un déplacement de `HEAD` sur un commit local checkpointé et de la disparition de `MERGE_HEAD`.

**How to apply:** après toute interruption ou reprise de contexte pendant une fusion, vérifier `git status -sb`, `git rev-parse --verify MERGE_HEAD`, les parents de `HEAD` et `git merge-base --is-ancestor origin/main HEAD` avant d’affirmer que la fusion est terminée.
