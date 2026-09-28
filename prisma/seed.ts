// Loads the fictional Atlas corpus: parse frontmatter, chunk by section,
// embed with Voyage AI, store in pgvector. Safe to re-run; unchanged
// documents are skipped. Pass --force to re-embed everything.
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPrisma } from "../src/db/client.js";
import { ingestCorpus } from "../src/ingestion/ingest.js";

const corpusDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../corpus");
const prisma = getPrisma();

try {
  const summary = await ingestCorpus(prisma, { corpusDir, force: process.argv.includes("--force") });
  console.table(summary.documents);
  if (summary.removed.length) console.log(`Removed documents no longer in corpus: ${summary.removed.join(", ")}`);
  console.log(`Voyage embedding tokens used: ${summary.embeddingTokens}`);
} finally {
  await prisma.$disconnect();
}
