// Guards for a public endpoint that spends real API budget on every
// question. Three independent limits:
//   - per-client: a sliding window per IP, to stop one visitor looping
//   - daily: a global cap per UTC day, the hard bound on spend
//   - concurrency: runs in flight at once, to protect the Voyage rate limit
// All state is in memory. That's fine for a single POC instance; a restart
// resets the counters, which is acceptable at this scope.

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

export class Limiter {
  private readonly hits = new Map<string, number[]>();
  private day = "";
  private dayCount = 0;
  private inFlight = 0;

  constructor(
    private readonly config: LimitConfig = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  // Checks every limit and, only if all pass, records the request and
  // reserves a concurrency slot. Callers must call release() when the run
  // ends, success or failure.
  acquire(clientId: string): LimitRejection | null {
    const t = this.now();
    const today = new Date(t).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.dayCount = 0;
    }

    if (this.inFlight >= this.config.maxConcurrent) return { reason: "busy", retryAfterSec: 10 };

    if (this.dayCount >= this.config.dailyMax) {
      const nextMidnight = Date.parse(`${today}T00:00:00Z`) + 24 * 60 * 60 * 1000;
      return { reason: "daily", retryAfterSec: Math.ceil((nextMidnight - t) / 1000) };
    }

    const windowStart = t - this.config.perClientWindowMs;
    const recent = (this.hits.get(clientId) ?? []).filter((h) => h > windowStart);
    if (recent.length >= this.config.perClientMax) {
      this.hits.set(clientId, recent);
      return { reason: "client", retryAfterSec: Math.ceil((recent[0]! + this.config.perClientWindowMs - t) / 1000) };
    }

    recent.push(t);
    this.hits.set(clientId, recent);
    this.dayCount += 1;
    this.inFlight += 1;
    this.prune(windowStart);
    return null;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  // Drops clients with no hits in the window so the map doesn't grow
  // without bound over a long-running process.
  private prune(windowStart: number): void {
    for (const [id, times] of this.hits) {
      if (times.every((h) => h <= windowStart)) this.hits.delete(id);
    }
  }
}
