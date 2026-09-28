# Atlas RAG Agent

An agentic RAG system I built that answers questions grounded in a
fictional insurance company's (Atlas Underwriting) policy and
compliance documents. Every answer is cited, and the agent explicitly
says "not found" when the corpus doesn't support one.

I built this using an AI-assisted delivery workflow (Claude Code). See
[docs/ai-assisted-delivery.md](docs/ai-assisted-delivery.md) for what I
generated vs. what I architected.

## What this demonstrates

- **Agentic retrieval**, not single-pass RAG: an iterative
  retrieve/assess/refine loop across three tools
  (`search_knowledge_base`, `get_document_section`, `list_documents`),
  capped at 3 rounds.
- **Citation-required generation**: if the agent can't cite a source
  for a claim, it doesn't make the claim. It refuses rather than
  answering on thin evidence.
- **A deliberate architecture decision against a planner/orchestrator
  split**: I chose single-agent by design. I documented the reasoning
  for when that pattern would actually be justified in
  [docs/architecture.md](docs/architecture.md).
- **Business/domain decisions I made explicitly**, not left to
  defaults: a document authority and staleness rule for conflicting
  policy versions, a structural (not fixed-token) chunking strategy,
  and the iteration cap above.

## Quickstart

Requires Docker and Node 20+.

```bash
cp .env.example .env   # fill in VOYAGE_API_KEY and ANTHROPIC_API_KEY
npm install
npm run db:up && npm run db:migrate && npm run db:seed
npm run ask -- "What is the maximum TIV a field underwriter can bind in a Tier 1 coastal county?"
```

`npm run ask` prints the answer, the tool calls from each round, and
the citation check. Add `--json` for the full structured result.

## Docs

- [Architecture](docs/architecture.md): the technical and business
  decisions behind the system
- `docs/demo-script.md`: not yet written
- [AI-assisted delivery log](docs/ai-assisted-delivery.md): what I
  generated vs. what required a decision, session by session

## Status

I've completed sessions 1-3 of a planned six-session build: the
fictional corpus and decisions doc, the ingestion pipeline (Voyage
embeddings in pgvector), and the agent with its three tools, 3-round
cap and citation check, runnable from the CLI. I haven't yet built the
eval suite, deployment, or demo script.

## Live links

- Deployed URL: _TBD_
- Demo video / screenshot: _TBD_
