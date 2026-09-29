import { z } from "zod";
import { getPrisma } from "../db/client.js";
import { loadAuthority } from "./authority.js";
import { HEADER_SECTION, sectionLabel, type SectionHit, type ToolOutput } from "./types.js";

export const GetSectionInput = z.object({
  document_id: z.string().min(1),
  section: z.string().min(1),
});

export const getDocumentSectionTool = {
  name: "get_document_section",
  description:
    "Fetch the full text of one section of a document by id and section number, e.g. document_id " +
    '"uw-guidelines-cp-v3", section "2.2". A parent number such as "2" returns all of its subsections (2.1, 2.2, ...). ' +
    'Use section "header" for the document\'s status block (effective date, what it supersedes). Use this to read ' +
    "context around a search hit or to check what another version of a document says in the same section.",
  input_schema: {
    type: "object" as const,
    properties: {
      document_id: { type: "string", description: "Document id, as returned by list_documents or search." },
      section: { type: "string", description: 'Section number like "2.2" or "4", or "header".' },
    },
    required: ["document_id", "section"],
  },
};

// The document or section doesn't exist. Distinct from database failures so
// the web server can answer 404 for a bad citation link and 500 otherwise.
export class SectionNotFoundError extends Error {}

// A section request matches the section itself and any subsection of it:
// "2" matches "2", "2.1", "2.2" but not "20".
export function matchesSection(sectionNumber: string | null, requested: string): boolean {
  if (requested === HEADER_SECTION) return sectionNumber === null;
  if (sectionNumber === null) return false;
  return sectionNumber === requested || sectionNumber.startsWith(`${requested}.`);
}

export async function getDocumentSection(input: z.infer<typeof GetSectionInput>): Promise<ToolOutput> {
  const requested = input.section.trim().replace(/^§\s*/, "").replace(/\.$/, "");
  const authority = await loadAuthority([input.document_id]);
  const doc = authority.get(input.document_id);
  if (!doc) {
    throw new SectionNotFoundError(`Unknown document_id "${input.document_id}". Call list_documents for valid ids.`);
  }

  const chunks = await getPrisma().chunk.findMany({
    where: { documentId: input.document_id },
    orderBy: { chunkIndex: "asc" },
    select: { sectionNumber: true, headingPath: true, content: true, part: true },
  });
  const matched = chunks.filter((c) => matchesSection(c.sectionNumber, requested));
  if (matched.length === 0) {
    const available = [...new Set(chunks.map((c) => sectionLabel(c.sectionNumber)))].join(", ");
    throw new SectionNotFoundError(`No section "${requested}" in ${input.document_id}. Available sections: ${available}.`);
  }

  // Oversized sections are stored as several parts; stitch them back together.
  const bySection = new Map<string, SectionHit>();
  for (const c of matched) {
    const section = sectionLabel(c.sectionNumber);
    const existing = bySection.get(section);
    if (existing) existing.content += `\n\n${c.content}`;
    else bySection.set(section, { ...doc, section, headingPath: c.headingPath, content: c.content });
  }
  const sections = [...bySection.values()];

  return {
    result: { sections },
    retrieved: sections.map((s) => ({ documentId: s.documentId, section: s.section })),
  };
}
