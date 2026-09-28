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
  it("keeps the agent key out of the ingestion guard but requires it for the agent", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("VOYAGE_API_KEY", "k");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const { getEnv, getAgentEnv } = await import("../src/env.js");
    expect(() => getEnv()).not.toThrow();
    expect(() => getAgentEnv()).toThrow(/ANTHROPIC_API_KEY/);
  });
});
