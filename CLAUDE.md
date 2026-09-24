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

Session 1 of six complete: fictional corpus (corpus/, 7 documents,
including a deliberately conflicting versioned pair to exercise the
authority rule) and the decisions doc (docs/architecture.md — document
authority/staleness rule, "not found" threshold, chunking strategy) are
done. Not yet committed to git.

Remaining build order: ingestion pipeline (chunking, Voyage AI
embeddings, pgvector storage), agent + tool loop, trimmed eval suite
(10-12 scenarios), deploy + demo script, docs + wrap. POC scope. The
session workflow above is in effect.
