import aiohttp

async def fetch_topserveurs_ranking(url):
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as resp:
            data = await resp.json()

    players = []
    for p in data.get("players", []):
        players.append({
            "playername": p.get("playername"),
            "votes": int(p.get("votes", 0))
        })
    return sorted(players, key=lambda x: x["votes"], reverse=True)\n