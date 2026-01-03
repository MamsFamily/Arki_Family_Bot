from utils import normalize_name

async def build_member_index(guild):
    index = {}
    async for m in guild.fetch_members(limit=None):
        for n in (m.display_name, m.name):
            key = normalize_name(n)
            index.setdefault(key, []).append(m.id)
    return index

def resolve_player(index, playername, aliases):
    key = normalize_name(aliases.get(playername, playername))
    ids = index.get(key, [])
    if len(ids) == 1:
        return ids[0]
    return None\n