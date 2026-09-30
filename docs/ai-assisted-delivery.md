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
- [x] Tool implementations (search_knowledge_base, get_document_section,
      list_documents)
- [x] Agent loop scaffolding, citation parser and grounding check
- [x] Eval scenarios first draft (expected answers checked by me
      against the corpus text), the eval runner, and the claims judge
- [x] HTTP server, static web page, rate limits and the Render Blueprint
- [x] Unit tests (18 after session 2, 88 after session 5)
- [x] First drafts of the README, demo script and client brief, which
      I reviewed and edited

## What required architectural decisions (mine, not generated)

- Document authority/staleness rule: I decided the most recent
  `effectiveDate` wins, with the `status` field as the fast path, and
  that superseded docs stay in the corpus for the audit trail rather
  than being deleted. I store the supersession link once, on the newer
  document, so v2 and v3 can't disagree in the database. See
  docs/architecture.md.
- "Not found" threshold: I decided the agent judges topical
  responsiveness during its sufficiency-assessment step, rather than
  relying on a bare similarity-score cutoff. See docs/architecture.md.
- Chunking strategy: I chose structural chunking (by numbered section
  heading) over fixed token windows, so a limit and its qualifying
  condition never get split across chunks, and so citations reference
  a section number an underwriter would recognize. See
  docs/architecture.md.
- Single-agent vs. planner/orchestrator split: I kept one agent,
  because the hardest step (deciding whether v2 or v3 governs) needs
  both versions in the same context. I wrote down when I'd revisit it
  in docs/architecture.md.
- Hand-written loop over an SDK: I wrote the agent loop on the
  Messages API instead of using the Claude Agent SDK, so the round cap
  and the per-round trace the evals assert on live in my own code.
- Round cap semantics: a round is one model turn, so parallel tool
  calls cost one round, and I enforce the 3-round cap in code with
  `tool_choice: "none"` rather than trusting the prompt.
- Citation grounding: a fixed `[document_id §section]` format, checked
  against the sections tools actually returned in that run, so a
  citation to the right section in the wrong version fails.
- Eval design: 12 scenarios at about ±13 points (POC scope), expected
  answers from the corpus text, and a claims judge on a different model
  (Opus 5) from the one under test. I decided an unstated qualifier
  ("per occurrence" on a sublimit) counts as a failure.
- Answer status as a structured field: when the "not found" prefix
  landed mid-answer, I measured a stricter prompt (no change) against a
  structured `{status, answer}` output (fixed by construction), and
  rejected a paragraph-scanning heuristic that would have misclassified
  partial answers.
- Public endpoint limits: I required per-visitor, concurrency and daily
  caps before deploying, with the daily count in Postgres so it
  survives the free instance sleeping, and failing closed if it can't
  be read.
- Free tiers only: I chose free Render and Neon over paid plans, and
  left Voyage on its free tier, documenting the cold start and
  rate-limit stalls as known limits rather than paying to hide them.
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
- Session 3, embedding retry: the generated retry gave up after about
  7 seconds, too short for Voyage's per-minute limit. The agent
  recovered by switching tools, which hid the failure: the E&O run
  never actually faced the trap it was meant to test. What that shows:
  a run that looks like it passed can have skipped the thing it was
  testing, so I read the trace, not just the answer.
- Session 4, grader bugs: the judge's output schema silently lost its
  pass/fail constraint (the SDK's Zod helper and this project's Zod
  version didn't agree), the judge couldn't see section headings, and
  the citation parser dropped citations written as `[doc §4, §3]`. Two
  of the baseline's failures were these bugs, not the agent. What that
  shows: generated grading code needs its own tests before its numbers
  mean anything, which is why the judge now has 12 calibration probes.
- Session 5, error leakage: the first server draft streamed raw tool
  errors, which can carry database details, to the browser. Replacing
  them with a generic message then left them logged nowhere, which the
  live smoke test exposed. What that shows: generated code optimizes
  for working, and what it exposes (or stops recording) needs a
  deliberate review.
- Session 5, secret in the conversation: Claude Code suggested seeding
  the production database through the session's `!` prefix, which
  would have put the database URL, password included, into the
  conversation. I ran it in a separate terminal instead. What that
  shows: an assistant with a terminal doesn't weigh where a secret
  ends up unless I do.
- Session 5, a boot test that couldn't fail: the fail-closed env check
  passed with an empty environment only because importing Prisma's
  client loads `.env` by itself. The guard was fine; the test wasn't
  testing it. What that shows: a passing test needs a reason to
  believe it could have failed.
- Session 5, the product's own failure in prose: the first draft of the
  demo script had me saying "Atlas doesn't write E&O", the same
  overstatement the eval judge is calibrated to fail. What that shows:
  the claims-beyond-the-source failure isn't specific to the agent, so
  I check generated docs against the corpus the same way.
- Smaller slips, all caught in review: corpus Markdown bold that would
  have rendered as literal asterisks, a README edit that split the
  Quickstart section, and a Neon config change that missed the PR it
  belonged in.

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

**2026-09-28, Session 3: agent + tool loop.** I built the agent that
answers questions from the corpus: three tools (`search_knowledge_base`,
`get_document_section`, `list_documents`) and a single
retrieve/assess/refine loop on Claude Sonnet 5, runnable with `npm run
ask`. Every section a tool returns carries its document's effective
date, status and supersession link, so the agent can apply the
authority rule without an extra lookup.

Decisions I made this session: I wrote the loop by hand on the Messages
API instead of using the Claude Agent SDK, because I wanted the 3-round
cap and a per-round trace (which the evals will assert on) in my own
code. I defined a round as one model turn, so fetching v2 and v3 of a
section in parallel costs one round, not two. I enforce the cap in
code: after round 3 the request sets `tool_choice: "none"`, so the cap
holds even if the model ignores the prompt. I made citations a fixed
`[document_id §section]` format and check every one against the
sections the tools actually returned in that run, which catches a
citation to the right section number in the wrong version. I gave the
agent key its own env guard so ingestion doesn't require it. I also
wrote up the single-agent decision in docs/architecture.md, which I'd
left as an empty heading.

What the live runs showed: the coastal TIV question came back from v3
($8M, 5%) with v2's $5M noted as superseded. A historical roof-age
question correctly cited both versions. The E&O trap worked: search
returned the producer E&O section, and the agent said "not found" and
explained why that section was a different E&O. All three answers
matched the source text when I checked them.

Caught and fixed: running two questions at once hit Voyage's free-tier
limit (3 requests per minute), and the embedding retry gave up after
about 7 seconds, too short for a per-minute limit. The agent recovered
by switching tools, but that meant the E&O run never actually faced the
trap, so I reran it. The retry now honors `Retry-After` and backs off 5
to 20 seconds. Open for session 4: one E&O run stated "Atlas does not
write E&O," which is stronger than the corpus supports. I'll measure
that in the evals rather than tune the prompt on a single example.

**2026-09-28, Session 4: eval suite.** I built a 12-scenario eval for
the agent (lookup, three authority-rule cases where v2 and v3 disagree,
a historical case, three multi-hop cases, two unanswerable cases, one
partial), with expected answers taken from the corpus text rather than
from any model's output. Each scenario runs 3 times through the real
`runAgent()` entry point. An attempt passes only if status, key facts,
required citations and citation grounding all check out in code, and a
claims judge (Claude Opus 5, deliberately not the Sonnet 5 model under
test) finds no claim the cited sections don't support.

Decisions I made this session: I kept the suite at 12 scenarios per the
POC scope and accepted a margin of about ±13 points, enough to catch a
broken behavior but not to rank small tweaks. I added the judge because
the failure I care most about, an answer going beyond its source,
passes every string check; the session 3 "Atlas does not write E&O"
overstatement is one of its calibration probes. I decided that a
qualifier the source doesn't state ("per occurrence" on a sublimit) is
a failure, because it changes what the limit means. When the baseline
showed the "not found" prefix landing mid-answer, I measured two fixes
instead of assuming one. A stricter prompt (v1) changed nothing. Making
status a structured JSON field (v2) fixed it by construction. I
rejected a paragraph-moving heuristic because it would have
misclassified partial answers.

Results: baseline 86%, v1 76% (status unchanged at 92%), v2 90% with
status correct on all 34 graded attempts and both unanswerable
scenarios passing 3 of 3. v2 ships. Its overall gain over baseline is
within noise; the status fix is not a statistical claim. The most
common failure now is the agent adding claims beyond what it retrieved.
In one case it stated the superseded $5M Tier 1 limit as current and
cited v3 for it. The citation check and the judge caught that
independently.

Caught and fixed: reading every failure in the first baseline found
that two of them were grader bugs, not agent bugs. The judge's output
schema had silently lost its pass/fail constraint (the SDK's Zod helper
and the Zod version in this project didn't agree), the judge couldn't
see section headings, and the agent's own citation parser dropped
citations written as `[doc §4, §3]`. I fixed all three, added
calibration probes for each, and re-graded the stored answers instead
of re-running the agent, so baseline, v1 and v2 are scored by the same
grader. Separately, the judge passed the same "per occurrence" answer
once and failed it once; writing the qualifier rule down made it
consistent. Gap: Voyage's free tier makes a full run take about 25
minutes, inflates latency, and caused occasional 300-second timeouts,
which are logged as errors, not scored.

**2026-09-29, Session 5: deploy and demo.** I took the agent from a CLI
to a public web demo at atlas-rag-agent.onrender.com. Claude Code
generated the HTTP server (plain `node:http`), the static page, the
Render Blueprint, the demo script, and tests (72 to 88). The agent loop
is unchanged apart from an `onRound` callback, which lets the server
stream each round to the browser as it finishes. Citations on the page
open the cited section's source text with its effective date and a
superseded badge. Clicking a v2 citation shows the authority rule on
screen.

Decisions I made: a public endpoint spends my API budget, so I required
limits before deploying. The limits are 5 questions per visitor per 10
minutes, 2 runs at once, and 100 questions a day in total, plus a
monthly spend limit on the Anthropic account as the hard stop. I chose
free tiers over about $13/month in paid plans because this is a POC,
and I made each consequence an explicit decision:

- Render's free instance sleeps when idle, which would reset an
  in-memory counter. So the daily cap lives in Postgres, as one SQL
  statement that checks and increments, and it refuses questions if the
  count can't be read.
- Render allows one free Postgres per workspace, which my other project
  uses, and expires it after 30 days. So the database is on Neon's free
  tier.
- Free instances have no pre-deploy step, so migrations run in the
  build.

I haven't added a Voyage payment method yet. The live smoke test showed
what that costs: when questions come back to back, the 3-per-minute
embedding limit can stall a round for up to 35 seconds. The agent
recovered by reading sections directly, but one answer took 50 seconds.

Caught and fixed:

- A boot test with an empty environment passed the fail-closed key
  check. The cause was that importing Prisma's generated client loads
  the repo's `.env` by itself; the guard was fine, the test wasn't.
- Raw tool errors, which can carry database details, were streamed to
  the browser. I replaced them with a generic message. The live smoke
  test then showed the detail wasn't logged anywhere either, so I
  couldn't diagnose the rate-limit failures from Render's logs. Failed
  tool calls are now logged on the server.
- Corpus Markdown bold would have rendered as literal asterisks.
- A README edit had split the Quickstart section.
- The Neon change missed the PR it belonged in. I caught it before
  creating the Blueprint, which would otherwise have tried to create a
  second free Render database.

Claude Code got two things wrong that I caught:

- It suggested seeding through the session's `!` prefix, which would
  have put the database URL, password included, into the conversation.
  I ran it in a separate terminal with a hidden prompt instead.
- The first draft of the demo script had me saying "Atlas doesn't write
  E&O". That's the same overstatement the eval judge is calibrated to
  fail: the documents only show that E&O isn't covered.

Verification:

- 20 simultaneous increments against a cap of 3 let exactly 3 through.
- With the day marked full, the live server returned 429 without
  running the agent.
- All four demo questions returned the right answer status with
  citations verified on the live deploy.

**2026-09-30, Session 6: docs + wrap.** I finished the portfolio
framing. There were no code changes. Claude Code drafted a client brief
(docs/client-brief.md) written for Atlas's underwriting and compliance
leads. It covers the problem (rules that change while old versions stay
on file, and the cost of a confident wrong answer), what I built, the
measured results, and what a production rollout would need. It also
added a "Limits and what I'd do next" section to the README and marked
the project complete. I generated four architecture diagrams in a
separate chat from a prompt Claude Code wrote with the system's facts
in it: a plain-language overview, the technical architecture, the
agent loop, and the eval pipeline. Claude Code placed each one next to
the decision it illustrates. Claude Code also added a "Path to
production" section to docs/architecture.md, which covers SSO with
access filtering in retrieval, an immutable audit trail, a document
approval workflow, evals as a CI gate, observability, and
infrastructure choices, with example tools named as common options
rather than ones I've tested.

Decisions I made: I left Voyage on its free tier and documented the
rate-limit stalls as a known limit, rather than paying to hide them in
a demo. I left out a demo video for now. I put all of the session's doc
changes on one branch and PR, since splitting them into four gave a
reviewer nothing extra. I put the plain-language diagram first in the
README and collapsed the technical one, so a non-engineer sees how it
works before seeing how it's built. I put the production plan in the
architecture doc rather than the client brief, since its readers are
technical and the brief's are not.

Caught and fixed:

- Claude Code checked the first set of diagrams against the code and
  found three errors. The overview showed hitting the 3-round cap as
  always meaning "not found", when the agent is actually forced to
  answer with whatever it found. The architecture diagram left Voyage
  off the query path, which hid where the free-tier stall comes from.
  The agent loop diagram had a decision with two "No" exits and another
  with only a "Yes". I regenerated all three with a corrected prompt,
  and the second versions matched the code.
- I noticed that the summary sections at the top of this log had
  stopped after session 2. Three "generated" items were still unticked,
  and the single-agent decision still said "deferred to session 6",
  even though I wrote it up in session 3. They now cover all six
  sessions. That includes the Claude Code mistakes that were only
  recorded in the dated entries: the embedding retry that hid a skipped
  test, the three grader bugs, raw tool errors sent to the browser, the
  suggestion that would have put the database password into the
  conversation, and the demo script line that repeated the "Atlas
  doesn't write E&O" overstatement.
- The README's Status line mentioned the architecture diagrams before
  they existed. I kept it only because they landed in the same PR.
