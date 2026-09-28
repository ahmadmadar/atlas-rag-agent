// Eval runner: npm run eval -- [--variant baseline] [--reps 3] [--cases id,id] [--concurrency 1] [--timeout-s 300]
//
// Runs each scenario through the real agent entry point (runAgent), grades
// it, and writes to evals/runs/<variant>/:
//   results.jsonl       one row per graded (case, rep), appended as each finishes
//   errors.jsonl        attempts that produced nothing gradable (timeout, API
//                       error, model mismatch, judge failure), never scored as 0
//   traces/<id>_rep<k>.json   the full conversation for that attempt
// Re-running resumes: any (case, rep) already in results.jsonl is skipped.
import "dotenv/config";
import type Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_MODEL, AgentError, runAgent, type AgentResult } from "../src/agent/agent.js";
import { SYSTEM_PROMPT } from "../src/agent/prompt.js";
import { getPrisma } from "../src/db/client.js";
import { isModel, readJsonl, summarize } from "./summary.js";
import { JUDGE_MODEL, JudgeError, gradeAnswer, retrievedSections, type Graded, type Scenario } from "./grade.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Args {
  variant: string;
  reps: number;
  cases?: string[];
  concurrency: number;
  timeoutS: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { variant: "baseline", reps: 3, concurrency: 1, timeoutS: 300 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${k}`);
      return v;
    };
    if (k === "--variant") a.variant = val();
    else if (k === "--reps") a.reps = Number(val());
    else if (k === "--cases") a.cases = val().split(",");
    else if (k === "--concurrency") a.concurrency = Number(val());
    else if (k === "--timeout-s") a.timeoutS = Number(val());
    else throw new Error(`unknown argument ${k}`);
  }
  if (!/^(baseline|v[1-9]\d*)$/.test(a.variant)) throw new Error(`--variant must be "baseline" or "v<N>"`);
  if (!(a.reps >= 1 && a.concurrency >= 1 && a.timeoutS > 0)) throw new Error("reps, concurrency and timeout must be positive");
  return a;
}

// ---- transcript ------------------------------------------------------------

interface Turn {
  role: "system" | "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  name?: string;
  thinking?: string;
}

function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function toTurns(messages: Anthropic.MessageParam[]): Turn[] {
  const turns: Turn[] = [{ role: "system", content: SYSTEM_PROMPT }];
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (typeof m.content === "string") {
      turns.push({ role: m.role, content: m.content });
      continue;
    }
    let thinking: string | undefined;
    for (const b of m.content) {
      if (b.type === "thinking") thinking = [thinking, b.thinking].filter(Boolean).join("\n") || undefined;
      else if (b.type === "text") {
        turns.push({ role: m.role, content: b.text, ...(thinking && { thinking }) });
        thinking = undefined;
      } else if (b.type === "tool_use") {
        toolNames.set(b.id, b.name);
        turns.push({ role: "tool_call", name: b.name, content: JSON.stringify(b.input, null, 2), ...(thinking && { thinking }) });
        thinking = undefined;
      } else if (b.type === "tool_result") {
        const content = typeof b.content === "string" ? pretty(b.content) : JSON.stringify(b.content, null, 2);
        turns.push({ role: "tool_result", name: toolNames.get(b.tool_use_id), content: b.is_error ? `ERROR: ${content}` : content });
      }
    }
  }
  return turns;
}

// ---- one attempt -----------------------------------------------------------

type Outcome =
  | { kind: "row"; row: Record<string, unknown> }
  | { kind: "error"; error: Record<string, unknown> };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`exceeded ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
class TimeoutError extends Error {}

async function attempt(s: Scenario, rep: number, args: Args, traceDir: string): Promise<Outcome> {
  const base = { prompt_id: s.id, rep, tags: [s.category] };
  const started = Date.now();
  let result: AgentResult;
  try {
    result = await withTimeout(runAgent(s.question), args.timeoutS * 1000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A refusal is a graded outcome (the agent failed to help), not plumbing.
    if (err instanceof AgentError && /declined/.test(message)) {
      return {
        kind: "row",
        row: {
          ...base, prompt: s.question, status: "ok", stop_reason: "refusal", model: AGENT_MODEL,
          grade: { pass: 0, status: 0, facts: 0, citations: 0, judge: 0 },
          explanation: { pass: "agent refused" }, meta: { failure_class: "refusal" },
        },
      };
    }
    if (err instanceof AgentError && /max_tokens/.test(message)) {
      return { kind: "row", row: { ...base, prompt: s.question, status: "truncated", stop_reason: "max_tokens", grade: {} } };
    }
    return { kind: "error", error: { ...base, failure_class: err instanceof TimeoutError ? "timeout" : "harness_or_api", message } };
  }
  const latency_s = (Date.now() - started) / 1000;

  const usage = {
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    cache_read_input_tokens: result.usage.cacheReadTokens,
    cache_creation_input_tokens: result.usage.cacheWriteTokens,
  };
  const wrongModel = result.servedModels.find((m) => !isModel(m, AGENT_MODEL));
  if (wrongModel) {
    return { kind: "error", error: { ...base, failure_class: "model_mismatch", message: `served by ${wrongModel}`, model: wrongModel, usage } };
  }

  const turns = toTurns(result.messages);
  writeFileSync(path.join(traceDir, `${s.id}_rep${rep}.json`), JSON.stringify(turns, null, 2));

  let graded: Graded;
  try {
    graded = await gradeAnswer(s, result.answer, result.status, retrievedSections(result.messages));
  } catch (err) {
    const e = err instanceof JudgeError ? err : undefined;
    return {
      kind: "error",
      error: {
        ...base, failure_class: "grader", message: err instanceof Error ? err.message : String(err),
        model: result.servedModels[0], usage, judge_model: e?.model, judge_usage: e?.usage,
      },
    };
  }

  return {
    kind: "row",
    row: {
      ...base,
      prompt: s.question,
      status: "ok",
      stop_reason: "end_turn",
      ...graded,
      model: result.servedModels[0],
      usage,
      latency_s,
      rounds: result.roundsUsed,
      tool_calls: result.trace.reduce((n, r) => n + r.toolCalls.length, 0),
      meta: { answer: result.answer, answer_status: result.status, cap_reached: result.capReached },
    },
  };
}

// ---- main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all: Scenario[] = JSON.parse(readFileSync(path.join(HERE, "scenarios.json"), "utf8")).scenarios;
  const scenarios = args.cases ? all.filter((s) => args.cases!.includes(s.id)) : all;
  if (args.cases && scenarios.length !== args.cases.length) throw new Error("unknown case id in --cases");

  const dir = path.join(HERE, "runs", args.variant);
  const traceDir = path.join(dir, "traces");
  mkdirSync(traceDir, { recursive: true });
  const resultsFile = path.join(dir, "results.jsonl");
  const done = new Set(readJsonl(resultsFile).map((r) => `${r.prompt_id}#${r.rep}`));

  const queue = scenarios.flatMap((s) => Array.from({ length: args.reps }, (_, rep) => ({ s, rep }))).filter(({ s, rep }) => !done.has(`${s.id}#${rep}`));
  console.log(`${queue.length} attempts to run (${done.size} already graded) on ${AGENT_MODEL}, judge ${JUDGE_MODEL}, concurrency ${args.concurrency}.`);

  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const { s, rep } = queue[next++]!;
      const out = await attempt(s, rep, args, traceDir);
      if (out.kind === "row") {
        appendFileSync(resultsFile, JSON.stringify(out.row) + "\n");
        const g = out.row.grade as Record<string, number>;
        console.log(`  ${s.id} rep${rep}: ${g.pass === 1 ? "PASS" : out.row.status === "truncated" ? "TRUNCATED" : "FAIL"}`);
      } else {
        appendFileSync(path.join(dir, "errors.jsonl"), JSON.stringify(out.error) + "\n");
        console.log(`  ${s.id} rep${rep}: ERROR (${out.error.failure_class}) ${out.error.message}`);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: args.concurrency }, worker));
  } finally {
    await getPrisma().$disconnect();
  }
  summarize(dir);
}

await main();
