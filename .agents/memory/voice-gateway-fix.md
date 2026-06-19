---
name: Voice gateway fix - Discord.js v14 signalling timeout
description: Bug Discord.js v14 — connexion vocale bloquée en signalling à cause d'un check cache membre raté.
---

## Le problème

`@discordjs/voice` reste bloqué en `signalling` indéfiniment même avec `GuildVoiceStates` intent déclaré.

## Cause

Dans `discord.js/src/client/actions/VoiceStateUpdate.js`, l'appel à `client.voice.onVoiceStateUpdate(data)` est conditionné par :
```js
if (member?.user.id === client.user.id) {
  client.voice.onVoiceStateUpdate(data);
}
```
Si `member` n'est pas dans le cache au moment où le `VOICE_STATE_UPDATE` arrive, le payload n'est jamais transmis à `@discordjs/voice`.

## Fix (dans index.js, après création du client)

```js
client.on('raw', (packet) => {
  if (packet.t === 'VOICE_STATE_UPDATE' && packet.d?.user_id === client.user?.id) {
    client.voice?.onVoiceStateUpdate?.(packet.d);
  }
});
```

**Why:** Court-circuite la vérification cache membre et transmet directement le payload vocal au voice manager.

**How to apply:** À ajouter une seule fois après `new Client(...)`, avant `client.once('clientReady', ...)`. Inoffensif si appelé deux fois (idempotent).
