import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { NOT_FOUND_PREFIX } from "../src/agent/prompt.js";
import { normalize, retrievedSections, runChecks, type Scenario } from "../evals/grade.js";

const scenarios: Scenario[] = JSON.parse(readFileSync(new URL("../evals/scenarios.json", import.meta.url), "utf8")).scenarios;

// An answer built from the scenario's own expectations: first alternative of
// every fact, first section of every citation group.
function oracle(s: Scenario) {
  const facts = s.expect.facts.map((f) => f.any[0]).join(", ");
  const cites = s.expect.citations.map((g) => `[${g[0]}]`).join(" ");
  const answer = s.expect.status === "not_found" ? `${NOT_FOUND_PREFIX} nothing responsive.` : `${facts} ${cites}`;
  return { answer, status: s.expect.status, grounded: true, ungroundedCitations: [] };
}

describe("programmatic checks over every scenario", () => {
  it.each(scenarios.map((s) => [s.id, s] as const))("oracle passes all checks: %s", (_, s) => {
    const c = runChecks(s, oracle(s));
    expect([c.status, c.facts, c.citations], JSON.stringify(c.notes)).toEqual([1, 1, 1]);
  });

  it.each(scenarios.map((s) => [s.id, s] as const))("empty answer fails at least one check: %s", (_, s) => {
    const c = runChecks(s, { answer: "", status: "answered", grounded: false, ungroundedCitations: [] });
    expect(Math.min(c.status, c.facts, c.citations)).toBe(0);
  });

  it("flags a superseded value with the right citation shape as a missing fact", () => {
    const s = scenarios.find((x) => x.id === "authority-coastal-tiv")!;
    const c = runChecks(s, { answer: "The limit is $5,000,000 [uw-guidelines-cp-v3 §2.2].", status: "answered", grounded: true, ungroundedCitations: [] });
    expect(c.facts).toBe(0);
    expect(c.citations).toBe(1);
  });

  it("fails citations when the right number comes from the wrong version", () => {
    const s = scenarios.find((x) => x.id === "authority-coastal-tiv")!;
    const c = runChecks(s, { answer: "$8,000,000 [uw-guidelines-cp-v2 §2.2]", status: "answered", grounded: true, ungroundedCitations: [] });
    expect(c.citations).toBe(0);
  });

  it("fails citations when the agent's grounding check failed", () => {
    const s = scenarios.find((x) => x.id === "lookup-cyber-ransomware")!;
    const c = runChecks(s, {
      answer: "$1,000,000 [cyber-liability-underwriting-addendum §3]",
      status: "answered",
      grounded: false,
      ungroundedCitations: [{ documentId: "cyber-liability-underwriting-addendum", section: "3" }],
    });
    expect(c.citations).toBe(0);
    expect(c.notes.citations).toMatch(/ungrounded/);
  });

  it("matches facts through markdown emphasis and case", () => {
    expect(normalize("**$8M** per location").includes(normalize("$8m"))).toBe(true);
  });
});

describe("retrievedSections", () => {
  it("rebuilds section text from search and get_section results, skipping errors", () => {
    const hit = { documentId: "d", section: "2.2", title: "T", version: "3.0", effectiveDate: "2025-11-01", status: "active", content: "limit" };
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "q" },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: JSON.stringify({ query: "x", hits: [hit] }) },
          { type: "tool_result", tool_use_id: "b", content: JSON.stringify({ sections: [{ ...hit, section: "header", content: "hdr" }] }) },
          { type: "tool_result", tool_use_id: "c", content: "Unknown document_id", is_error: true },
        ],
      },
    ];
    const got = retrievedSections(messages);
    expect([...got.keys()]).toEqual(["d §2.2", "d §header"]);
    expect(got.get("d §header")!.content).toBe("hdr");
  });
});
