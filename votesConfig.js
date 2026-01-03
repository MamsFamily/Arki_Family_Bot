const GUILD_ID = process.env.GUILD_ID || '1156256997403000874';
const RESULTS_CHANNEL_ID = process.env.RESULTS_CHANNEL_ID || '1157994586774442085';
const ADMIN_LOG_CHANNEL_ID = process.env.ADMIN_LOG_CHANNEL_ID || '1435434740306935959';
const TOP_VOTER_ROLE_ID = process.env.TOP_VOTER_ROLE_ID || '1180440383784759346';

const TOPSERVEURS_RANKING_URL = process.env.TOPSERVEURS_RANKING_URL || 
  'https://api.top-serveurs.net/v1/servers/4ROMAU33GJTY/players-ranking?type=lastMonth';

const TIMEZONE = process.env.TIMEZONE || 'Europe/Paris';
const DIAMONDS_PER_VOTE = 100;
const VOTES_PER_REWARD_DISPLAY = 10;
const DIAMONDS_PER_REWARD_DISPLAY = 1000;

const TOP_LOTS = {
  1: { '🦖': 6, '🎨': 6, '3️⃣': 1, '🍓': 15000, '💎': 15000 },
  2: { '🦖': 4, '🎨': 4, '2️⃣': 1, '🍓': 10000, '💎': 10000 },
  3: { '🦖': 2, '🎨': 2, '1️⃣': 1, '🍓': 5000, '💎': 5000 },
};

const TOP_DIAMONDS = { 4: 4000, 5: 3000 };

const STYLE = {
  everyonePing: true,
  logo: '<a:Logo:1313979016973127730>',
  fireworks: '<a:fireworks:1388428854078476339>',
  arrow: '<a:arrow:1388432394574368800>',
  animeArrow: '<a:animearrow:1157234686200922152>',
  sparkly: '<a:SparklyCrystal:1366174439003263087>',
  memoUrl: 'https://discord.com/channels/1156256997403000874/1157994573716973629/1367513646158319637',
  placeIcons: [
    '<:icon_place_1:1120819097916149911>',
    '<:icon_place_2:1120819117197365299>',
    '<:icon_place_3:1120819143659233452>',
    '<:icon_place_4:1120819164119040151>',
    '<:icon_place_5:1120819191650451598>',
  ],
};

const DRAFTBOT_TEMPLATE = '/admininventaire donner membre:{mention} objet:"{item}" quantité:{qty}';

const MONTHS_FR = [
  'JANVIER', 'FÉVRIER', 'MARS', 'AVRIL', 'MAI', 'JUIN',
  'JUILLET', 'AOÛT', 'SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE', 'DÉCEMBRE'
];

const ALIASES = {};

module.exports = {
  GUILD_ID,
  RESULTS_CHANNEL_ID,
  ADMIN_LOG_CHANNEL_ID,
  TOP_VOTER_ROLE_ID,
  TOPSERVEURS_RANKING_URL,
  TIMEZONE,
  DIAMONDS_PER_VOTE,
  VOTES_PER_REWARD_DISPLAY,
  DIAMONDS_PER_REWARD_DISPLAY,
  TOP_LOTS,
  TOP_DIAMONDS,
  STYLE,
  DRAFTBOT_TEMPLATE,
  MONTHS_FR,
  ALIASES,
};
