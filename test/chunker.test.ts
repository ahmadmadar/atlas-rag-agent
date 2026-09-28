import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import { chunkDocument, embeddingText, estimateTokens, MAX_CHUNK_TOKENS, parseSections, splitSection } from "../src/ingestion/chunker.js";

const v3 = matter(await readFile("corpus/underwriting-guidelines-commercial-property-v3.md", "utf8")).content;

describe("parseSections", () => {
  it("chunks by numbered subsection and keeps the heading path", () => {
    const sections = parseSections(v3);
    const coastal = sections.find((s) => s.number === "2.2");
    expect(coastal?.title).toBe("Coastal Wind/Hail Zones (Tier 1 Counties)");
    expect(coastal?.headingPath).toBe("2. Binding Authority & TIV Limits > 2.2 Coastal Wind/Hail Zones (Tier 1 Counties)");
    // The TIV limit and the deductible that qualifies it land in the same chunk.
    expect(coastal?.body).toContain("$8,000,000 per location");
    expect(coastal?.body).toContain("5% of TIV");
  });

  it("keeps the effective/status header block and drops the H1 title", () => {
    const [header] = parseSections(v3);
    expect(header?.number).toBeNull();
    expect(header?.body).toContain("Supersedes v2.0");
    expect(parseSections(v3).some((s) => s.body.includes("# Underwriting Guidelines"))).toBe(false);
  });

  it("skips parent headings that only contain subsections", () => {
    const numbers = parseSections(v3).map((s) => s.number);
    expect(numbers).not.toContain("2");
    expect(numbers).toEqual([null, "1", "2.1", "2.2", "3.1", "3.2", "4", "5"]);
  });

  it("resets the heading path when moving back up a level", () => {
    const md = "## 1. A\n\n### 1.1 B\n\nb\n\n## 2. C\n\nc";
    expect(parseSections(md).map((s) => s.headingPath)).toEqual(["1. A > 1.1 B", "2. C"]);
  });
});

describe("splitSection", () => {
  const paragraph = (n: number) => `Paragraph ${n}. ` + "word ".repeat(150).trim();
  const long = Array.from({ length: 6 }, (_, i) => paragraph(i + 1)).join("\n\n");

  it("leaves sections under the cap alone", () => {
    expect(splitSection("short body")).toEqual(["short body"]);
  });

  it("splits oversized sections at paragraph boundaries within the cap", () => {
    const parts = splitSection(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(estimateTokens(part)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
    expect(parts[0]!.startsWith("Paragraph 1.")).toBe(true);
  });

  it("opens continuation parts with an overlap from the previous part", () => {
    const [first, second] = splitSection(long);
    const overlap = second!.split("\n\n")[0]!;
    expect(overlap.startsWith("…")).toBe(true);
    expect(first!.endsWith(overlap.slice(1))).toBe(true);
  });

  it("hard-splits a single paragraph longer than the cap", () => {
    const parts = splitSection("word ".repeat(3000).trim());
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(estimateTokens(part)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
  });
});

describe("chunkDocument", () => {
  it("numbers chunks sequentially and marks single-part sections", () => {
    const chunks = chunkDocument(v3);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    expect(chunks.every((c) => c.part === 1 && c.partCount === 1)).toBe(true);
  });

  it("prefixes embedding text with the document title and heading path", () => {
    const coastal = chunkDocument(v3).find((c) => c.sectionNumber === "2.2")!;
    const text = embeddingText("Underwriting Guidelines: Commercial Property (v3.0)", coastal);
    expect(text.split("\n").slice(0, 2)).toEqual([
      "Underwriting Guidelines: Commercial Property (v3.0)",
      "2. Binding Authority & TIV Limits > 2.2 Coastal Wind/Hail Zones (Tier 1 Counties)",
    ]);
  });
});
