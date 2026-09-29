import type { PrismaClient } from "@prisma/client";

// Guards for a public endpoint that spends real API budget on every
// question. Three independent limits:
//   - per-client: a sliding window per IP, to stop one visitor looping
//   - daily: a global cap per UTC day, the hard bound on spend
//   - concurrency: runs in flight at once, to protect the Voyage rate limit
// The daily count lives in Postgres: the free Render instance sleeps when
// idle, and an in-memory count would reset on every wake. The other two are
// in memory, where losing them on a restart is harmless.

export interface LimitConfig {
  perClientMax: number;
  perClientWindowMs: number;
  dailyMax: number;
  maxConcurrent: number;
}

// About $0.03 per question at current usage, so the daily cap bounds spend
// at roughly $3/day even if every limit below it is bypassed.
export const DEFAULT_LIMITS: LimitConfig = {
  perClientMax: 5,
  perClientWindowMs: 10 * 60 * 1000,
  dailyMax: 100,
  maxConcurrent: 2,
};

export type LimitRejection =
  | { reason: "client"; retryAfterSec: number }
  | { reason: "daily"; retryAfterSec: number }
  | { reason: "busy"; retryAfterSec: number };

// Records one question against the day's count if the count is below max.
// Returns false, recording nothing, once the day is at the cap. Must be
// atomic: concurrent calls can't both take the last slot.
export interface DailyCounter {
  tryIncrement(day: string, max: number): Promise<boolean>;
}

// One statement, so the check and the increment can't interleave with
// another request's. A new day inserts count 1; an existing day increments
// only while below max. No row back means the cap was reached.
export function prismaDailyCounter(prisma: () => PrismaClient): DailyCounter {
  return {
    async tryIncrement(day, max) {
      const rows = await prisma().$queryRaw<{ count: number }[]>`
        INSERT INTO "DailyUsage" ("day", "count") VALUES (${day}, 1)
        ON CONFLICT ("day") DO UPDATE SET "count" = "DailyUsage"."count" + 1
        WHERE "DailyUsage"."count" < ${max}
        RETURNING "count"`;
      return rows.length > 0;
    },
  };
}

export function memoryDailyCounter(): DailyCounter {
  const counts = new Map<string, number>();
  return {
    async tryIncrement(day, max) {
      const n = counts.get(day) ?? 0;
      if (n >= max) return false;
      counts.set(day, n + 1);
      return true;
    },
  };
}

export class Limiter {
  private readonly hits = new Map<string, number[]>();
  private inFlight = 0;

  constructor(
    private readonly daily: DailyCounter,
    private readonly config: LimitConfig = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  // Checks every limit and, only if all pass, records the request and
  // holds a concurrency slot. Callers must call release() when the run
  // ends, success or failure. Throws if the daily count can't be read,
  // so a database outage refuses questions rather than lifting the cap.
  async acquire(clientId: string): Promise<LimitRejection | null> {
    const t = this.now();
    if (this.inFlight >= this.config.maxConcurrent) return { reason: "busy", retryAfterSec: 10 };

    const windowStart = t - this.config.perClientWindowMs;
    const recent = (this.hits.get(clientId) ?? []).filter((h) => h > windowStart);
    this.hits.set(clientId, recent);
    if (recent.length >= this.config.perClientMax) {
      return { reason: "client", retryAfterSec: Math.ceil((recent[0]! + this.config.perClientWindowMs - t) / 1000) };
    }

    // Reserve the slot and the client's hit before awaiting the database,
    // so requests arriving meanwhile see them. Undone if the day is full.
    this.inFlight += 1;
    recent.push(t);
    let allowed: boolean;
    try {
      allowed = await this.daily.tryIncrement(utcDay(t), this.config.dailyMax);
    } catch (err) {
      this.undo(clientId, t);
      throw err;
    }
    if (!allowed) {
      this.undo(clientId, t);
      const nextMidnight = Date.parse(`${utcDay(t)}T00:00:00Z`) + 24 * 60 * 60 * 1000;
      return { reason: "daily", retryAfterSec: Math.ceil((nextMidnight - t) / 1000) };
    }
    this.prune(windowStart);
    return null;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  private undo(clientId: string, t: number): void {
    this.release();
    const recent = this.hits.get(clientId);
    const i = recent?.lastIndexOf(t) ?? -1;
    if (i >= 0) recent!.splice(i, 1);
  }

  // Drops clients with no hits in the window so the map doesn't grow
  // without bound over a long-running process.
  private prune(windowStart: number): void {
    for (const [id, times] of this.hits) {
      if (times.every((h) => h <= windowStart)) this.hits.delete(id);
    }
  }
}

function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}
