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

All six sessions complete. POC finished.

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
- Session 3 (merged via PR #1, d038a18): agent + tool loop. Three
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
- Session 4 (branch `feat/eval-suite`): eval suite. 12 scenarios in
  evals/scenarios.json (lookup, authority x3, historical, multi-hop x3,
  unanswerable x2, partial), expected values from corpus text.
  `npm run eval -- --variant <baseline|vN> --reps 3` runs `runAgent()`
  and grades: status, key facts, required citations + grounding, and an
  Opus 5 claims judge (evals/grade.ts; hand-written JSON schema, sees
  section headings, fails unstated qualifiers). `eval:judge-check` = 12
  calibration probes; `eval:regrade` re-grades stored traces without
  re-running the agent. Output in evals/runs/<variant>/ (results.jsonl,
  errors.jsonl, change.md/.patch; traces gitignored). Results: baseline
  86%, v1 (stricter prompt) 76% with status unchanged, v2 90% with
  status 100%. v2 ships: final answer is structured JSON
  `{status, answer}` via `output_config.format`; `NOT_FOUND_PREFIX` is
  now display-only (CLI) plus legacy parsing in regrade. Also fixed:
  citation parser now reads `[doc §4, §3]`. Top remaining failure:
  claims beyond retrieved text, sometimes stale v2 figures cited to v3
  (caught by grounding check + judge). Free Voyage tier causes
  occasional 300s timeouts (logged, not scored). `tsc` clean, 72 tests.
- Session 5 (2026-09-29, PRs #3-#7): deploy + demo. Live at
  https://atlas-rag-agent.onrender.com. `src/server.ts` + `src/http/`
  (plain node:http). `POST /api/ask` streams NDJSON (one event per round
  via the agent's `onRound` hook, then the result); `GET /api/section`
  serves cited section text; `GET /api/health`. Static page in
  `public/` (no framework, strict CSP, fixed file allowlist): sample
  questions, live round trace, status/grounding badges, citations open
  the source with effective date and superseded badge. Tool error detail
  is replaced with a generic message in the browser and logged
  server-side. Limits: 5 questions/visitor/10 min and 2 concurrent (in
  memory), 100/day global in the `DailyUsage` table (atomic
  increment-with-cap, fails closed with 503). Hosting is free tier only
  (user decision): Render free web service from `render.yaml`
  (migrations run in the build command, no pre-deploy on free), database
  on Neon free tier (Render allows one free Postgres per workspace and
  expires it after 30 days); DATABASE_URL is a dashboard secret. Free
  tier costs: ~15 min idle sleep then a cold start, and Voyage's 3 RPM
  limit can stall a round for up to 35s when questions come back to back
  (agent recovers via other tools; adding a Voyage payment method fixes
  it, user undecided). Note: importing `@prisma/client` loads the repo
  `.env` itself, so an `env -i` boot test doesn't exercise the env
  guard; set vars to empty strings instead. docs/demo-script.md (2-min
  walkthrough), README leads with live link, results table and
  screenshots in docs/images/. `tsc` clean, 88 tests.
- Session 6 (2026-09-30, branch `docs/session-6-wrap`, one PR for all
  docs per user preference): docs + wrap. docs/client-brief.md (problem,
  what I built, measured results, what production would need). Four
  Mermaid-rendered PNGs in docs/images/ (01 plain-language overview and
  collapsed 02 technical architecture in the README "How it works"
  section; 02 at the top of docs/architecture.md, 03 agent loop in the
  loop section, 04 eval pipeline in the Evaluation section). Diagrams
  1-3 were regenerated after review found three errors (cap shown as
  always "not found", Voyage missing from the query path, a decision
  diamond with two No exits). README: "Limits and what I'd do next"
  section, Status marked complete, no demo video (user may add later).
  docs/ai-assisted-delivery.md summary sections brought up to date
  across all six sessions. Voyage stays on the free tier, documented as
  a known limit. No code changes; `tsc` clean, 88 tests.

Setup: `cp .env.example .env`, fill in `VOYAGE_API_KEY` and
`ANTHROPIC_API_KEY`, then `npm run db:up && npm run db:migrate && npm
run db:seed`.

Build order complete. Candidate follow-ups, not scheduled: reduce
claims beyond retrieved text (retry on a failed citation check),
measured as the next eval variant (v3); a demo video; a Voyage payment
method to remove the 3 RPM stalls. POC scope. The session workflow above is
in effect.
