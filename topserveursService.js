const axios = require('axios');

async function fetchTopserveursRanking(url) {
  try {
    const response = await axios.get(url);
    const data = response.data;

    const players = [];
    for (const p of data.players || []) {
      players.push({
        playername: p.playername,
        votes: parseInt(p.votes || 0, 10),
      });
    }

    return players.sort((a, b) => b.votes - a.votes);
  } catch (error) {
    console.error('❌ Erreur lors de la récupération du classement TopServeurs:', error.message);
    return [];
  }
}

module.exports = { fetchTopserveursRanking };
