import { describe, expect, it } from "vitest";
import { retryDelayMs } from "../src/ingestion/embeddings.js";

const res = (status: number, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers) });

describe("retryDelayMs", () => {
  it("honors Retry-After in seconds", () => {
    expect(retryDelayMs(res(429, { "retry-after": "12" }), 1)).toBe(12000);
  });

  it("backs off 5s, 10s, 20s on a 429 without Retry-After, enough to clear a per-minute limit", () => {
    expect([1, 2, 3].map((a) => retryDelayMs(res(429), a))).toEqual([5000, 10000, 20000]);
  });

  it("keeps the short backoff for 5xx", () => {
    expect(retryDelayMs(res(503), 1)).toBe(1000);
  });
});
