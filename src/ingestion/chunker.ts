// Structural chunker: one chunk per numbered section, per the chunking
// strategy in docs/architecture.md. Oversized sections split at
// paragraph boundaries with a small overlap; every part keeps the
// section's heading path so citations stay readable.

export const MAX_CHUNK_TOKENS = 500;
export const OVERLAP_TOKENS = 50;

// Approximation (~4 characters per token for English prose). The cap is a
// soft sizing target, not a model limit (voyage-4 accepts 32k tokens), so
// a real tokenizer isn't worth the dependency here.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface Chunk {
  chunkIndex: number;
  sectionNumber: string | null; // null for the header block above the first section
  sectionTitle: string;
  headingPath: string;
  part: number;
  partCount: number;
  content: string;
  tokenEstimate: number;
}

interface Section {
  number: string | null;
  title: string;
  headingPath: string;
  body: string;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
// "2. Binding Authority" or "2.1 Standard Binding Authority"
const NUMBERED = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/;

export const HEADER_SECTION_TITLE = "Document header";

export function parseSections(markdown: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; label: string }[] = [];
  let current: Section = { number: null, title: HEADER_SECTION_TITLE, headingPath: "", body: "" };
  let lines: string[] = [];

  const flush = () => {
    const body = lines.join("\n").trim();
    if (body) sections.push({ ...current, body });
    lines = [];
  };

  for (const line of markdown.split("\n")) {
    const match = HEADING.exec(line);
    if (!match) {
      lines.push(line);
      continue;
    }
    const level = match[1]!.length;
    const text = match[2]!;
    if (level === 1) continue; // document title, already stored on the Document row

    flush();
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, label: text });

    const numbered = NUMBERED.exec(text);
    current = {
      number: numbered ? numbered[1]! : null,
      title: numbered ? numbered[2]! : text,
      headingPath: stack.map((s) => s.label).join(" > "),
      body: "",
    };
  }
  flush();
  return sections;
}

export function chunkDocument(markdown: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of parseSections(markdown)) {
    const parts = splitSection(section.body);
    parts.forEach((content, i) => {
      chunks.push({
        chunkIndex: chunks.length,
        sectionNumber: section.number,
        sectionTitle: section.title,
        headingPath: section.headingPath,
        part: i + 1,
        partCount: parts.length,
        content,
        tokenEstimate: estimateTokens(content),
      });
    });
  }
  return chunks;
}

export function splitSection(body: string, maxTokens = MAX_CHUNK_TOKENS, overlapTokens = OVERLAP_TOKENS): string[] {
  if (estimateTokens(body) <= maxTokens) return [body];

  // Leave room for the overlap plus the ellipsis and paragraph break.
  const budget = maxTokens - overlapTokens - 1;
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (estimateTokens(p) > budget ? splitByWords(p, budget) : [p]));

  const parts: string[] = [];
  let buffer: string[] = [];
  for (const paragraph of paragraphs) {
    const candidate = [...buffer, paragraph].join("\n\n");
    if (buffer.length && estimateTokens(candidate) > budget) {
      parts.push(buffer.join("\n\n"));
      buffer = [paragraph];
    } else {
      buffer.push(paragraph);
    }
  }
  if (buffer.length) parts.push(buffer.join("\n\n"));

  // Continuation parts open with the tail of the previous part so a
  // condition split across the boundary still has its context.
  return parts.map((part, i) => (i === 0 ? part : `${tail(parts[i - 1]!, overlapTokens)}\n\n${part}`));
}

function splitByWords(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const next = current ? `${current} ${word}` : word;
    if (current && estimateTokens(next) > maxTokens) {
      out.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) out.push(current);
  return out;
}

function tail(text: string, tokens: number): string {
  const chars = tokens * 4;
  if (text.length <= chars) return text;
  const slice = text.slice(-chars);
  const firstSpace = slice.indexOf(" ");
  return `…${firstSpace === -1 ? slice : slice.slice(firstSpace + 1)}`;
}

// The text actually sent to the embedding model. Prefixing the document
// title and heading path means a chunk like "Maximum TIV: $8,000,000"
// still carries "Commercial Property v3.0 > Coastal Wind/Hail Zones".
export function embeddingText(documentTitle: string, chunk: Pick<Chunk, "headingPath" | "content">): string {
  return `${documentTitle}\n${chunk.headingPath || HEADER_SECTION_TITLE}\n\n${chunk.content}`;
}
