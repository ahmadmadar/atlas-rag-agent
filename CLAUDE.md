# CLAUDE.md

Context for Claude Code sessions on this project. Read this before making
changes.

## What this project is

An agentic RAG system for a fictional client, Atlas Underwriting (a
mid-size commercial insurance carrier). It answers questions grounded in
Atlas's own policy/compliance documents, always with citations, and
explicitly says "not found" rather than guessing when the corpus doesn't
support an answer. Portfolio piece for FDE/SE roles, built as a fast POC,
not a hardened production system — see docs/architecture.md for what
that scope tradeoff means in practice.

Retrieval is exposed via an agent with three tools, not a single-pass
lookup: search_knowledge_base, get_document_section, list_documents. The
agent iterates (retrieve, assess sufficiency, refine or answer) rather
than answering from whatever the first search returns. This is the
deliberate differentiator from naive RAG — don't simplify it back down
to single-pass without discussing first.

## Repo structure

Flat root. One deployed service, no separate dashboard for this one —
POC scope, not a second full product.

```
atlas-rag-agent/
├── src/
│   ├── tools/        # search_knowledge_base.ts, get_document_section.ts, list_documents.ts
│   ├── agent/         # the retrieve/assess/refine loop
│   ├── ingestion/      # chunking + embedding pipeline
│   ├── db/
│   └── server.ts
├── prisma/
│   ├── schema.prisma
│   └── seed.ts        # loads the fictional Atlas document corpus
├── corpus/             # the 5-7 fictional source documents
├── evals/
│   └── scenarios.json  # 10-12 scenarios, include multi-hop + unanswerable
├── docs/
│   ├── architecture.md
│   ├── demo-script.md
│   └── ai-assisted-delivery.md
└── README.md
```

## Hard technical conventions

- Embeddings: Voyage AI, not a default/generic choice — this is
  Anthropic's recommended embeddings provider, chosen deliberately.
- Iteration cap on the agent loop. Unbounded retrieve-and-reassess is a
  real cost/latency risk. Cap at 3 rounds; after that, answer with
  whatever's been gathered or explicitly say the corpus doesn't fully
  cover the question. Don't remove this cap without discussing.
- Citations are required in every answer, not optional formatting. If
  the agent can't cite a source for a claim, it shouldn't make the
  claim.
- No fallback API keys in source, fail closed if an env var is missing,
  never a guessable default.
- Single-agent architecture, not planner/orchestrator split — this was
  a deliberate decision, not an oversight. See docs/architecture.md's
  "Single-agent vs. planner/orchestrator split" section before
  suggesting a multi-agent refactor.
- Document authority/staleness policy — if documents conflict, this
  needs an explicit rule (e.g. most recent effective date wins),
  decided and documented, not left to whichever chunk scores highest in
  similarity search.

## Documentation habit

Log what got generated vs. what required an architectural decision, and
especially what got caught and fixed, in docs/ai-assisted-delivery.md.
Dated, specific engagement log entries, not vague summaries.

## Session workflow

- Version control via GitHub Desktop, not gh CLI. Branch per feature/
  task, not one long-running branch.
- Commits use conventional commit format in the summary field
  (feat:, fix:, docs:, test:), with a clear description in the body
  covering what changed and why, not just what changed.
- Each PR gets a short description covering what changed, how it was
  tested, and one line on the AI-assisted delivery split for that PR
  (what was generated vs. what required a decision).
- At the end of every session: run any relevant checks (tsc, tests if
  they exist yet), update CLAUDE.md's "Current build status" section
  to reflect what got built, and draft a dated engagement log entry
  for docs/ai-assisted-delivery.md summarizing the session, what was
  built, what required a real decision, anything caught and fixed.
  Show the draft for review before adding it, don't add it unprompted.
- Prefer scoped sessions, one task/feature per session, over one long
  running session covering multiple unrelated pieces of work.

## Current build status

Sessions 1-3 of six complete.

- Session 1 (committed on main): fictional corpus (corpus/, 7
  documents, including a deliberately conflicting v2/v3 pair to
  exercise the authority rule) and the decisions doc
  (docs/architecture.md: authority/staleness rule, "not found"
  threshold, chunking strategy).
- Session 2 (committed directly on main as a9e0be5, no branch/PR):
  ingestion pipeline.
  Local Postgres + pgvector via docker-compose on port 5433 (`npm run
  db:up`), Prisma schema (Document with effectiveDate/status/
  supersedes, Chunk with section metadata + `vector(1024)`), Zod env
  guard that fails closed, structural chunker (46 chunks, one per
  numbered section), Voyage `voyage-4` embeddings at 1024 dims,
  hash-based idempotent seed (`npm run db:seed`, `--force` to
  re-embed), and `npm run ingest:verify` for a retrieval sanity check.
  `tsc` clean, 18 vitest tests passing.
- Session 3 (branch `feat/agent-tool-loop`): agent + tool loop. Three
  tools in src/tools/ (each returned section carries effectiveDate/
  status/supersession; `get_document_section` takes a parent number or
  "header"). Hand-written Messages API loop on `claude-sonnet-5` in
  src/agent/agent.ts: a round is one tool-calling turn (parallel calls
  count once), cap of 3 enforced in code via `tool_choice: "none"`,
  round-count notice appended to each round's results. Citations are
  `[document_id §section]`, checked against sections tools actually
  returned (`grounded` flag); "not found" answers start with a fixed
  prefix (`NOT_FOUND_PREFIX`). Separate `getAgentEnv()` guard so
  ingestion doesn't require `ANTHROPIC_API_KEY`. CLI: `npm run ask --
  "q" [--json]`. Voyage 429 backoff now honors Retry-After / waits
  5-20s (account is on the 3 RPM no-payment tier). Live runs passed on
  v3-governs, historical v2-vs-v3, and the E&O trap. Open calibration
  point for session 4: one E&O run asserted "Atlas does not write E&O",
  stronger than the corpus supports. `tsc` clean, 38 tests passing.

Setup: `cp .env.example .env`, fill in `VOYAGE_API_KEY` and
`ANTHROPIC_API_KEY`, then `npm run db:up && npm run db:migrate && npm
run db:seed`.

Remaining build order: trimmed eval suite with 10-12 scenarios
(session 4, can consume `npm run ask -- --json` / `runAgent()` trace), deploy + demo script (session
5), docs + wrap (session 6). POC scope. The session workflow above is
in effect.
