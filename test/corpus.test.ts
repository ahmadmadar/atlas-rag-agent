import { describe, expect, it } from "vitest";
import { loadCorpus, validateSupersession, type CorpusDocument } from "../src/ingestion/corpus.js";

const doc = (fm: Partial<CorpusDocument["frontmatter"]> & { id: string }): CorpusDocument => ({
  frontmatter: {
    title: fm.id,
    docType: "policy",
    lineOfBusiness: "all-lines",
    effectiveDate: new Date("2024-01-01"),
    status: "active",
    version: "1.0",
    ...fm,
  },
  body: "",
  sourcePath: `corpus/${fm.id}.md`,
  contentHash: fm.id,
});

describe("loadCorpus", () => {
  it("loads all seven corpus documents with valid frontmatter", async () => {
    const docs = await loadCorpus("corpus");
    expect(docs).toHaveLength(7);
    const v2 = docs.find((d) => d.frontmatter.id === "uw-guidelines-cp-v2")!;
    expect(v2.frontmatter.status).toBe("superseded");
    expect(v2.frontmatter.supersededBy).toBe("uw-guidelines-cp-v3");
    expect(v2.frontmatter.effectiveDate.toISOString().slice(0, 10)).toBe("2023-03-01");
    expect(v2.sourcePath).toBe("corpus/underwriting-guidelines-commercial-property-v2.md");
  });
});

describe("validateSupersession", () => {
  const old = { id: "old", status: "superseded" as const, supersededBy: "new", effectiveDate: new Date("2023-01-01") };
  const fresh = { id: "new", supersedes: "old", effectiveDate: new Date("2025-01-01") };

  it("accepts a consistent pair", () => {
    expect(() => validateSupersession([doc(old), doc(fresh)])).not.toThrow();
  });

  it("rejects a one-sided link", () => {
    expect(() => validateSupersession([doc({ ...old, supersededBy: undefined, status: "active" }), doc(fresh)])).toThrow(/does not name it/);
  });

  it("rejects a superseding document that isn't newer", () => {
    expect(() => validateSupersession([doc(old), doc({ ...fresh, effectiveDate: new Date("2022-01-01") })])).toThrow(/later effectiveDate/);
  });

  it("rejects a superseded document still marked active", () => {
    expect(() => validateSupersession([doc({ ...old, status: "active" }), doc(fresh)])).toThrow(/status is "active"/);
  });

  it("rejects duplicate ids", () => {
    expect(() => validateSupersession([doc({ id: "a" }), doc({ id: "a" })])).toThrow(/Duplicate/);
  });
});
