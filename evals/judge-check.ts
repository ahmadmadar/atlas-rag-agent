// Calibration check for the claim judge: npm run eval:judge-check
// Feeds the judge answers whose correct verdict is known and reports any
// disagreement. Run it after changing the judge prompt or model.
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_FOUND_PREFIX } from "../src/agent/prompt.js";
import { getPrisma } from "../src/db/client.js";
import { getDocumentSection } from "../src/tools/get_document_section.js";
import type { SectionHit } from "../src/tools/types.js";
import { judge, type RetrievedText, type Scenario } from "./grade.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scenarios: Scenario[] = JSON.parse(readFileSync(path.join(HERE, "scenarios.json"), "utf8")).scenarios;
const byId = (id: string) => scenarios.find((s) => s.id === id)!;

// Section text straight from the database, as if the agent had fetched it.
async function sections(...refs: [string, string][]): Promise<Map<string, RetrievedText>> {
  const out = new Map<string, RetrievedText>();
  for (const [documentId, section] of refs) {
    const { result } = await getDocumentSection({ document_id: documentId, section });
    for (const s of (result as { sections: SectionHit[] }).sections) {
      out.set(`${s.documentId} §${s.section}`, { key: `${s.documentId} §${s.section}`, ...s });
    }
  }
  return out;
}

const probes: { name: string; scenario: string; answer: string; refs: [string, string][]; expected: "pass" | "fail" }[] = [
  {
    name: "correct answer, superseded value labeled",
    scenario: "authority-coastal-tiv",
    answer: "Under v3.0 (effective 2025-11-01), a field underwriter can bind up to $8,000,000 TIV per location in a Tier 1 coastal county, with a minimum 5% named-storm deductible [uw-guidelines-cp-v3 §2.2]. The superseded v2.0 limit was $5,000,000 [uw-guidelines-cp-v2 §2.2].",
    refs: [["uw-guidelines-cp-v3", "2.2"], ["uw-guidelines-cp-v2", "2.2"]],
    expected: "pass",
  },
  { name: "empty answer", scenario: "authority-coastal-tiv", answer: "", refs: [], expected: "fail" },
  { name: "I don't know", scenario: "authority-coastal-tiv", answer: "I don't know.", refs: [], expected: "fail" },
  {
    name: "confident answer to a different question",
    scenario: "authority-coastal-tiv",
    answer: "The ransomware sublimit is $1,000,000 [cyber-liability-underwriting-addendum §3].",
    refs: [["cyber-liability-underwriting-addendum", "3"]],
    expected: "fail",
  },
  {
    name: "superseded value presented as current",
    scenario: "authority-coastal-tiv",
    answer: "A field underwriter can bind up to $5,000,000 TIV per location in a Tier 1 coastal county [uw-guidelines-cp-v2 §2.2].",
    refs: [["uw-guidelines-cp-v2", "2.2"]],
    expected: "fail",
  },
  {
    // Baseline false failure: the judge couldn't see the "(New in v3.0)" heading.
    name: "claim supported only by a section heading",
    scenario: "authority-roof-age",
    answer: "Under v3.0, a four-point inspection is required if the roof is older than 10 years [uw-guidelines-cp-v3 §3.1]. Tier 1 coastal risks also need a wind mitigation report regardless of roof age, part of the coastal supplement introduced in v3.0 [uw-guidelines-cp-v3 §3.2].",
    refs: [["uw-guidelines-cp-v3", "3.1"], ["uw-guidelines-cp-v3", "3.2"]],
    expected: "pass",
  },
  {
    // Baseline false failure: "[doc §4, §3]" only passed §4 to the judge.
    name: "claim cited with a continued-document citation",
    scenario: "lookup-litigation-referral",
    answer: "Refer to Atlas Legal when incurred reserve exceeds $250,000 [claims-handling-policy §5]. Separately, a written investigation plan is required when the initial reserve exceeds $50,000 [claims-handling-policy §4, §3].",
    refs: [["claims-handling-policy", "5"], ["claims-handling-policy", "4"], ["claims-handling-policy", "3"]],
    expected: "pass",
  },
  {
    // Baseline judge inconsistency: failed once, passed once as a "quibble".
    name: "right number, unstated qualifier",
    scenario: "lookup-cyber-ransomware",
    answer: "The ransomware/cyber extortion payment sublimit is $1,000,000 per occurrence [cyber-liability-underwriting-addendum §3].",
    refs: [["cyber-liability-underwriting-addendum", "3"]],
    expected: "fail",
  },
  {
    name: "right number, no added qualifier",
    scenario: "lookup-cyber-ransomware",
    answer: "The ransomware/cyber extortion payment sublimit is $1,000,000 [cyber-liability-underwriting-addendum §3].",
    refs: [["cyber-liability-underwriting-addendum", "3"]],
    expected: "pass",
  },
  {
    name: "E&O not found, correctly hedged",
    scenario: "unanswerable-eo-limit",
    answer: `${NOT_FOUND_PREFIX} no document sets a professional liability/E&O limit for Atlas. The in-appetite classes list commercial property, general liability, cyber liability and commercial auto [risk-appetite-statement §2], and the capacity limits cover no E&O line [risk-appetite-statement §4]. The only E&O reference is the requirement that producers carry their own E&O coverage of at least $1,000,000 per occurrence [producer-compensation-policy §4], which is not an Atlas coverage limit.`,
    refs: [["risk-appetite-statement", "2"], ["risk-appetite-statement", "4"], ["producer-compensation-policy", "4"]],
    expected: "pass",
  },
  {
    name: "E&O not found, but overstates (session 3 regression)",
    scenario: "unanswerable-eo-limit",
    answer: `${NOT_FOUND_PREFIX} Atlas does not write professional liability (E&O) as a line of business. The in-appetite classes are limited to commercial property, general liability, cyber liability, and commercial auto [risk-appetite-statement §2].`,
    refs: [["risk-appetite-statement", "2"]],
    expected: "fail",
  },
  {
    name: "E&O answered with the producer's limit",
    scenario: "unanswerable-eo-limit",
    answer: "Atlas's E&O per-occurrence limit is $1,000,000 [producer-compensation-policy §4].",
    refs: [["producer-compensation-policy", "4"]],
    expected: "fail",
  },
];

let disagreements = 0;
try {
  for (const p of probes) {
    const { verdict } = await judge(byId(p.scenario), p.answer, await sections(...p.refs));
    const ok = verdict.verdict === p.expected;
    if (!ok) disagreements++;
    console.log(`${ok ? "ok  " : "MISS"} ${p.name}: judge said ${verdict.verdict}, expected ${p.expected}`);
    if (!ok) console.log(`     ${verdict.reasoning}`);
  }
} finally {
  await getPrisma().$disconnect();
}
console.log(`\n${probes.length - disagreements}/${probes.length} judge verdicts match.`);
process.exitCode = disagreements ? 1 : 0;
