# AI-Assisted Delivery Log

I use Claude Code for scaffolding and implementation drafts. The
architecture and business logic decisions stay mine, and I log what
got caught and fixed honestly here, as dated, specific entries rather
than vague summaries.

## What Claude Code generated

- [x] Fictional document corpus (AI-drafted, then reviewed by me for
      the deliberate conflicts I needed to test the authority rule)
- [x] Prisma schema + pgvector setup
- [x] Ingestion pipeline (chunking, embedding calls)
- [ ] Tool implementations (search_knowledge_base, get_document_section,
      list_documents)
- [ ] Agent loop scaffolding
- [ ] Eval scenarios first draft

## What required architectural decisions (mine, not generated)

- Document authority/staleness rule: I decided the most recent
  `effectiveDate` wins, with the `status` field as the fast path, and
  that superseded docs stay in the corpus for the audit trail rather
  than being deleted. See docs/architecture.md.
- "Not found" threshold: I decided the agent judges topical
  responsiveness during its sufficiency-assessment step, rather than
  relying on a bare similarity-score cutoff. See docs/architecture.md.
- Chunking strategy: I chose structural chunking (by numbered section
  heading) over fixed token windows, so a limit and its qualifying
  condition never get split across chunks, and so citations reference
  a section number an underwriter would recognize. See
  docs/architecture.md.
- Single-agent vs. planner/orchestrator split: decided, with the
  write-up deferred to session 6 per docs/architecture.md.
- I decided to skip a separate dashboard for this project (POC scope,
  per CLAUDE.md).

## What Claude Code got wrong (and what that shows)

- Session 2, chunker token budget: the first draft of the chunker
  reserved room for the 50-token overlap but not for the ellipsis and
  paragraph break that join it to the continuation chunk, so a split
  section could produce a 501-token chunk against a 500-token cap.
  Claude Code caught it on self-review before the tests ran and fixed
  the budget. What that shows: off-by-one sizing errors hide in the
  glue between pieces, not the pieces themselves, and the only thing
  exercising this path is the unit tests, since no real corpus section
  comes close to the cap.

## Engagement log

**2026-09-24, Session 1: corpus + decisions doc.** I built the
7-document fictional Atlas corpus and docs/architecture.md. I included
a deliberate versioned conflict in the corpus: Commercial Property
Underwriting Guidelines v2 vs. v3, which differ on TIV binding limits,
coastal deductible percentages, and roof-age inspection triggers. It's
there specifically to exercise the authority/staleness rule once the
agent loop exists. I also left one line deliberately absent from the
corpus, professional liability / E&O as an Atlas product (distinct from
the producer's own E&O requirement), to serve as the unanswerable eval
scenario in session 4. I wrote up the three business-logic decisions
that needed an explicit rule rather than an implicit one: document
authority/staleness, the "not found" threshold, and chunking strategy.
All three are in docs/architecture.md, with my reasoning included, not
just the conclusion.

**2026-09-28, Session 2: ingestion pipeline.** I built the pipeline
that turns the corpus into searchable, citable chunks: Postgres with
pgvector in Docker, a Prisma schema carrying each document's
`effectiveDate`, `status` and supersession link, a structural chunker,
Voyage `voyage-4` embeddings at 1024 dimensions, and a re-runnable seed
that skips re-embedding unchanged documents (content hash). The full
corpus embeds as 46 section-level chunks for about 3.1k Voyage tokens.

Decisions I made this session: I store supersession once, on the newer
document, so v2 and v3 can't disagree in the database, and ingestion
refuses to run if the corpus frontmatter declares a one-sided link. I
skipped a vector index because an exact scan over 46 rows is faster and
exact at this scale. I estimated token counts instead of adding a
tokenizer, because the 500-token cap is a sizing target, not a model
limit. I kept each document's status header as its own chunk so
"Superseded by v3.0" is searchable.

What the verify run showed: v3 and v2 Section 2.2 score 0.641 vs 0.634
on the coastal TIV question, which confirms the authority rule has to
be the agent's reasoning step and can't be left to ranking. The E&O
question returns the producer's E&O requirement as the top hit at
0.508, with real answers scoring in the 0.53 to 0.64 range, which
confirms that a bare similarity cutoff wouldn't work for "not found."

Caught and fixed: while reviewing its own generated chunker, Claude
Code found that a continuation chunk could land at 501 tokens (the
overlap plus the ellipsis and paragraph break pushed it past the cap),
fixed the budget, and added a test for it. Gap noted: no corpus section
is longer than about 107 tokens, so the oversized-section split path is
only exercised by unit tests, not real data.
