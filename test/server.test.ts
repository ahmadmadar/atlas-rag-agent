import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError, type AgentResult } from "../src/agent/agent.js";
import { MAX_QUESTION_CHARS, createApp, type AskEvent, type GetSection, type RunAgent } from "../src/http/app.js";
import { SectionNotFoundError } from "../src/tools/get_document_section.js";
import { Limiter, memoryDailyCounter, type DailyCounter, type LimitConfig } from "../src/http/limits.js";

const loose: LimitConfig = { perClientMax: 100, perClientWindowMs: 60_000, dailyMax: 100, maxConcurrent: 10 };

function fakeResult(question: string): AgentResult {
  return {
    question,
    answer: "Up to $5M TIV [uw-guidelines-cp-v3 §2.2].",
    status: "answered",
    citations: [{ documentId: "uw-guidelines-cp-v3", section: "2.2" }],
    ungroundedCitations: [],
    grounded: true,
    roundsUsed: 1,
    capReached: false,
    trace: [{ round: 1, toolCalls: [] }],
    messages: [{ role: "user", content: question }],
    servedModels: ["claude-sonnet-5"],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

const oneRound: RunAgent = async (question, deps) => {
  deps?.onRound?.({ round: 1, toolCalls: [{ name: "search_knowledge_base", input: { query: "x" }, retrieved: [] }] });
  return fakeResult(question);
};

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

const noSection: GetSection = async () => {
  throw new Error("not stubbed");
};

async function start(runAgent: RunAgent, limiter = new Limiter(memoryDailyCounter(), loose), logs: unknown[] = [], getSection = noSection): Promise<string> {
  server = createServer(createApp({ runAgent, limiter, getSection, log: (m, e) => logs.push([m, e]) }));
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  return `http://localhost:${(server!.address() as AddressInfo).port}`;
}

function ask(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function events(res: Response): Promise<AskEvent[]> {
  return (await res.text()).trim().split("\n").map((line) => JSON.parse(line) as AskEvent);
}

describe("HTTP app", () => {
  it("streams each round, then the result without internal fields", async () => {
    const base = await start(oneRound);
    const res = await ask(base, { question: "What can a field underwriter bind?" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/ndjson/);
    const [round, result] = await events(res);
    expect(round).toMatchObject({ type: "round", round: { round: 1 } });
    expect(result!.type).toBe("result");
    const payload = (result as Extract<AskEvent, { type: "result" }>).result;
    expect(payload).toMatchObject({ status: "answered", grounded: true, roundsUsed: 1 });
    expect(payload).not.toHaveProperty("messages");
    expect(payload).not.toHaveProperty("usage");
    expect(typeof payload.elapsedMs).toBe("number");
  });

  it("rejects empty, oversized, and malformed questions before running the agent", async () => {
    let runs = 0;
    const base = await start(async (q, d) => (runs++, oneRound(q, d)));

    expect((await ask(base, { question: "   " })).status).toBe(400);
    expect((await ask(base, { question: "x".repeat(MAX_QUESTION_CHARS + 1) })).status).toBe(400);
    expect((await ask(base, "not json")).status).toBe(400);
    expect((await ask(base, JSON.stringify({ question: "x".repeat(5000) }))).status).toBe(413);
    expect(runs).toBe(0);
  });

  it("returns 429 with Retry-After once a client is over its limit", async () => {
    const base = await start(oneRound, new Limiter(memoryDailyCounter(), { ...loose, perClientMax: 1 }));
    const headers = { "X-Forwarded-For": "203.0.113.7" };

    expect((await ask(base, { question: "q" }, headers)).status).toBe(200);
    const limited = await ask(base, { question: "q" }, headers);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // A different client is unaffected.
    expect((await ask(base, { question: "q" }, { "X-Forwarded-For": "198.51.100.1" })).status).toBe(200);
  });

  it("shows AgentError messages but hides other failures", async () => {
    const logs: unknown[] = [];
    let fail: Error = new AgentError("The model declined to answer this question.");
    const base = await start(async () => {
      throw fail;
    }, undefined, logs);

    const [declined] = await events(await ask(base, { question: "q" }));
    expect(declined).toEqual({ type: "error", message: "The model declined to answer this question." });

    fail = new Error("connect ECONNREFUSED 10.0.0.5:5432");
    const [hidden] = await events(await ask(base, { question: "q" }));
    expect(hidden!.type).toBe("error");
    expect(JSON.stringify(hidden)).not.toContain("ECONNREFUSED");
    expect(logs).toHaveLength(2);
  });

  it("refuses with 503 instead of running uncapped when the daily count is unavailable", async () => {
    let runs = 0;
    const down: DailyCounter = { tryIncrement: async () => Promise.reject(new Error("db down")) };
    const base = await start(async (q, d) => (runs++, oneRound(q, d)), new Limiter(down, loose));
    const res = await ask(base, { question: "q" });
    expect(res.status).toBe(503);
    expect(runs).toBe(0);
  });

  it("releases the concurrency slot after a failed run", async () => {
    const base = await start(async () => {
      throw new Error("boom");
    }, new Limiter(memoryDailyCounter(), { ...loose, maxConcurrent: 1 }));

    await (await ask(base, { question: "q" })).text();
    expect((await ask(base, { question: "q" })).status).toBe(200);
  });

  it("replaces tool error detail in the streamed trace with a generic message, and logs it", async () => {
    const logs: unknown[] = [];
    const base = await start(async (q, d) => {
      const round = { round: 1, toolCalls: [{ name: "search_knowledge_base", input: {}, retrieved: [], error: "connect ECONNREFUSED 10.0.0.5:5432" }] };
      d?.onRound?.(round);
      return { ...fakeResult(q), trace: [round] };
    }, undefined, logs);
    const body = await (await ask(base, { question: "q" })).text();
    expect(body).not.toContain("ECONNREFUSED");
    expect(body).toContain("lookup returned an error");
    expect(JSON.stringify(logs)).toContain("ECONNREFUSED");
  });

  it("serves the page with a strict CSP from a fixed file list", async () => {
    const base = await start(oneRound);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await page.text()).toContain("<title>Atlas Policy Assistant</title>");
    expect((await fetch(`${base}/app.js`)).headers.get("content-type")).toMatch(/javascript/);
    expect((await fetch(`${base}/..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/index.html`)).status).toBe(404);
  });

  it("returns cited section text, 404s unknown sections, and 400s missing params", async () => {
    const getSection: GetSection = async ({ document_id, section }) => {
      if (section === "9") throw new SectionNotFoundError(`No section "9" in ${document_id}.`);
      return { result: { sections: [{ documentId: document_id, section, content: "text" }] }, retrieved: [] };
    };
    const base = await start(oneRound, undefined, [], getSection);

    const ok = await fetch(`${base}/api/section?document_id=uw-guidelines-cp-v3&section=2.2`);
    expect(await ok.json()).toEqual({ sections: [{ documentId: "uw-guidelines-cp-v3", section: "2.2", content: "text" }] });
    expect((await fetch(`${base}/api/section?document_id=uw-guidelines-cp-v3&section=9`)).status).toBe(404);
    expect((await fetch(`${base}/api/section?document_id=uw-guidelines-cp-v3`)).status).toBe(400);
  });

  it("serves health and 404s, and only accepts POST on /api/ask", async () => {
    const base = await start(oneRound);
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/ask`)).status).toBe(405);
  });
});

describe("Limiter", () => {
  it("doesn't charge a visitor's quota for a question the daily cap refused", async () => {
    const limiter = new Limiter(memoryDailyCounter(), { ...loose, perClientMax: 1, dailyMax: 0 });
    expect(await limiter.acquire("a")).toMatchObject({ reason: "daily" });
    expect(await limiter.acquire("a")).toMatchObject({ reason: "daily" });
  });

  it("frees the slot and rethrows when the daily count can't be read", async () => {
    const down: DailyCounter = { tryIncrement: async () => Promise.reject(new Error("db down")) };
    const limiter = new Limiter(down, { ...loose, maxConcurrent: 1 });
    await expect(limiter.acquire("a")).rejects.toThrow("db down");
    await expect(limiter.acquire("a")).rejects.toThrow("db down"); // not "busy": the slot was released
  });

  it("enforces the per-client sliding window", async () => {
    let t = 0;
    const limiter = new Limiter(memoryDailyCounter(), { ...loose, perClientMax: 2, perClientWindowMs: 1000 }, () => t);
    expect(await limiter.acquire("a")).toBeNull();
    limiter.release();
    expect(await limiter.acquire("a")).toBeNull();
    limiter.release();
    expect(await limiter.acquire("a")).toMatchObject({ reason: "client", retryAfterSec: 1 });
    t = 1001;
    expect(await limiter.acquire("a")).toBeNull();
  });

  it("enforces the daily cap across clients and resets at UTC midnight", async () => {
    let t = Date.parse("2026-09-29T23:59:00Z");
    const limiter = new Limiter(memoryDailyCounter(), { ...loose, dailyMax: 2 }, () => t);
    expect(await limiter.acquire("a")).toBeNull();
    expect(await limiter.acquire("b")).toBeNull();
    limiter.release();
    limiter.release();
    expect(await limiter.acquire("c")).toEqual({ reason: "daily", retryAfterSec: 60 });
    t = Date.parse("2026-09-30T00:00:01Z");
    expect(await limiter.acquire("c")).toBeNull();
  });

  it("rejects when too many runs are in flight, without spending quota", async () => {
    const limiter = new Limiter(memoryDailyCounter(), { ...loose, maxConcurrent: 1, dailyMax: 2 });
    expect(await limiter.acquire("a")).toBeNull();
    expect(await limiter.acquire("b")).toMatchObject({ reason: "busy" });
    limiter.release();
    expect(await limiter.acquire("b")).toBeNull();
  });
});
