const axios = require('axios');

const NITRADO_API = 'https://api.nitrado.net';

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function extractPlayerNames(raw) {
  if (!raw) return [];
  let players = [];
  if (Array.isArray(raw)) {
    players = raw;
  } else if (raw && typeof raw === 'object') {
    players = Object.values(raw);
  }
  return players
    .map(p => {
      if (typeof p === 'string') return p.trim() || null;
      if (typeof p !== 'object' || p === null) return null;
      return (
        p.name || p.Name ||
        p.playername || p.playerName || p.player_name ||
        p.username || p.Username ||
        p.steamName || p.steam_name ||
        p.charName || p.char_name || p.characterName ||
        null
      );
    })
    .map(n => (n && typeof n === 'string' ? n.trim() : null))
    .filter(Boolean);
}

async function fetchPlayerNamesViaApi(serviceId) {
  try {
    const res = await axios.get(`${NITRADO_API}/services/${serviceId}/gameservers/games/players`, {
      headers: getHeaders(),
      timeout: 7000,
    });
    const raw = res.data?.data?.players;
    console.log(`[Nitrado] /games/players svc=${serviceId}:`, JSON.stringify(raw));
    return extractPlayerNames(raw);
  } catch (err) {
    console.error(`[Nitrado] fetchPlayerNamesViaApi svc=${serviceId}:`, err.response?.status || err.message);
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
    console.error('[Nitrado] /services error:', err.response?.status || err.message);
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
          // Essai 1 : query.players (format le plus courant)
          const fromQuery = gs?.query?.players;
          console.log(`[Nitrado] svc=${svc.id} query.players:`, JSON.stringify(fromQuery));
          if (fromQuery) {
            playerNames = extractPlayerNames(fromQuery);
          }

          // Essai 2 : status.players (ARK SA parfois)
          if (playerNames.length === 0) {
            const fromStatus = gs?.status?.players || gs?.players;
            if (fromStatus) {
              console.log(`[Nitrado] svc=${svc.id} status/gs.players:`, JSON.stringify(fromStatus));
              playerNames = extractPlayerNames(fromStatus);
            }
          }

          // Essai 3 : endpoint dédié /games/players
          if (playerNames.length === 0) {
            playerNames = await fetchPlayerNamesViaApi(svc.id);
          }
        }

        const mapRaw = gs?.query?.map || gs?.settings?.general?.map || gs?.settings?.map || '';
        const mapName = mapRaw
          .replace(/_WP$/i, '')
          .replace(/_P$/i, '')
          .replace(/^Athena$/i, 'Lost Island')
          .trim();

        return {
          id: svc.id,
          name: gs?.query?.server_name || svc.details?.name || `Serveur #${svc.id}`,
          game: gs?.game_human || gs?.game || svc.details?.game || 'ARK',
          status: gs?.status || 'unknown',
          playersOnline,
          playersMax: gs?.query?.player_max ?? 0,
          map: mapName,
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
