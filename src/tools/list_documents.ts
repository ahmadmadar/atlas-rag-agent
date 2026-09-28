import { z } from "zod";
import { getPrisma } from "../db/client.js";
import { loadAuthority } from "./authority.js";
import { sectionLabel, type ToolOutput } from "./types.js";

export const ListDocumentsInput = z.object({});

export const listDocumentsTool = {
  name: "list_documents",
  description:
    "List every document in the Atlas corpus with its type, line of business, version, effective date, status and " +
    "supersession links, plus its section outline. Use it to check whether a document covering a topic exists at " +
    "all before concluding the corpus doesn't answer a question, or to find section numbers to fetch.",
  input_schema: { type: "object" as const, properties: {} },
};

export async function listDocuments(): Promise<ToolOutput> {
  const prisma = getPrisma();
  const [authority, docs, chunks] = await Promise.all([
    loadAuthority(),
    prisma.document.findMany({ select: { id: true, docType: true, lineOfBusiness: true }, orderBy: { id: "asc" } }),
    prisma.chunk.findMany({
      where: { part: 1 },
      select: { documentId: true, sectionNumber: true, sectionTitle: true },
      orderBy: [{ documentId: "asc" }, { chunkIndex: "asc" }],
    }),
  ]);

  const documents = docs.map((d) => ({
    ...authority.get(d.id)!,
    docType: d.docType,
    lineOfBusiness: d.lineOfBusiness,
    sections: chunks
      .filter((c) => c.documentId === d.id)
      .map((c) => ({ section: sectionLabel(c.sectionNumber), title: c.sectionTitle })),
  }));

  // An outline isn't section text, so nothing here counts as citable evidence.
  return { result: { documents }, retrieved: [] };
}
