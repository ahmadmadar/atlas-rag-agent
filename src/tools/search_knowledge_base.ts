import { Prisma } from "@prisma/client";
import { z } from "zod";
import { getPrisma } from "../db/client.js";
import { embed, toPgVector } from "../ingestion/embeddings.js";
import { loadAuthority } from "./authority.js";
import { sectionLabel, type SectionHit, type ToolOutput } from "./types.js";

export const SearchInput = z.object({
  query: z.string().min(1),
  top_k: z.number().int().min(1).max(10).default(5),
  document_ids: z.array(z.string().min(1)).min(1).optional(),
});

export const searchKnowledgeBaseTool = {
  name: "search_knowledge_base",
  description:
    "Semantic search over the Atlas Underwriting policy corpus. Returns the most similar sections, each with its " +
    "document's effective date, status (active/superseded) and supersession links, plus a cosine similarity score. " +
    "Scores are relative, not a relevance guarantee: the top hit can share vocabulary with the question without " +
    "answering it. Superseded documents are included on purpose. Use document_ids to narrow a follow-up search.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Natural-language search query." },
      top_k: { type: "integer", minimum: 1, maximum: 10, description: "Number of sections to return (default 5)." },
      document_ids: {
        type: "array",
        items: { type: "string" },
        description: "Optional: restrict the search to these document ids (from list_documents).",
      },
    },
    required: ["query"],
  },
};

export async function searchKnowledgeBase(input: z.infer<typeof SearchInput>): Promise<ToolOutput> {
  const { embeddings } = await embed([input.query], "query");
  const vector = toPgVector(embeddings[0]!);
  const docFilter = input.document_ids
    ? Prisma.sql`AND c."documentId" IN (${Prisma.join(input.document_ids)})`
    : Prisma.empty;

  const rows = await getPrisma().$queryRaw<
    { documentId: string; sectionNumber: string | null; headingPath: string; content: string; score: number }[]
  >`
    SELECT c."documentId", c."sectionNumber", c."headingPath", c.content,
           1 - (c.embedding <=> ${vector}::vector) AS score
    FROM "Chunk" c
    WHERE c.embedding IS NOT NULL ${docFilter}
    ORDER BY c.embedding <=> ${vector}::vector
    LIMIT ${input.top_k}`;

  const authority = await loadAuthority([...new Set(rows.map((r) => r.documentId))]);
  const hits: SectionHit[] = rows.map((r) => ({
    ...authority.get(r.documentId)!,
    section: sectionLabel(r.sectionNumber),
    headingPath: r.headingPath,
    content: r.content,
    score: Math.round(Number(r.score) * 1000) / 1000,
  }));

  return {
    result: { query: input.query, hits },
    retrieved: hits.map((h) => ({ documentId: h.documentId, section: h.section })),
  };
}
