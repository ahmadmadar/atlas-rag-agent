import type { RetrievedSection } from "../tools/types.js";

export interface Citation {
  documentId: string;
  section: string;
}

export interface CitationCheck {
  citations: Citation[]; // unique, in order of first appearance
  ungrounded: Citation[]; // cited but never returned by a tool in this run
}

// [uw-guidelines-cp-v3 §2.2], [claims-handling-policy §header]. Tolerates a
// space after §, and "; "-separated pairs inside one bracket.
const BRACKET = /\[([^\]]*§[^\]]*)\]/g;
const PAIR = /([a-z0-9][a-z0-9-]*)\s+§\s*([0-9]+(?:\.[0-9]+)*|header)/gi;

export function extractCitations(answer: string): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const bracket of answer.matchAll(BRACKET)) {
    for (const m of bracket[1]!.matchAll(PAIR)) {
      const c = { documentId: m[1]!, section: m[2]!.toLowerCase() === "header" ? "header" : m[2]! };
      const key = `${c.documentId}#${c.section}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(c);
      }
    }
  }
  return out;
}

// A citation is grounded if a tool returned that exact section, or (for a
// parent like §2) one of its subsections, during this run.
export function checkCitations(answer: string, retrieved: RetrievedSection[]): CitationCheck {
  const citations = extractCitations(answer);
  const ungrounded = citations.filter(
    (c) =>
      !retrieved.some(
        (r) => r.documentId === c.documentId && (r.section === c.section || r.section.startsWith(`${c.section}.`)),
      ),
  );
  return { citations, ungrounded };
}
