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

For the web page, run `npm run dev` and open http://localhost:3000
(set `PORT` to use another port).

To run the eval suite (12 scenarios x 3 runs, about $1.40 and 25
minutes on Voyage's free tier):

```bash
npm run eval -- --variant v3 --reps 3   # baseline, v1, v2 are recorded; each change gets the next vN
npm run eval:judge-check                # confirms the claims judge on known answers
```

## Deploying

The app runs on Render's free tier from [render.yaml](render.yaml): one
web service and one Postgres instance. Free tier tradeoffs: the service
sleeps after 15 minutes idle (the first request after that waits for a
cold start), and the free database expires 30 days after creation.

1. In the Render dashboard, create a Blueprint from this repo. Enter
   `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` when prompted.
2. Each deploy builds the app and runs `prisma migrate deploy`, which
   creates the tables and the pgvector extension the first time.
3. Seed the hosted database once from your machine, using the
   database's External Database URL from the Render dashboard:

   ```bash
   DATABASE_URL="<external database url>" npm run db:seed
   ```

   A `DATABASE_URL` set on the command line takes precedence over the
   one in `.env`.

When the free database expires, delete it in the dashboard, re-sync
the Blueprint to create a new one, and repeat step 3.

Pushes to `main` redeploy automatically. The public endpoint is capped
at 5 questions per visitor per 10 minutes and 100 per day in total
(see `src/http/limits.ts`). The daily count is stored in Postgres, so
it holds when the free instance sleeps and restarts. For a hard stop
regardless of the app, also set a monthly spend limit on the Anthropic
account behind `ANTHROPIC_API_KEY`.

## Docs

- [Architecture](docs/architecture.md): the technical and business
  decisions behind the system
- `docs/demo-script.md`: not yet written
- [AI-assisted delivery log](docs/ai-assisted-delivery.md): what I
  generated vs. what required a decision, session by session

## Status

I've completed sessions 1-4 of a planned six-session build: the
fictional corpus and decisions doc, the ingestion pipeline (Voyage
embeddings in pgvector), the agent with its three tools, 3-round cap
and citation check, and an eval suite that measured it. The current
agent passes 90% (±13) of 12 scenarios across 3 runs each, with answer
status correct on every graded attempt; the evaluation section of
docs/architecture.md has the numbers and what they do and don't show.
I haven't yet built the deployment or demo script.

## Live links

- Deployed URL: _TBD_
- Demo video / screenshot: _TBD_
