import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { z } from "zod";
import { AgentError, runAgent as defaultRunAgent, type AgentDeps, type AgentResult, type RoundTrace } from "../agent/agent.js";
import { Limiter, type LimitRejection } from "./limits.js";

export const MAX_QUESTION_CHARS = 500;
const MAX_BODY_BYTES = 4 * 1024;

const AskBody = z.object({ question: z.string().trim().min(1).max(MAX_QUESTION_CHARS) });

export type RunAgent = (question: string, deps?: AgentDeps) => Promise<AgentResult>;

export interface AppDeps {
  runAgent?: RunAgent;
  limiter?: Limiter;
  now?: () => number;
  log?: (message: string, err?: unknown) => void;
}

// What the browser gets. Drops the raw conversation and token usage, which
// are for evals, not visitors.
export type PublicResult = Omit<AgentResult, "messages" | "servedModels" | "usage"> & { elapsedMs: number };

// Streamed as newline-delimited JSON so the page can show each round as it
// finishes: a run takes several model turns and can run 15-20s.
export type AskEvent =
  | { type: "round"; round: RoundTrace }
  | { type: "result"; result: PublicResult }
  | { type: "error"; message: string };

const LIMIT_MESSAGES: Record<LimitRejection["reason"], string> = {
  client: "You've hit the per-visitor limit for this demo. Try again in a few minutes.",
  daily: "The demo has reached its daily question limit. Try again tomorrow.",
  busy: "The demo is busy answering other questions. Try again in a few seconds.",
};

export function createApp(deps: AppDeps = {}): RequestListener {
  const runAgent = deps.runAgent ?? defaultRunAgent;
  const limiter = deps.limiter ?? new Limiter();
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message, err) => console.error(message, err ?? ""));

  return async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    try {
      if (path === "/api/health" && req.method === "GET") return sendJson(res, 200, { ok: true });
      if (path === "/api/ask") {
        if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." }, { Allow: "POST" });
        return await handleAsk(req, res);
      }
      return sendJson(res, 404, { error: "Not found." });
    } catch (err) {
      log(`Unhandled error on ${req.method} ${path}`, err);
      if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong." });
      else res.end();
    }
  };

  async function handleAsk(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    if (raw === null) return sendJson(res, 413, { error: "Request body too large." });

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: "Body must be JSON: {\"question\": \"...\"}." });
    }
    const body = AskBody.safeParse(json);
    if (!body.success) {
      return sendJson(res, 400, { error: `Question is required and must be at most ${MAX_QUESTION_CHARS} characters.` });
    }

    const rejection = limiter.acquire(clientId(req));
    if (rejection) {
      const status = rejection.reason === "busy" ? 503 : 429;
      return sendJson(res, status, { error: LIMIT_MESSAGES[rejection.reason] }, { "Retry-After": String(rejection.retryAfterSec) });
    }

    const started = now();
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Stops reverse proxies from buffering the stream until the run ends.
      "X-Accel-Buffering": "no",
    });
    const send = (event: AskEvent) => res.write(`${JSON.stringify(event)}\n`);

    try {
      const result = await runAgent(body.data.question, { onRound: (round) => send({ type: "round", round }) });
      const { messages: _m, servedModels: _s, usage: _u, ...rest } = result;
      send({ type: "result", result: { ...rest, elapsedMs: now() - started } });
    } catch (err) {
      // AgentError messages describe the run ("the model declined") and are
      // safe to show. Anything else (database, Voyage, network) is logged
      // with detail and reported generically.
      log("Agent run failed", err);
      send({ type: "error", message: err instanceof AgentError ? err.message : "The agent hit an error answering this question. Try again." });
    } finally {
      limiter.release();
      res.end();
    }
  }
}

// Behind Render's proxy the socket address is the proxy's, so the client
// comes from X-Forwarded-For. A client can prepend fake entries to that
// header, which makes the per-client limit best-effort; the daily cap is the
// limit that actually bounds spend.
export function clientId(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

// Returns null if the body exceeds the limit, rather than buffering an
// arbitrarily large upload.
async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
