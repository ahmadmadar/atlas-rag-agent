# Architecture

This document records the business and technical decisions behind the
Atlas RAG Agent that aren't derivable from reading the code — the calls
that had to be made deliberately, and why. Sections are added as each
build session reaches the decision it covers; see
docs/ai-assisted-delivery.md for the session-by-session log.

## Scope tradeoff

This is a portfolio POC, not a hardened production system. It
demonstrates the retrieve/assess/refine agent pattern, grounded
citation discipline, and the kind of business-logic decisions a real
underwriting/compliance deployment would force — document authority
rules, iteration limits, "not found" thresholds — without building out
the operational hardening (auth, multi-tenant isolation, full audit
logging, horizontal scaling) a production carrier system would need.
Where that tradeoff matters for a specific decision below, it's called
out.

## Document authority & staleness rule

**Decision:** When two or more retrieved chunks address the same
question but come from different documents (or different versions of
the same document), the document with the **most recent
`effectiveDate`** wins. A document's `status` field (`active` /
`superseded`) is the fast path — a `superseded` document is never cited
as the answer to a forward-looking question — but `effectiveDate` is
the actual source of truth, since two active documents can still
disagree (e.g., a line-specific addendum published after a general
guideline).

**Why this shape, not a deletion policy:** Superseded documents stay in
the corpus rather than being removed. Real underwriting shops keep
prior guideline versions for audit and E&O defense ("what did the rule
say when this risk was bound"), and a RAG agent that can't reason about
*which* version applies isn't solving the real problem — it's just
hiding it by only ever showing one answer. The
`underwriting-guidelines-commercial-property-v2.md` /
`-v3.md` pair in the corpus exists specifically to exercise this rule:
v2 (effective 2023-03-01, superseded 2025-11-01) and v3 (effective
2025-11-01, active) disagree on TIV binding limits, coastal deductible
percentages, and roof-age inspection triggers.

**How it's implemented (session 2-3):**
- `documents` table carries `effectiveDate`, `status`, and optional
  `supersedes` / `supersededBy` pointers (see corpus frontmatter for the
  fields ingestion should read).
- Retrieval does *not* filter out superseded documents — the agent
  needs to see the conflict to reason about it, and a user might
  legitimately ask "what did the old guideline say."
- The agent's system prompt instructs it: when retrieved chunks
  conflict, identify the effective dates, state which document
  currently governs, and cite the superseded one only if the question
  is explicitly historical or the conflict itself is being asked about.
- This is a per-answer reasoning step, not a retrieval-time filter,
  because collapsing to "always drop superseded chunks" would break the
  historical-question case and would hide the conflict from the agent
  entirely on borderline queries.

## "Not found" threshold

**Decision:** The agent says the corpus doesn't cover a question rather
than answering on thin evidence when, after retrieval (including any
refinement rounds up to the 3-round cap from CLAUDE.md), **no retrieved
chunk is topically responsive to the question** — not a similarity-score
cutoff alone.

**Why not a pure similarity-score threshold:** Cosine similarity over
embeddings is a continuous signal with no natural cliff, and a fixed
numeric cutoff (e.g. "below 0.75, refuse") tends to either refuse
questions the corpus actually answers (if set conservatively) or
confidently answer off-topic questions with the least-bad chunk in the
index (if set loosely) — vector search always returns *something*,
ranked, whether or not any of it is relevant. Topical responsiveness is
judged by the agent itself as part of its "assess sufficiency" step in
the retrieve/assess/refine loop: does the best-available chunk actually
address the entity/concept in the question, not just share vocabulary
with it.

**Concrete calibration case:** "What is Atlas's per-occurrence limit for
professional liability (E&O) coverage?" has no answer anywhere in the
corpus — Atlas's in-appetite lines (Section 2 of the Risk Appetite
Statement) don't include a standalone professional liability/E&O
product. This is the deliberately unanswerable eval scenario (session
4). A naive top-k search will still return the producer-compensation
policy's E&O *requirement for producers* (a different E&O — the
producer's own liability coverage, not an Atlas-underwritten product) as
the closest vocabulary match. The agent must recognize that chunk
doesn't answer the question asked and say so, rather than citing it
because it's the top hit.

**Iteration interaction:** if the first search round returns nothing
responsive, the agent gets up to 2 more rounds (the CLAUDE.md 3-round
cap) to try reformulated queries or `list_documents` to confirm no
relevant document exists, before returning "not found."

## Chunking strategy

**Decision:** Chunk by structural section (the numbered `##`/`###`
headings already present in every corpus document), not by fixed token
windows.

- Each chunk = one numbered subsection (e.g. "2.2 Coastal Wind/Hail
  Zones (Tier 1 Counties)"), capped at ~500 tokens; a subsection longer
  than that splits at paragraph boundaries with a ~50-token overlap
  carrying the subsection heading forward into the continuation chunk.
- Chunk metadata stores the document id, section number, and section
  heading text, not just an offset — this is what
  `get_document_section` uses to pull surrounding context, and what
  makes citations ("Section 2.2 of the Commercial Property Underwriting
  Guidelines v3.0") readable instead of a page/offset number no
  underwriter would recognize.

**Why structural over fixed-window:** These are policy documents where
the unit of authority *is* the numbered section — an underwriter or
compliance reviewer cites "per Section 5.2," not "per paragraph 3 of
page 4." Fixed-token windows would frequently split a limit and its
condition across two chunks (e.g. the TIV number in one chunk, the
deductible requirement that qualifies it in the next), which directly
undermines citation trustworthiness — the deliberate differentiator
this project is built around. Structural chunking costs some
implementation complexity in the ingestion pipeline (parsing heading
hierarchy instead of just counting tokens) but every document in the
corpus is authored with consistent heading structure specifically to
make this tractable.

## Single-agent vs. planner/orchestrator split


