// Shared shapes for tool output. Every section a tool returns carries its
// document's authority metadata, so the agent can apply the authority rule
// (docs/architecture.md) without a second lookup.

export interface DocumentAuthority {
  documentId: string;
  title: string;
  version: string;
  effectiveDate: string; // YYYY-MM-DD
  status: "active" | "superseded";
  supersedes: string | null;
  supersededBy: string | null;
}

export interface SectionHit extends DocumentAuthority {
  // "header" for the document's status block, otherwise e.g. "2.2".
  // This is exactly what the agent writes in a citation: [documentId §section].
  section: string;
  headingPath: string;
  content: string;
  score?: number; // cosine similarity, search results only
}

// A (document, section) pair a tool actually returned during a run. The
// citation check only accepts citations to sections in this set.
export interface RetrievedSection {
  documentId: string;
  section: string;
}

export interface ToolOutput {
  result: unknown; // serialized to JSON for the model
  retrieved: RetrievedSection[];
}

export const HEADER_SECTION = "header";

export function sectionLabel(sectionNumber: string | null): string {
  return sectionNumber ?? HEADER_SECTION;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
