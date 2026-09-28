// Run summary shared by the runner and the re-grader: per-metric means with
// 95% CIs over per-case means, pass rate by category, measured cost and
// latency, and the reason for every failing attempt.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// First-party $/MTok. Cache writes bill at 1.25x input, reads at 0.1x.
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-opus-5": { in: 5, out: 25 },
};

// Accept the exact id or a dated snapshot of it; anything else is a reroute.
export function isModel(served: string, requested: string): boolean {
  return served === requested || served.startsWith(`${requested}-20`);
}

// ---- summary ---------------------------------------------------------------

export function readJsonl(file: string): Record<string, any>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function cost(model: string | undefined, u: Record<string, number> | undefined): number {
  const p = model && PRICES[Object.keys(PRICES).find((k) => isModel(model, k)) ?? ""];
  if (!p || !u) return 0;
  return (
    ((u.input_tokens ?? 0) * p.in +
      (u.cache_creation_input_tokens ?? 0) * p.in * 1.25 +
      (u.cache_read_input_tokens ?? 0) * p.in * 0.1 +
      (u.output_tokens ?? 0) * p.out) /
    1e6
  );
}

// Mean over cases of each case's mean across reps, with a 95% CI over those
// per-case means (reps of one case are not independent samples).
function caseMeanCI(rows: Record<string, any>[], metric: string) {
  const byCase = new Map<string, number[]>();
  for (const r of rows) {
    const v = r.grade?.[metric];
    if (typeof v !== "number") continue;
    byCase.set(r.prompt_id, [...(byCase.get(r.prompt_id) ?? []), v]);
  }
  const means = [...byCase.values()].map((vs) => vs.reduce((a, b) => a + b, 0) / vs.length);
  const n = means.length;
  if (!n) return { mean: NaN, half: NaN, n };
  const mean = means.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(means.reduce((a, m) => a + (m - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, half: (1.96 * sd) / Math.sqrt(n), n };
}

export function summarize(dir: string) {
  const rows = readJsonl(path.join(dir, "results.jsonl")).filter((r) => r.status === "ok");
  const errors = readJsonl(path.join(dir, "errors.jsonl"));
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  console.log(`\n${rows.length} graded attempts, ${errors.length} failed attempts (errors.jsonl).`);
  for (const m of ["pass", "status", "facts", "citations", "judge"]) {
    const { mean, half, n } = caseMeanCI(rows, m);
    console.log(`  ${m.padEnd(10)} ${pct(mean).padStart(4)}  ±${pct(half)}  (${n} cases)`);
  }
  const cats = [...new Set(rows.map((r) => r.tags[0]))];
  console.log("  pass by category: " + cats.map((c) => `${c} ${pct(caseMeanCI(rows.filter((r) => r.tags[0] === c), "pass").mean)}`).join(", "));
  const agentCost = [...rows, ...errors].reduce((a, r) => a + cost(r.model, r.usage), 0);
  const judgeCost = [...rows, ...errors].reduce((a, r) => a + cost(r.judge_model, r.judge_usage), 0);
  const lat = rows.map((r) => r.latency_s).filter((x) => typeof x === "number").sort((a, b) => a - b);
  console.log(`  cost: agent $${agentCost.toFixed(3)} + judge $${judgeCost.toFixed(3)}; latency median ${lat[Math.floor(lat.length / 2)]?.toFixed(1)}s, max ${lat.at(-1)?.toFixed(1)}s`);
  const failing = rows.filter((r) => r.grade.pass === 0);
  for (const r of failing) {
    const why = Object.entries(r.explanation ?? {})
      .filter(([k]) => k !== "judge" || r.grade.judge === 0)
      .map(([k, v]) => `${k}: ${String(v).split("\n").slice(0, 3).join(" / ")}`)
      .join(" | ");
    console.log(`  FAIL ${r.prompt_id} rep${r.rep}: ${why}`);
  }
}

