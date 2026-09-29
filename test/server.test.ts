import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError, type AgentResult } from "../src/agent/agent.js";
import { MAX_QUESTION_CHARS, createApp, type AskEvent, type RunAgent } from "../src/http/app.js";
import { Limiter, type LimitConfig } from "../src/http/limits.js";

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

async function start(runAgent: RunAgent, limiter = new Limiter(loose), logs: unknown[] = []): Promise<string> {
  server = createServer(createApp({ runAgent, limiter, log: (m, e) => logs.push([m, e]) }));
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
    const base = await start(oneRound, new Limiter({ ...loose, perClientMax: 1 }));
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

  it("releases the concurrency slot after a failed run", async () => {
    const base = await start(async () => {
      throw new Error("boom");
    }, new Limiter({ ...loose, maxConcurrent: 1 }));

    await (await ask(base, { question: "q" })).text();
    expect((await ask(base, { question: "q" })).status).toBe(200);
  });

  it("serves health and 404s, and only accepts POST on /api/ask", async () => {
    const base = await start(oneRound);
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/ask`)).status).toBe(405);
  });
});

describe("Limiter", () => {
  it("enforces the per-client sliding window", () => {
    let t = 0;
    const limiter = new Limiter({ ...loose, perClientMax: 2, perClientWindowMs: 1000 }, () => t);
    expect(limiter.acquire("a")).toBeNull();
    limiter.release();
    expect(limiter.acquire("a")).toBeNull();
    limiter.release();
    expect(limiter.acquire("a")).toMatchObject({ reason: "client", retryAfterSec: 1 });
    t = 1001;
    expect(limiter.acquire("a")).toBeNull();
  });

  it("enforces the daily cap across clients and resets at UTC midnight", () => {
    let t = Date.parse("2026-09-29T23:59:00Z");
    const limiter = new Limiter({ ...loose, dailyMax: 2 }, () => t);
    expect(limiter.acquire("a")).toBeNull();
    expect(limiter.acquire("b")).toBeNull();
    limiter.release();
    limiter.release();
    expect(limiter.acquire("c")).toEqual({ reason: "daily", retryAfterSec: 60 });
    t = Date.parse("2026-09-30T00:00:01Z");
    expect(limiter.acquire("c")).toBeNull();
  });

  it("rejects when too many runs are in flight, without spending quota", () => {
    const limiter = new Limiter({ ...loose, maxConcurrent: 1, dailyMax: 2 });
    expect(limiter.acquire("a")).toBeNull();
    expect(limiter.acquire("b")).toMatchObject({ reason: "busy" });
    limiter.release();
    expect(limiter.acquire("b")).toBeNull();
  });
});
