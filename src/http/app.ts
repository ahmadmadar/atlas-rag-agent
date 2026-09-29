import { readFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { z } from "zod";
import { AgentError, runAgent as defaultRunAgent, type AgentDeps, type AgentResult, type RoundTrace } from "../agent/agent.js";
import { GetSectionInput, SectionNotFoundError, getDocumentSection } from "../tools/get_document_section.js";
import type { ToolOutput } from "../tools/types.js";
import { getPrisma } from "../db/client.js";
import { Limiter, prismaDailyCounter, type LimitRejection } from "./limits.js";

export const MAX_QUESTION_CHARS = 500;
const MAX_BODY_BYTES = 4 * 1024;

const AskBody = z.object({ question: z.string().trim().min(1).max(MAX_QUESTION_CHARS) });

const SectionQuery = GetSectionInput.extend({
  document_id: z.string().trim().min(1).max(100),
  section: z.string().trim().min(1).max(20),
});

export type RunAgent = (question: string, deps?: AgentDeps) => Promise<AgentResult>;
export type GetSection = (input: z.infer<typeof GetSectionInput>) => Promise<ToolOutput>;

export interface AppDeps {
  runAgent?: RunAgent;
  getSection?: GetSection;
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

// The page is three fixed files. A lookup table instead of mapping the URL
// onto the filesystem means there's no path to traverse.
const PUBLIC_DIR = new URL("../../public/", import.meta.url);
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};
// Everything the page loads comes from this origin, so the policy can be
// strict: no inline script, no third-party anything.
const CSP = "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const TOOL_ERROR_MESSAGE = "This lookup returned an error. The agent saw it and continued.";

const LIMIT_MESSAGES: Record<LimitRejection["reason"], string> = {
  client: "You've hit the per-visitor limit for this demo. Try again in a few minutes.",
  daily: "The demo has reached its daily question limit. Try again tomorrow.",
  busy: "The demo is busy answering other questions. Try again in a few seconds.",
};

export function createApp(deps: AppDeps = {}): RequestListener {
  const runAgent = deps.runAgent ?? defaultRunAgent;
  const getSection = deps.getSection ?? getDocumentSection;
  const limiter = deps.limiter ?? new Limiter(prismaDailyCounter(getPrisma));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message, err) => console.error(message, err ?? ""));

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && STATIC_FILES[path]) return await sendStatic(res, STATIC_FILES[path]);
      if (path === "/api/health" && req.method === "GET") return sendJson(res, 200, { ok: true });
      if (path === "/api/section" && req.method === "GET") return await handleSection(url, res);
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

    let rejection: LimitRejection | null;
    try {
      rejection = await limiter.acquire(clientId(req));
    } catch (err) {
      // Can't read the daily count: refuse rather than run uncapped.
      log("Daily limit check failed", err);
      return sendJson(res, 503, { error: "The demo can't take questions right now. Try again shortly." }, { "Retry-After": "30" });
    }
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
      const result = await runAgent(body.data.question, { onRound: (round) => send({ type: "round", round: publicRound(round) }) });
      const { messages: _m, servedModels: _s, usage: _u, trace, ...rest } = result;
      send({ type: "result", result: { ...rest, trace: trace.map(publicRound), elapsedMs: now() - started } });
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

  // Source text behind a citation link. A database read only, no model or
  // embedding calls, so it sits outside the question limits.
  async function handleSection(url: URL, res: ServerResponse): Promise<void> {
    const query = SectionQuery.safeParse({
      document_id: url.searchParams.get("document_id") ?? "",
      section: url.searchParams.get("section") ?? "",
    });
    if (!query.success) return sendJson(res, 400, { error: "document_id and section are required." });
    try {
      const { result } = await getSection(query.data);
      return sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof SectionNotFoundError) return sendJson(res, 404, { error: err.message });
      throw err;
    }
  }
}

// Tool errors go back to the model verbatim, which is what it needs to
// recover, but they can carry database detail. The browser only learns that
// a lookup failed.
function publicRound(round: RoundTrace): RoundTrace {
  return {
    round: round.round,
    toolCalls: round.toolCalls.map((c) => (c.error ? { ...c, error: TOOL_ERROR_MESSAGE } : c)),
  };
}

async function sendStatic(res: ServerResponse, entry: { file: string; type: string }): Promise<void> {
  const body = await readFile(new URL(entry.file, PUBLIC_DIR));
  res.writeHead(200, {
    "Content-Type": entry.type,
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-cache",
  });
  res.end(body);
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
