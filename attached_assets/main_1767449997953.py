import discord
from discord.ext import commands

import config
from db import init_db
from cogs.monthly_votes import MonthlyVotes

INTENTS = discord.Intents.default()
INTENTS.members = True  # IMPORTANT pour auto-link

class ArkiVotesBot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix="!", intents=INTENTS, help_command=None)

    async def setup_hook(self):
        await self.tree.sync(guild=discord.Object(id=config.GUILD_ID))

async def main():
    if not config.DISCORD_TOKEN:
        raise RuntimeError("DISCORD_TOKEN manquant")

    con = init_db()
    bot = ArkiVotesBot()
    bot.add_cog(MonthlyVotes(bot, con))

    async with bot:
        await bot.start(config.DISCORD_TOKEN)

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())\n