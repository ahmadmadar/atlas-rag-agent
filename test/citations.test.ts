import { describe, expect, it } from "vitest";
import { checkCitations, extractCitations } from "../src/agent/citations.js";

describe("extractCitations", () => {
  it("parses single, header and multi-pair brackets, deduplicated in order", () => {
    const answer =
      "A [uw-guidelines-cp-v3 §2.2]. B [uw-guidelines-cp-v3 § header; uw-guidelines-cp-v2 §2.2]. C [uw-guidelines-cp-v3 §2.2].";
    expect(extractCitations(answer)).toEqual([
      { documentId: "uw-guidelines-cp-v3", section: "2.2" },
      { documentId: "uw-guidelines-cp-v3", section: "header" },
      { documentId: "uw-guidelines-cp-v2", section: "2.2" },
    ]);
  });

  it("ignores brackets without a section marker", () => {
    expect(extractCitations("See [the guidelines] and [1].")).toEqual([]);
  });
});

describe("checkCitations", () => {
  const retrieved = [
    { documentId: "uw-guidelines-cp-v3", section: "2.1" },
    { documentId: "uw-guidelines-cp-v3", section: "2.2" },
  ];

  it("accepts an exact section or a parent whose subsection was retrieved", () => {
    expect(checkCitations("[uw-guidelines-cp-v3 §2.2] [uw-guidelines-cp-v3 §2]", retrieved).ungrounded).toEqual([]);
  });

  it("rejects the same section number from a different document version", () => {
    expect(checkCitations("[uw-guidelines-cp-v2 §2.2]", retrieved).ungrounded).toEqual([
      { documentId: "uw-guidelines-cp-v2", section: "2.2" },
    ]);
  });

  it("does not treat §2 as a parent of §20", () => {
    const r = [{ documentId: "d", section: "20" }];
    expect(checkCitations("[d §2]", r).ungrounded).toHaveLength(1);
  });
});
