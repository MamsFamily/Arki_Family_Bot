import sqlite3
from pathlib import Path

DB_PATH = Path("data/db/meta.sqlite")

def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute(
        """CREATE TABLE IF NOT EXISTS meta (
            guild_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (guild_id, key)
        )"""
    )
    con.commit()
    return con

def get_meta(con, guild_id, key):
    cur = con.cursor()
    cur.execute("SELECT value FROM meta WHERE guild_id=? AND key=?", (str(guild_id), key))
    row = cur.fetchone()
    return row[0] if row else None

def set_meta(con, guild_id, key, value):
    cur = con.cursor()
    cur.execute(
        """INSERT INTO meta (guild_id, key, value) VALUES (?, ?, ?)
           ON CONFLICT(guild_id, key) DO UPDATE SET value=excluded.value""",
        (str(guild_id), key, value),
    )
    con.commit()\n