import { describe, expect, it } from "vitest";
import { matchesSection } from "../src/tools/get_document_section.js";
import { SearchInput } from "../src/tools/search_knowledge_base.js";

describe("matchesSection", () => {
  it("matches the section and its subsections only", () => {
    expect(matchesSection("2", "2")).toBe(true);
    expect(matchesSection("2.1", "2")).toBe(true);
    expect(matchesSection("2.2", "2.2")).toBe(true);
    expect(matchesSection("20", "2")).toBe(false);
    expect(matchesSection("2.2", "2.1")).toBe(false);
  });

  it("maps 'header' to the null-section status block", () => {
    expect(matchesSection(null, "header")).toBe(true);
    expect(matchesSection(null, "1")).toBe(false);
    expect(matchesSection("1", "header")).toBe(false);
  });
});

describe("SearchInput", () => {
  it("defaults top_k and bounds it", () => {
    expect(SearchInput.parse({ query: "x" }).top_k).toBe(5);
    expect(() => SearchInput.parse({ query: "x", top_k: 50 })).toThrow();
    expect(() => SearchInput.parse({ query: "" })).toThrow();
  });
});
