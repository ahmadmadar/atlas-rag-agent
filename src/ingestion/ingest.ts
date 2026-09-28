import type { PrismaClient } from "@prisma/client";
import { chunkDocument, embeddingText, type Chunk } from "./chunker.js";
import { loadCorpus, type CorpusDocument } from "./corpus.js";
import { embed, toPgVector } from "./embeddings.js";

export interface IngestOptions {
  corpusDir: string;
  // Re-chunk and re-embed every document even if its content hash is unchanged.
  force?: boolean;
}

export interface IngestSummary {
  documents: { id: string; chunks: number; action: "embedded" | "unchanged" }[];
  removed: string[];
  embeddingTokens: number;
}

export async function ingestCorpus(prisma: PrismaClient, options: IngestOptions): Promise<IngestSummary> {
  const corpus = await loadCorpus(options.corpusDir);
  const corpusIds = corpus.map((d) => d.frontmatter.id);

  // A document is up to date only if its hash matches and every chunk
  // has an embedding (a previous run could have died mid-way).
  const existing = await prisma.$queryRaw<{ id: string; contentHash: string; chunks: bigint; missing: bigint }[]>`
    SELECT d.id, d."contentHash",
           count(c.id) AS chunks,
           count(c.id) FILTER (WHERE c.embedding IS NULL) AS missing
    FROM "Document" d LEFT JOIN "Chunk" c ON c."documentId" = d.id
    GROUP BY d.id`;
  const upToDate = new Set(
    existing
      .filter((e) => !options.force && e.chunks > 0n && e.missing === 0n)
      .filter((e) => corpus.some((d) => d.frontmatter.id === e.id && d.contentHash === e.contentHash))
      .map((e) => e.id),
  );

  const toEmbed = corpus.filter((d) => !upToDate.has(d.frontmatter.id));
  const chunked = toEmbed.map((doc) => ({ doc, chunks: chunkDocument(doc.body) }));

  // One embeddings call across all changed documents (batched internally).
  const texts = chunked.flatMap(({ doc, chunks }) => chunks.map((c) => embeddingText(doc.frontmatter.title, c)));
  const { embeddings, totalTokens } = texts.length ? await embed(texts, "document") : { embeddings: [], totalTokens: 0 };

  // Clear supersession links first so deletes and re-links can't trip the
  // unique/foreign-key constraints, then drop documents no longer in the corpus.
  await prisma.document.updateMany({ data: { supersedesId: null } });
  const stale = existing.map((e) => e.id).filter((id) => !corpusIds.includes(id));
  if (stale.length) await prisma.document.deleteMany({ where: { id: { in: stale } } });

  let offset = 0;
  for (const { doc, chunks } of chunked) {
    const vectors = embeddings.slice(offset, offset + chunks.length);
    offset += chunks.length;
    await writeDocument(prisma, doc, chunks, vectors);
  }

  for (const { frontmatter: fm } of corpus) {
    if (fm.supersedes) {
      await prisma.document.update({ where: { id: fm.id }, data: { supersedesId: fm.supersedes } });
    }
  }

  const chunkCounts = new Map(existing.map((e) => [e.id, Number(e.chunks)]));
  return {
    documents: corpus.map((d) => {
      const fresh = chunked.find((c) => c.doc === d);
      return fresh
        ? { id: d.frontmatter.id, chunks: fresh.chunks.length, action: "embedded" as const }
        : { id: d.frontmatter.id, chunks: chunkCounts.get(d.frontmatter.id) ?? 0, action: "unchanged" as const };
    }),
    removed: stale,
    embeddingTokens: totalTokens,
  };
}

async function writeDocument(prisma: PrismaClient, doc: CorpusDocument, chunks: Chunk[], vectors: number[][]) {
  const fm = doc.frontmatter;
  const fields = {
    title: fm.title,
    docType: fm.docType,
    lineOfBusiness: fm.lineOfBusiness,
    version: fm.version,
    effectiveDate: fm.effectiveDate,
    status: fm.status === "active" ? ("ACTIVE" as const) : ("SUPERSEDED" as const),
    sourcePath: doc.sourcePath,
    contentHash: doc.contentHash,
  };

  await prisma.$transaction(async (tx) => {
    await tx.document.upsert({ where: { id: fm.id }, create: { id: fm.id, ...fields }, update: fields });
    await tx.chunk.deleteMany({ where: { documentId: fm.id } });
    await tx.chunk.createMany({
      data: chunks.map(({ chunkIndex, sectionNumber, sectionTitle, headingPath, part, partCount, content, tokenEstimate }) => ({
        documentId: fm.id,
        chunkIndex,
        sectionNumber,
        sectionTitle,
        headingPath,
        part,
        partCount,
        content,
        tokenEstimate,
      })),
    });
    // Prisma can't write Unsupported("vector") columns, so embeddings go in via raw SQL.
    for (const [i, chunk] of chunks.entries()) {
      await tx.$executeRaw`
        UPDATE "Chunk" SET embedding = ${toPgVector(vectors[i]!)}::vector
        WHERE "documentId" = ${fm.id} AND "chunkIndex" = ${chunk.chunkIndex}`;
    }
  });
}
