# AI-Assisted Delivery Log

Claude Code handles scaffolding and implementation drafts, architecture
and business logic decisions stay mine, and what gets caught and fixed
gets logged honestly here — dated, specific entries, not vague
summaries.

## What Claude Code generated

- [x] Fictional document corpus (AI-drafted, human-reviewed for the
      deliberate conflicts needed to test the authority rule)
- [ ] Prisma schema + pgvector setup
- [ ] Ingestion pipeline (chunking, embedding calls)
- [ ] Tool implementations (search_knowledge_base, get_document_section,
      list_documents)
- [ ] Agent loop scaffolding
- [ ] Eval scenarios first draft

## What required architectural decisions (mine, not generated)

- Document authority/staleness rule: most-recent-`effectiveDate` wins,
  `status` field as the fast path, superseded docs kept in-corpus for
  audit trail rather than deleted. See docs/architecture.md.
- "Not found" threshold: judged by topical responsiveness during the
  agent's sufficiency-assessment step, not a bare similarity-score
  cutoff. See docs/architecture.md.
- Chunking strategy: structural (by numbered section heading), not
  fixed token windows — chosen so a limit and its qualifying condition
  never get split across chunks, and so citations reference a section
  number an underwriter would recognize. See docs/architecture.md.
- Single-agent vs. planner/orchestrator split (decided; write-up
  deferred to session 6 per docs/architecture.md).
- Decision to skip a separate dashboard for this project (POC scope,
  per CLAUDE.md).

## What Claude Code got wrong (and what that shows)



## Engagement log

**2026-09-24 — Session 1: corpus + decisions doc.** Built the 7-document
fictional Atlas corpus and docs/architecture.md. The corpus includes a
deliberate versioned conflict (Commercial Property Underwriting
Guidelines v2 vs. v3 — differing TIV binding limits, coastal deductible
percentages, and roof-age inspection triggers) specifically to exercise
the authority/staleness rule once the agent loop exists, plus one
line/topic (professional liability / E&O as an Atlas product, distinct
from the producer's own E&O requirement) deliberately absent from the
corpus to serve as the unanswerable eval scenario in session 4. Wrote
up the three business-logic decisions the guideline doc flagged as
needing an explicit rule rather than an implicit one: document
authority/staleness, the "not found" threshold, and chunking strategy —
all in docs/architecture.md, reasoning included, not just the
conclusion.
