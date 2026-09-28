import type { Prisma } from "@prisma/client";
import { getPrisma } from "../db/client.js";
import { isoDate, type DocumentAuthority } from "./types.js";

// Loads authority metadata for the given documents (or all of them),
// resolving the supersession link in both directions.
export async function loadAuthority(documentIds?: string[]): Promise<Map<string, DocumentAuthority>> {
  const where: Prisma.DocumentWhereInput = documentIds ? { id: { in: documentIds } } : {};
  const docs = await getPrisma().document.findMany({
    where,
    include: { supersededBy: { select: { id: true } } },
    orderBy: { id: "asc" },
  });
  return new Map(
    docs.map((d) => [
      d.id,
      {
        documentId: d.id,
        title: d.title,
        version: d.version,
        effectiveDate: isoDate(d.effectiveDate),
        status: d.status === "ACTIVE" ? "active" : "superseded",
        supersedes: d.supersedesId,
        supersededBy: d.supersededBy?.id ?? null,
      },
    ]),
  );
}
