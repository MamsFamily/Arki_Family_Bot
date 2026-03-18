const axios = require('axios');

const NITRADO_API = 'https://api.nitrado.net';

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function fetchPlayerNames(serviceId) {
  try {
    const res = await axios.get(`${NITRADO_API}/services/${serviceId}/gameservers/games/players`, {
      headers: getHeaders(),
      timeout: 6000,
    });
    const raw = res.data?.data?.players;
    console.log(`[Nitrado] /games/players svc=${serviceId} raw:`, JSON.stringify(raw));

    let players = [];
    if (Array.isArray(raw)) {
      players = raw;
    } else if (raw && typeof raw === 'object') {
      // Certaines réponses Nitrado encapsulent un objet unique ou un dict { "0": {...}, "1": {...} }
      players = Object.values(raw);
    }

    return players
      .map(p => {
        if (typeof p === 'string') return p;
        return p.name || p.playername || p.player_name || p.playerName || p.username || null;
      })
      .filter(Boolean);
  } catch (err) {
    console.error(`[Nitrado] fetchPlayerNames svc=${serviceId} error:`, err.message);
    return [];
  }
}

async function fetchNitradoServers() {
  if (!process.env.NITRADO_TOKEN) return [];

  let services = [];
  try {
    const res = await axios.get(`${NITRADO_API}/services`, {
      headers: getHeaders(),
      timeout: 8000,
    });
    services = res.data?.data?.services || [];
  } catch (err) {
    console.error('Nitrado /services error:', err.message);
    return [];
  }

  const gameServices = services.filter(s =>
    s.type === 'gameserver' || s.type === 'gameserver_basic' || s.details?.type === 'gameserver'
  );

  const results = await Promise.allSettled(
    gameServices.map(async (svc) => {
      try {
        const res = await axios.get(`${NITRADO_API}/services/${svc.id}/gameservers`, {
          headers: getHeaders(),
          timeout: 8000,
        });
        const gs = res.data?.data?.gameserver;
        const isOnline = gs?.status === 'started';
        const playersOnline = gs?.query?.player_current ?? 0;

        let playerNames = [];
        if (isOnline && playersOnline > 0) {
          const fromQuery = gs?.query?.players;
          console.log(`[Nitrado] svc=${svc.id} query.players:`, JSON.stringify(fromQuery));
          if (fromQuery) {
            const arr = Array.isArray(fromQuery) ? fromQuery : Object.values(fromQuery);
            playerNames = arr
              .map(p => (typeof p === 'string' ? p : (p.name || p.playername || p.player_name || p.playerName || null)))
              .filter(Boolean);
          }
          if (playerNames.length === 0) {
            playerNames = await fetchPlayerNames(svc.id);
          }
        }

        return {
          id: svc.id,
          name: gs?.query?.server_name || svc.details?.name || `Serveur #${svc.id}`,
          game: gs?.game_human || gs?.game || svc.details?.game || 'ARK',
          status: gs?.status || 'unknown',
          playersOnline,
          playersMax: gs?.query?.player_max ?? 0,
          map: gs?.query?.map || gs?.settings?.general?.map || '',
          ip: gs?.ip || '',
          port: gs?.port || '',
          playerNames,
        };
      } catch (err) {
        return {
          id: svc.id,
          name: svc.details?.name || `Serveur #${svc.id}`,
          game: svc.details?.game || 'ARK',
          status: 'unknown',
          playersOnline: 0,
          playersMax: 0,
          map: '',
          ip: '',
          port: '',
          playerNames: [],
        };
      }
    })
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
}

module.exports = { fetchNitradoServers };
