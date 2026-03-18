const axios = require('axios');

const NITRADO_API = 'https://api.nitrado.net';

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.NITRADO_TOKEN}`,
    'Content-Type': 'application/json',
  };
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
        return {
          id: svc.id,
          name: gs?.query?.server_name || svc.details?.name || `Serveur #${svc.id}`,
          game: gs?.game_human || gs?.game || svc.details?.game || 'ARK',
          status: gs?.status || 'unknown',
          playersOnline: gs?.query?.player_current ?? 0,
          playersMax: gs?.query?.player_max ?? 0,
          map: gs?.query?.map || gs?.settings?.general?.map || '',
          ip: gs?.ip || '',
          port: gs?.port || '',
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
        };
      }
    })
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
}

module.exports = { fetchNitradoServers };
