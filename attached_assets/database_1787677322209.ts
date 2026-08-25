import { SQLiteDB } from "./sqlite-adapter";
import { PostgreSQLDB } from "./pg-adapter";
import type { DB } from "./types";
import path from "path";
import { logger } from "../core/logger";

// ─────────────────────────────────────────────
// Factory : PostgreSQL si DATABASE_URL, sinon SQLite
// ─────────────────────────────────────────────
function createDB(): DB {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    logger.info("Using PostgreSQL database");
    return new PostgreSQLDB(dbUrl);
  }
  const dbPath = path.join(process.cwd(), "data", "arki_family.db");
  logger.info({ dbPath }, "Using SQLite database (local dev)");
  return new SQLiteDB(dbPath);
}

export const db: DB = createDB();

// ─────────────────────────────────────────────
// Schéma — compatible SQLite et PostgreSQL
// ─────────────────────────────────────────────
const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS economy_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_teams (
  user_id TEXT PRIMARY KEY,
  team_role_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  manche INTEGER NOT NULL,
  game_key TEXT NOT NULL,
  status TEXT NOT NULL,
  state_json TEXT NOT NULL,
  score INTEGER,
  suns_awarded INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS olympiad_daily_results (
  date TEXT NOT NULL,
  team_role_id TEXT NOT NULL,
  manche_1_points INTEGER NOT NULL DEFAULT 0,
  manche_2_points INTEGER NOT NULL DEFAULT 0,
  manche_3_points INTEGER NOT NULL DEFAULT 0,
  total_points INTEGER NOT NULL DEFAULT 0,
  daily_rank INTEGER,
  general_points_awarded INTEGER,
  PRIMARY KEY(date, team_role_id)
);

CREATE TABLE IF NOT EXISTS olympiad_daily_participants (
  date TEXT NOT NULL,
  user_id TEXT NOT NULL,
  team_role_id TEXT NOT NULL DEFAULT '',
  completed_manches INTEGER NOT NULL DEFAULT 0,
  daily_bonus_awarded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(date, user_id)
);

CREATE TABLE IF NOT EXISTS cooldowns (
  key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  cooldown_type TEXT NOT NULL,
  available_at TEXT NOT NULL,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS weather_days (
  date TEXT PRIMARY KEY,
  weather TEXT NOT NULL,
  multiplier REAL NOT NULL,
  selected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_events (
  id TEXT PRIMARY KEY,
  unique_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  run_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS live_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  state_json TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  opened_at TEXT NOT NULL,
  closes_at TEXT
);

CREATE TABLE IF NOT EXISTS riddle_history (
  riddle_id INTEGER NOT NULL,
  cycle INTEGER NOT NULL,
  used_at TEXT NOT NULL,
  event_id TEXT NOT NULL,
  winner_user_id TEXT,
  PRIMARY KEY(cycle, riddle_id)
);

CREATE TABLE IF NOT EXISTS emoji_claims (
  event_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  user_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY(event_id, emoji),
  UNIQUE(event_id, user_id)
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS community_days (
  day INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  active_date TEXT,
  status TEXT NOT NULL DEFAULT 'LOCKED',
  completed_at TEXT,
  reward_tier TEXT
);

CREATE TABLE IF NOT EXISTS community_resource_defs (
  day INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  name TEXT,
  target_amount INTEGER,
  PRIMARY KEY(day, slot)
);

CREATE TABLE IF NOT EXISTS community_progress (
  day INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  deposited_amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, slot)
);

CREATE TABLE IF NOT EXISTS community_player_inventory (
  user_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, day, slot)
);

CREATE TABLE IF NOT EXISTS community_contributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS community_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL,
  initiator_user_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS community_reward_ledger (
  day INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  reward INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(day, user_id)
);

CREATE TABLE IF NOT EXISTS community_assets (
  day INTEGER NOT NULL,
  asset_type TEXT NOT NULL,
  asset_path TEXT,
  PRIMARY KEY(day, asset_type)
);
`;

export async function initDatabase(): Promise<void> {
  logger.info("Initializing database schema...");
  await db.execRaw(SCHEMA);

  // Migrations additionnelles — ignorées si la colonne existe déjà
  const migrations = [
    // Ajout tribe_tag pour l'auto-assignation d'équipe aux Olympiades
    "ALTER TABLE user_teams ADD COLUMN tribe_tag TEXT",
    // Récupération : si une migration précédente a renommé value_json → value par erreur,
    // on restaure le nom original. Silencieux si la colonne est déjà value_json.
    "ALTER TABLE bot_config RENAME COLUMN value TO value_json",
  ];
  for (const m of migrations) {
    try {
      await db.execRaw(m);
    } catch {
      // Colonne déjà présente — normal sur une base existante
    }
  }

  logger.info("Database schema ready");
}
