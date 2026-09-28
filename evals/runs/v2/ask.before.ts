// CLI entry point: npm run ask -- "question" [--json]
// Prints the answer, then the round-by-round trace and the citation check.
import "dotenv/config";
import { getPrisma } from "../db/client.js";
import { runAgent } from "./agent.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const question = args.filter((a) => a !== "--json").join(" ").trim();
if (!question) {
  console.error('Usage: npm run ask -- "your question" [--json]');
  process.exit(1);
}

try {
  const result = await runAgent(question);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n${result.answer}\n`);
    console.log("---");
    for (const round of result.trace) {
      console.log(`Round ${round.round}:`);
      for (const call of round.toolCalls) {
        const got = call.error ? `error: ${call.error}` : call.retrieved.map((r) => `${r.documentId} §${r.section}`).join(", ") || "(outline only)";
        console.log(`  ${call.name} ${JSON.stringify(call.input)}\n    -> ${got}`);
      }
    }
    console.log(`Status: ${result.status}. Rounds: ${result.roundsUsed}${result.capReached ? " (cap reached)" : ""}.`);
    console.log(`Citations: ${result.citations.map((c) => `${c.documentId} §${c.section}`).join(", ") || "none"}.`);
    if (!result.grounded) {
      const why = result.ungroundedCitations.length
        ? `cites sections no tool returned: ${result.ungroundedCitations.map((c) => `${c.documentId} §${c.section}`).join(", ")}`
        : "answer has no citations";
      console.log(`WARNING: citation check failed, ${why}.`);
    }
    const u = result.usage;
    console.log(`Tokens: ${u.inputTokens} in (+${u.cacheReadTokens} cache read, +${u.cacheWriteTokens} cache write), ${u.outputTokens} out.`);
  }
} finally {
  await getPrisma().$disconnect();
}
