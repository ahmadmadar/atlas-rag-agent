import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";

// Frontmatter fields every corpus document must carry. These drive the
// document authority/staleness rule in docs/architecture.md.
const FrontmatterSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    docType: z.string().min(1),
    lineOfBusiness: z.string().min(1),
    effectiveDate: z.coerce.date(),
    status: z.enum(["active", "superseded"]),
    version: z.coerce.string(),
    supersedes: z.string().min(1).optional(),
    supersededBy: z.string().min(1).optional(),
  })
  .refine((fm) => fm.status !== "superseded" || fm.supersededBy, {
    message: "a superseded document must name its replacement in `supersededBy`",
  });

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

export interface CorpusDocument {
  frontmatter: Frontmatter;
  body: string; // markdown after the frontmatter block
  sourcePath: string; // repo-relative, e.g. "corpus/claims-handling-policy.md"
  contentHash: string;
}

export async function loadCorpus(corpusDir: string): Promise<CorpusDocument[]> {
  const files = (await readdir(corpusDir)).filter((f) => f.endsWith(".md")).sort();
  const docs: CorpusDocument[] = [];

  for (const file of files) {
    const fullPath = path.join(corpusDir, file);
    const raw = await readFile(fullPath, "utf8");
    const { data, content } = matter(raw);
    const parsed = FrontmatterSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Invalid frontmatter in ${file}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    docs.push({
      frontmatter: parsed.data,
      body: content,
      sourcePath: path.posix.join(path.basename(corpusDir), file),
      contentHash: createHash("sha256").update(raw).digest("hex"),
    });
  }

  validateSupersession(docs);
  return docs;
}

// The supersession pointers are declared on both sides in the corpus
// (v2 says supersededBy v3, v3 says supersedes v2). If they disagree, the
// authority rule would be working from bad data, so refuse to ingest.
export function validateSupersession(docs: CorpusDocument[]): void {
  const byId = new Map<string, Frontmatter>();
  for (const { frontmatter: fm, sourcePath } of docs) {
    if (byId.has(fm.id)) throw new Error(`Duplicate document id "${fm.id}" (${sourcePath})`);
    byId.set(fm.id, fm);
  }

  for (const fm of byId.values()) {
    if (fm.supersedes) {
      const older = byId.get(fm.supersedes);
      if (!older) throw new Error(`"${fm.id}" supersedes unknown document "${fm.supersedes}"`);
      if (older.supersededBy !== fm.id) {
        throw new Error(`"${fm.id}" supersedes "${older.id}", but "${older.id}" does not name it in supersededBy`);
      }
      if (older.status !== "superseded") {
        throw new Error(`"${older.id}" is superseded by "${fm.id}" but its status is "${older.status}"`);
      }
      if (fm.effectiveDate <= older.effectiveDate) {
        throw new Error(`"${fm.id}" supersedes "${older.id}" but does not have a later effectiveDate`);
      }
    }
    if (fm.supersededBy) {
      const newer = byId.get(fm.supersededBy);
      if (!newer) throw new Error(`"${fm.id}" is supersededBy unknown document "${fm.supersededBy}"`);
      if (newer.supersedes !== fm.id) {
        throw new Error(`"${fm.id}" names "${newer.id}" in supersededBy, but "${newer.id}" does not name it in supersedes`);
      }
    }
  }
}
