// Sanity check for the ingestion pipeline, not the retrieval tool (that's
// search_knowledge_base, built with the agent). Prints per-document chunk
// stats, then the top matches for each query given on the command line
// (or a default set that exercises the v2/v3 conflict and the E&O trap).
import "dotenv/config";
import { getPrisma } from "../db/client.js";
import { embed, toPgVector } from "./embeddings.js";

const DEFAULT_QUERIES = [
  "What is the maximum TIV a field underwriter can bind in a Tier 1 coastal county?",
  "What is Atlas's per-occurrence limit for professional liability (E&O) coverage?",
];
const TOP_K = 5;

const prisma = getPrisma();

try {
  const stats = await prisma.$queryRaw<{ id: string; status: string; effectiveDate: Date; chunks: bigint; missing: bigint; maxTokens: number | null }[]>`
    SELECT d.id, d.status::text, d."effectiveDate", count(c.id) AS chunks,
           count(c.id) FILTER (WHERE c.embedding IS NULL) AS missing,
           max(c."tokenEstimate") AS "maxTokens"
    FROM "Document" d LEFT JOIN "Chunk" c ON c."documentId" = d.id
    GROUP BY d.id ORDER BY d.id`;
  console.table(stats.map((s) => ({ ...s, effectiveDate: s.effectiveDate.toISOString().slice(0, 10), chunks: Number(s.chunks), missing: Number(s.missing) })));

  const queries = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_QUERIES;
  const { embeddings } = await embed(queries, "query");
  for (const [i, query] of queries.entries()) {
    const vector = toPgVector(embeddings[i]!);
    const rows = await prisma.$queryRaw<{ documentId: string; status: string; sectionNumber: string | null; headingPath: string; score: number }[]>`
      SELECT c."documentId", d.status::text, c."sectionNumber", c."headingPath",
             1 - (c.embedding <=> ${vector}::vector) AS score
      FROM "Chunk" c JOIN "Document" d ON d.id = c."documentId"
      WHERE c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${vector}::vector
      LIMIT ${TOP_K}`;
    console.log(`\nQ: ${query}`);
    console.table(rows.map((r) => ({ ...r, score: Number(r.score).toFixed(3) })));
  }
} finally {
  await prisma.$disconnect();
}
