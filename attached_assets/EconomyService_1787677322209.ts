import { db } from "../db/database";
import { logger } from "../core/logger";

export class EconomyService {
  async credit(
    userId: string,
    amount: number,
    reason: string,
    idempotencyKey: string
  ): Promise<boolean> {
    try {
      return await db.transaction(async () => {
        const existing = await db.queryOne(
          "SELECT id FROM economy_ledger WHERE idempotency_key = ?",
          [idempotencyKey]
        );
        if (existing) {
          logger.debug({ idempotencyKey }, "Duplicate idempotency key, skipping credit");
          return false;
        }

        await db.execute(
          "INSERT INTO wallets (user_id, balance) VALUES (?, 0) ON CONFLICT(user_id) DO NOTHING",
          [userId]
        );

        await db.execute(
          "UPDATE wallets SET balance = balance + ? WHERE user_id = ?",
          [amount, userId]
        );

        await db.execute(
          "INSERT INTO economy_ledger (user_id, amount, reason, idempotency_key) VALUES (?, ?, ?, ?)",
          [userId, amount, reason, idempotencyKey]
        );

        logger.info({ userId, amount, reason, idempotencyKey }, "Credited suns");
        return true;
      });
    } catch (err) {
      logger.error({ err, userId, amount, idempotencyKey }, "Failed to credit suns");
      throw err;
    }
  }

  async getBalance(userId: string): Promise<number> {
    const wallet = await db.queryOne<{ balance: number }>(
      "SELECT balance FROM wallets WHERE user_id = ?",
      [userId]
    );
    return wallet?.balance ?? 0;
  }

  async debit(
    userId: string,
    amount: number,
    reason: string,
    idempotencyKey: string
  ): Promise<boolean> {
    // Lecture + débit dans la même transaction pour éviter le double-spend
    return db.transaction(async () => {
      const wallet = await db.queryOne<{ balance: number }>(
        "SELECT balance FROM wallets WHERE user_id = ?",
        [userId]
      );
      const balance = wallet?.balance ?? 0;
      if (balance < amount) return false;
      return this.credit(userId, -amount, reason, idempotencyKey);
    });
  }
}

export class TestEconomyService extends EconomyService {
  async credit(
    userId: string,
    amount: number,
    reason: string,
    idempotencyKey: string
  ): Promise<boolean> {
    logger.info(
      { userId, amount, reason, idempotencyKey, mode: "TEST" },
      "[TEST MODE] Would credit suns — no real credit applied"
    );
    return true;
  }
}

export const economyService = new EconomyService();
