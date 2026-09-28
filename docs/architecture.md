# Architecture

This document records the business and technical decisions I made for
the Atlas RAG Agent that you can't derive from reading the code: the
calls I had to make deliberately, and why I made them. I add sections
as each build session reaches the decision it covers. See
docs/ai-assisted-delivery.md for the session-by-session log.

## Scope tradeoff

I built this as a portfolio POC, not a hardened production system. It
demonstrates the retrieve/assess/refine agent pattern, grounded
citation discipline, and the kind of business-logic decisions a real
underwriting/compliance deployment would force (document authority
rules, iteration limits, "not found" thresholds). I deliberately didn't
build the operational hardening a production carrier system would need:
auth, multi-tenant isolation, full audit logging, horizontal scaling.
Where that tradeoff matters for a specific decision below, I call it
out.

## Document authority & staleness rule

**Decision:** When two or more retrieved chunks address the same
question but come from different documents (or different versions of
the same document), the document with the **most recent
`effectiveDate`** wins. A document's `status` field (`active` /
`superseded`) is the fast path, and I never let a `superseded` document
be cited as the answer to a forward-looking question. But
`effectiveDate` is the actual source of truth, since two active
documents can still disagree (for example, a line-specific addendum
published after a general guideline).

**Why I chose this shape over a deletion policy:** I keep superseded
documents in the corpus rather than removing them. Real underwriting
shops keep prior guideline versions for audit and E&O defense ("what
did the rule say when this risk was bound"). A RAG agent that can't
reason about *which* version applies isn't solving the real problem.
It's just hiding it by only ever showing one answer. I wrote the
`underwriting-guidelines-commercial-property-v2.md` /
`-v3.md` pair into the corpus specifically to exercise this rule:
v2 (effective 2023-03-01, superseded 2025-11-01) and v3 (effective
2025-11-01, active) disagree on TIV binding limits, coastal deductible
percentages, and roof-age inspection triggers.

**How I'm implementing it (sessions 2-3):**
- The `Document` table carries `effectiveDate`, `status`, and a
  supersession link. The corpus frontmatter declares the link on both
  sides (`supersedes` on v3, `supersededBy` on v2). In the database I
  store it once, on the newer document, with `supersededBy` as the
  back-relation, so the pair can't disagree. Ingestion refuses to run
  if the frontmatter declares a one-sided or inconsistent link.
- Retrieval does *not* filter out superseded documents. The agent needs
  to see the conflict to reason about it, and a user might legitimately
  ask "what did the old guideline say."
- The agent's system prompt instructs it: when retrieved chunks
  conflict, identify the effective dates, state which document
  currently governs, and cite the superseded one only if the question
  is explicitly historical or the conflict itself is being asked about.
- I made this a per-answer reasoning step, not a retrieval-time filter.
  Collapsing to "always drop superseded chunks" would break the
  historical-question case and would hide the conflict from the agent
  entirely on borderline queries.

## "Not found" threshold

**Decision:** The agent says the corpus doesn't cover a question, rather
than answering on thin evidence, when **no retrieved chunk is topically
responsive to the question** after retrieval (including any refinement
rounds up to the 3-round cap in CLAUDE.md). I don't rely on a
similarity-score cutoff alone.

**Why I rejected a pure similarity-score threshold:** Cosine similarity
over embeddings is a continuous signal with no natural cliff. A fixed
numeric cutoff (e.g. "below 0.75, refuse") tends to fail in one of two
ways. Set conservatively, it refuses questions the corpus actually
answers. Set loosely, it confidently answers off-topic questions with
the least-bad chunk in the index, because vector search always returns
*something*, ranked, whether or not any of it is relevant. Instead, the
agent itself judges topical responsiveness as part of its "assess
sufficiency" step in the retrieve/assess/refine loop: does the
best-available chunk actually address the entity or concept in the
question, or does it just share vocabulary with it?

**Concrete calibration case:** "What is Atlas's per-occurrence limit for
professional liability (E&O) coverage?" has no answer anywhere in the
corpus. Atlas's in-appetite lines (Section 2 of the Risk Appetite
Statement) don't include a standalone professional liability/E&O
product. I'm using this as the deliberately unanswerable eval scenario
(session 4). A naive top-k search will still return the
producer-compensation policy's E&O *requirement for producers* as the
closest vocabulary match. That's a different E&O: the producer's own
liability coverage, not an Atlas-underwritten product. The agent must
recognize that chunk doesn't answer the question asked and say so,
rather than citing it because it's the top hit.

My session 2 verify run confirmed this trap is real. The producer E&O
chunk comes back as the top hit at a cosine similarity of 0.508, in the
same range as chunks that genuinely answer other questions (0.53 to
0.64). No single score cutoff separates them.

**Iteration interaction:** if the first search round returns nothing
responsive, the agent gets up to 2 more rounds (the CLAUDE.md 3-round
cap) to try reformulated queries or `list_documents` to confirm no
relevant document exists, before returning "not found."

## Chunking strategy

**Decision:** I chunk by structural section (the numbered `##`/`###`
headings already present in every corpus document), not by fixed token
windows.

- Each chunk is one numbered subsection (e.g. "2.2 Coastal Wind/Hail
  Zones (Tier 1 Counties)"), capped at ~500 tokens. A subsection longer
  than that splits at paragraph boundaries with a ~50-token overlap,
  and the continuation chunk keeps the subsection heading.
- Chunk metadata stores the document id, section number, and section
  heading text, not just an offset. `get_document_section` uses this to
  pull surrounding context, and it's what makes citations ("Section 2.2
  of the Commercial Property Underwriting Guidelines v3.0") readable
  instead of a page/offset number no underwriter would recognize.

**Why I chose structural over fixed-window:** These are policy documents
where the unit of authority *is* the numbered section. An underwriter or
compliance reviewer cites "per Section 5.2," not "per paragraph 3 of
page 4." Fixed-token windows would frequently split a limit and its
condition across two chunks (e.g. the TIV number in one chunk, the
deductible requirement that qualifies it in the next). That directly
undermines citation trustworthiness, which is the deliberate
differentiator I'm building this project around. Structural chunking
costs some implementation complexity in the ingestion pipeline (parsing
heading hierarchy instead of just counting tokens), but I authored
every document in the corpus with consistent heading structure
specifically to make this tractable.

## Single-agent vs. planner/orchestrator split

**Decision:** One agent owns the whole retrieve/assess/refine loop. I
didn't split it into a planner that decomposes the question and
workers that retrieve for each part.

**Why:** The corpus is seven documents and 46 sections. A question
touches at most a handful of them, and the hardest reasoning step
(which version governs when v2 and v3 disagree) needs both versions in
the same context at the same time. A planner/worker split would push
that comparison across a handoff, where each worker sees only its own
slice, and I'd need a separate reconciliation step to put it back
together. It would also multiply model calls per question for no
retrieval benefit at this corpus size, and give me more places for a
citation to lose track of where it came from. A single agent with
parallel tool calls in one round already gets the fan-out benefit
(e.g. fetch v2 §2.2 and v3 §2.2 together) without the coordination cost.

**When I'd revisit it:** a corpus large enough that one agent's context
can't hold the evidence for a multi-hop question, or question types
that genuinely decompose into independent sub-investigations (e.g. "compare
our cyber and property referral triggers across all five lines"). Neither
applies to this POC.

## Agent loop and the iteration cap

**Decision:** A round is one model turn that makes tool calls, however
many calls it makes in parallel. The agent gets at most 3 rounds. I
enforce the cap in code: after the third round's results, the next
request sets `tool_choice: "none"`, so the model can't call another
tool even if it tries, and has to answer from what it has or say the
corpus doesn't fully cover the question.

**Why a round and not a tool call:** Counting individual calls would
penalize exactly the behavior I want, like fetching both versions of a
section at once to compare them. Counting rounds matches the actual
retrieve, assess, refine rhythm: each round is one assessment of
sufficiency.

**Why in code, not just in the prompt:** The system prompt tells the
model it has 3 rounds, and after each round I append a short notice
("Round 2 of 3 used, 1 left") so it can pace itself. But a prompt
instruction is a request, and the cap exists to bound cost and latency.
If the model ignores the prompt, the `tool_choice` switch still holds.
The loop also throws if the model somehow returns a tool call after the
cap, rather than silently running it.

**Model:** Claude Sonnet 5 through a hand-written Messages API loop. I
chose a manual loop over the SDK's tool runner or the Claude Agent SDK
because the cap is defined in rounds, and I wanted the loop to produce
a structured per-round trace (which tools ran, which sections they
returned) that the session 4 evals can assert on.

## Citation grounding check

**Decision:** Citations use a fixed inline format, `[document_id
§section]`, and after every answer I check each one against the
sections tools actually returned during that run. An answer is
`grounded` only if it cites at least one source and every citation
points at a retrieved section. A "not found" answer (status
`not_found`, see "Answer status as a structured field" below) is exempt
from the at-least-one rule, since it makes no claims from the corpus.
A bare section that continues the previous document, as in
`[claims-handling-policy §4, §3]`, counts as a citation to that
document; the first eval run showed the parser was dropping these.

**Why:** "Citations are required" is only a rule if something checks
it. The check catches the two failures that matter most here: citing
a section the agent never read (a hallucinated or remembered citation),
and citing the right section number from the wrong version (v2 §2.2
when only v3 §2.2 was retrieved). `list_documents` returns an outline,
not section text, so it never counts as evidence. For the POC, a
failed check is reported with the answer (the CLI prints a warning and
the result carries `grounded: false`) rather than triggering an
automatic retry. The evals will measure how often it happens before I
decide whether a retry is worth the added cost.

**What the evals showed:** it happens. Across the three session 4 runs,
the check caught answers citing sections the agent had never read, most
seriously one that stated the superseded $5M Tier 1 limit as current
and attributed it to v3 §2.2 (which says $8M). The claims judge failed
the same answers independently. A retry is still not built; see the
evaluation section for where this sits in the failure mix.

## Answer status as a structured field

**Decision:** The final answer is JSON constrained by the API's
structured output (`output_config.format`): `{status: "answered" |
"not_found", answer}`. Status is a field the model sets, not something
parsed from the text.

**Why:** In session 3 I had the model begin a "not found" answer with a
fixed prefix and parsed status from that. The session 4 baseline showed
the model often writes an explanation first and the prefix second (3 of
6 attempts on the two unanswerable scenarios), so a correct answer
reported the wrong status to anything downstream. I tried a stricter
prompt instruction first (v1), and it changed nothing: status accuracy
was 92% before and after. A code heuristic that looks for the prefix at
the start of any paragraph was the other option, and I rejected it:
it can't tell "explanation, then not found" from a partial answer whose
last paragraph states which part the corpus doesn't cover, so it would
trade one misclassification for another. With the structured field
(v2), status was correct on 34 of 34 graded attempts and both
unanswerable scenarios passed 3 of 3.

**Cost:** the constraint applies only to the final answer text, so tool
calling is unchanged, including the forced final answer after the
round cap (`tool_choice: "none"`), which I checked with a live call
before building it. The CLI adds the "Not found in the Atlas corpus:"
line when displaying a `not_found` answer. If the model ever returns
text that isn't the expected JSON, the agent fails loudly rather than
guessing a status.

## Evaluation

**What I measure:** 12 scenarios (evals/scenarios.json) covering
lookup, the authority rule (three current-rule questions where v2 and
v3 disagree), a historical question where citing v2 is correct,
multi-hop questions across documents, two unanswerable questions, and a
partially answerable one. I wrote each expected answer from the corpus
text, not from any model's output. Each scenario runs 3 times through
the real `runAgent()` entry point (`npm run eval`).

**How I grade:** an attempt passes only if it passes all of these:
- status matches (answered vs. not_found)
- the key facts appear (e.g. "$8,000,000"), checked as literal strings
- the required sections are cited, and every citation points at a
  section the agent actually retrieved
- a claims judge (Claude Opus 5, deliberately not the Sonnet 5 model
  under test) reads the answer next to the text of every section it
  cites, plus a per-scenario note on what counts as failing, and fails
  any claim the cited text doesn't support, including qualifiers the
  text doesn't state ("per occurrence" on a sublimit)

The code checks exist because they're exact and free. The judge exists
because the most important failure here, an answer that goes beyond its
source, isn't visible to a string match: the session 3 "Atlas does not
write E&O" overstatement passes every code check.

**Trusting the grader:** before scoring anything I ran an oracle (each
scenario's expected answer) and an empty answer through the code
checks, and a set of known-good and known-bad answers through the judge
(`npm run eval:judge-check`, 12 probes, all must match). Reading every
failure in the first baseline found three grader bugs: the judge's
output schema had silently lost its pass/fail constraint, the judge
couldn't see section headings, and the citation parser dropped
`[doc §4, §3]`-style citations. Two of the baseline's failures were
these bugs, not the agent. I fixed them and re-graded the stored
answers (`npm run eval:regrade`) rather than re-running the agent, so
the baseline and the variants are graded by the same grader.

**Results** (pass rate over 12 scenarios x 3 runs, mean of per-scenario
means with a 95% interval):

| Variant | Change | Pass | Status |
|---|---|---|---|
| baseline | session 3 agent | 86% ±13 | 92% |
| v1 | stricter prompt for the not-found prefix | 76% ±15 | 92% |
| v2 | status as a structured field | 90% ±13 | 100% |

v2 is what ships. Its overall gain over baseline (+4 points) is within
noise; the status fix is by construction, not by measurement. The
dominant remaining failure is the agent adding a claim beyond what it
retrieved, sometimes from memory, which both the citation check and the
judge catch.

**Limits:** 12 scenarios x 3 runs gives roughly ±13 points on the
headline, enough to catch a behavior that breaks, not enough to rank
small prompt changes. On Voyage's free tier (3 requests per minute) a
full run takes about 25 minutes, latency figures include rate-limit
waits, and the searches-heaviest scenarios occasionally hit the
300-second per-attempt ceiling; those are logged in errors.jsonl, not
scored as failures. A full run costs about $1.40 (agent plus judge).
