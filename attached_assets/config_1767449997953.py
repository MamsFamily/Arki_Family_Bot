import os, json

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN", "")

GUILD_ID = int(os.getenv("GUILD_ID", "1156256997403000874"))
RESULTS_CHANNEL_ID = int(os.getenv("RESULTS_CHANNEL_ID", "1157994586774442085"))
TOP_VOTER_ROLE_ID = int(os.getenv("TOP_VOTER_ROLE_ID", "1180440383784759346"))

TOPSERVEURS_RANKING_URL = os.getenv(
    "TOPSERVEURS_RANKING_URL",
    "https://api.top-serveurs.net/v1/servers/4ROMAU33GJTY/players-ranking?type=lastMonth"
)

TIMEZONE = os.getenv("TIMEZONE", "Europe/Paris")
DIAMONDS_PER_VOTE = 100

TOP_LOTS = {
    1: {"🦖": 6, "🎨": 6, "3️⃣": 1, "🍓": 15000, "💎": 15000},
    2: {"🦖": 4, "🎨": 4, "2️⃣": 1, "🍓": 10000, "💎": 10000},
    3: {"🦖": 2, "🎨": 2, "1️⃣": 1, "🍓": 5000, "💎": 5000},
}

TOP_DIAMONDS = {4: 4000, 5: 3000}

STYLE = {
    "everyone_ping": True,
    "logo": "<a:Logo:1313979016973127730>",
    "fireworks": "<a:fireworks:1388428854078476339>",
    "arrow": "<a:arrow:1388432394574368800>",
    "anime_arrow": "<a:animearrow:1157234686200922152>",
    "sparkly": "<a:SparklyCrystal:1366174439003263087>",
    "memo_url": "https://discord.com/channels/1156256997403000874/1157994473716973629/1367513646158319637",
    "place_icons": [
        "<:icon_place_1:1120819097916149911>",
        "<:icon_place_2:1120819117197365299>",
        "<:icon_place_3:1120819143659233452>",
        "<:icon_place_4:1120819164119040151>",
        "<:icon_place_5:1120819191650451598>",
    ],
}

DRAFTBOT_TEMPLATE = "/admininventaire donner membre:{mention} objet:\"{item}\" quantité:{qty}"

ALIASES = {}\n