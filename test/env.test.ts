import { afterEach, describe, expect, it, vi } from "vitest";

describe("getEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("fails closed when a required variable is empty", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("VOYAGE_API_KEY", "");
    const { getEnv } = await import("../src/env.js");
    expect(() => getEnv()).toThrow(/VOYAGE_API_KEY/);
  });

  it("returns values when everything is set", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("VOYAGE_API_KEY", "k");
    const { getEnv } = await import("../src/env.js");
    expect(getEnv().VOYAGE_API_KEY).toBe("k");
  });
});
