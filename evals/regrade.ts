// Re-grades a finished run without re-running the agent:
//   npm run eval:regrade -- --variant baseline
// Rebuilds each attempt's answer and retrieved sections from its saved trace
// and grades it again with the current grader. Use it after a grader fix, so
// every row in the run is scored by the same grader. Agent-side fields
// (model, usage, latency, rounds) carry over from the original row.
import "dotenv/config";
import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerStatus, parseFinalAnswer, type AgentResult } from "../src/agent/agent.js";
import { JudgeError, gradeAnswer, retrievedSections, type Scenario } from "./grade.js";
import { summarize } from "./summary.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Turn {
  role: string;
  content: string;
}

const variantArg = process.argv.indexOf("--variant");
const variant = variantArg >= 0 ? process.argv[variantArg + 1]! : "baseline";
const dir = path.join(HERE, "runs", variant);
const scenarios: Scenario[] = JSON.parse(readFileSync(path.join(HERE, "scenarios.json"), "utf8")).scenarios;
const readJsonl = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// Original rows (graded) and error rows (grader failures still carry the
// agent's usage), keyed by case and rep.
const prior = new Map<string, Record<string, any>>();
for (const r of readJsonl(path.join(dir, "errors.jsonl"))) prior.set(`${r.prompt_id}#${r.rep}`, r);
for (const r of readJsonl(path.join(dir, "results.jsonl"))) prior.set(`${r.prompt_id}#${r.rep}`, r);

const rows: string[] = [];
const errors: string[] = [];
const traces = readdirSync(path.join(dir, "traces")).filter((f) => f.endsWith(".json")).sort();

for (const file of traces) {
  const [, id, rep] = file.match(/^(.+)_rep(\d+)\.json$/)!;
  const s = scenarios.find((x) => x.id === id);
  if (!s) throw new Error(`trace ${file} has no scenario`);
  const turns: Turn[] = JSON.parse(readFileSync(path.join(dir, "traces", file), "utf8"));

  // The answer is the trailing run of assistant turns (one per text block).
  let i = turns.length;
  while (i > 0 && turns[i - 1]!.role === "assistant") i--;
  const finalText = turns.slice(i).map((t) => t.content).join("").trim();
  // v2+ traces end in the structured {status, answer}; earlier ones in prose
  // whose status came from the not-found prefix.
  let answer: string;
  let status: AgentResult["status"];
  if (finalText.startsWith("{")) ({ answer, status } = parseFinalAnswer(finalText));
  else [answer, status] = [finalText, answerStatus(finalText)];
  const toolResults: Anthropic.MessageParam[] = turns
    .filter((t) => t.role === "tool_result" && !t.content.startsWith("ERROR:"))
    .map((t, k) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${k}`, content: t.content }] }));

  const old = prior.get(`${id}#${rep}`) ?? {};
  const base = { prompt_id: id, rep: Number(rep), tags: [s.category] };
  try {
    const graded = await gradeAnswer(s, answer, status, retrievedSections(toolResults));
    rows.push(
      JSON.stringify({
        ...base,
        prompt: s.question,
        status: "ok",
        stop_reason: "end_turn",
        ...graded,
        model: old.model,
        usage: old.usage,
        latency_s: old.latency_s,
        rounds: old.rounds,
        tool_calls: old.tool_calls ?? turns.filter((t) => t.role === "tool_call").length,
        meta: { answer, answer_status: status, cap_reached: old.meta?.cap_reached, regraded: true },
      }),
    );
    console.log(`  ${id} rep${rep}: ${graded.grade.pass ? "PASS" : "FAIL"}`);
  } catch (err) {
    const e = err instanceof JudgeError ? err : undefined;
    errors.push(
      JSON.stringify({
        ...base, failure_class: "grader", message: err instanceof Error ? err.message : String(err),
        model: old.model, usage: old.usage, judge_model: e?.model, judge_usage: e?.usage,
      }),
    );
    console.log(`  ${id} rep${rep}: ERROR (grader) ${err instanceof Error ? err.message : err}`);
  }
}

// Keep the previous grading next to the new one rather than overwriting it.
for (const f of ["results.jsonl", "errors.jsonl"]) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (existsSync(path.join(dir, f))) renameSync(path.join(dir, f), path.join(dir, f.replace(".jsonl", `.pre-regrade-${stamp}.jsonl`)));
}
writeFileSync(path.join(dir, "results.jsonl"), rows.map((r) => r + "\n").join(""));
if (errors.length) writeFileSync(path.join(dir, "errors.jsonl"), errors.map((r) => r + "\n").join(""));
console.log(`\nRe-graded ${rows.length} attempts, ${errors.length} grader errors.`);
summarize(dir);
