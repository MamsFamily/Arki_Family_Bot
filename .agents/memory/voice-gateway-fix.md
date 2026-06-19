---
name: Voice gateway fix - Discord.js 14.23+ / @discordjs/ws incompatibility
description: Bug critique — connexion vocale toujours bloquée en signalling à cause d'un mismatch d'enum Status entre discord.js et @discordjs/ws.
---

## Le problème réel

`@discordjs/voice` reste bloqué en `signalling` : l'OP 4 VoiceStateUpdate n'est jamais envoyé à Discord.

## Cause racine

Dans `discord.js/src/structures/Guild.js`, `voiceAdapterCreator.sendPayload` fait :
```js
const Status = require('../util/Status');
// Status.Ready = 0  ← ancienne valeur discord.js
if (this.shard.status !== Status.Ready) return false;
```

Mais `guild.shard` est désormais un `@discordjs/ws` `WebSocketShard` dont les valeurs sont :
- `WebSocketShardStatus.Idle = 0`
- `WebSocketShardStatus.Ready = 3`  ← valeur réelle quand le shard est connecté

Résultat : `shard.status (3) !== Status.Ready (0)` → toujours `false` → OP 4 jamais envoyé → Discord ne répond pas → `signalling` permanent.

## Fix (dans blindTestManager.js, fonction connectToVoice)

Fournir un `adapterCreator` personnalisé à `joinVoiceChannel` :

```js
const SHARD_READY = 3; // WebSocketShardStatus.Ready dans @discordjs/ws
const customAdapterCreator = (methods) => {
  client.voice.adapters.set(guild.id, methods);
  return {
    sendPayload: (data) => {
      const shard = guild.shard;
      if (!shard || shard.status !== SHARD_READY) return false;
      shard.send(data);
      return true;
    },
    destroy: () => client.voice.adapters.delete(guild.id),
  };
};
```

**Why:** Bug de compatibilité entre `discord.js 14.23+` et `@discordjs/ws 1.2+` — l'enum `Status` n'a pas été mis à jour pour correspondre aux nouvelles valeurs de `WebSocketShardStatus`.

**How to apply:** Remplacer `adapterCreator: voiceChannel.guild.voiceAdapterCreator` par `adapterCreator: customAdapterCreator` dans tout appel `joinVoiceChannel`. Valable tant que ce bug n'est pas corrigé dans discord.js.
