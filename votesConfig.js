const { getSettings } = require('./settingsManager');

function getVotesConfig() {
  const s = getSettings();
  return {
    GUILD_ID: s.guild.guildId,
    RESULTS_CHANNEL_ID: s.guild.resultsChannelId,
    ADMIN_LOG_CHANNEL_ID: s.guild.adminLogChannelId,
    TOP_VOTER_ROLE_ID: s.guild.topVoterRoleId,
    MODO_ROLE_ID: s.guild.modoRoleId,
    TOPSERVEURS_RANKING_URL: s.api.topserveursRankingUrl,
    TIMEZONE: s.api.timezone,
    DIAMONDS_PER_VOTE: s.rewards.diamondsPerVote,
    VOTES_PER_REWARD_DISPLAY: 10,
    DIAMONDS_PER_REWARD_DISPLAY: 1000,
    TOP_LOTS: s.rewards.topLots,
    TOP_DIAMONDS: s.rewards.topDiamonds,
    VOTE_PACK_IDS: s.rewards.votePackIds || { 1: '', 2: '', 3: '', 4: '', 5: '' },
    STYLE: {
      everyonePing: s.style.everyonePing,
      logo: s.style.logo,
      logoFallback: '🎮',
      fireworks: s.style.fireworks,
      fireworksFallback: '🎆',
      arrow: s.style.arrow,
      arrowFallback: '➡️',
      animeArrow: s.style.animeArrow,
      animeArrowFallback: '▶️',
      sparkly: s.style.sparkly,
      sparklyFallback: '💎',
      memoUrl: s.style.memoUrl,
      placeIcons: ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'],
      placeIconsFallback: ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'],
    },
    MESSAGE: s.message,
    DRAFTBOT_TEMPLATE: '/admininventaire donner membre:{mention} objet:"{item}" quantité:{qty}',
    MONTHS_FR: [
      'JANVIER', 'FÉVRIER', 'MARS', 'AVRIL', 'MAI', 'JUIN',
      'JUILLET', 'AOÛT', 'SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE', 'DÉCEMBRE'
    ],
    ALIASES: s.aliases,
  };
}

module.exports = { getVotesConfig };
