# Demo Script

A two-minute walkthrough of the live app at
https://atlas-rag-agent.onrender.com, for a screen recording or a live
call. It shows three things in order: the authority rule resolving a
real document conflict, the agent iterating on a question that needs
more than one section, and an explicit "not found" on a question the
documents don't cover. It closes on the eval numbers.

Spoken lines are what I say. Everything else is what's on screen.

## Before recording

- **Wake the service.** The free Render instance sleeps after 15
  minutes idle. Open `/api/health` about a minute before starting.
- **Give Voyage a clear minute.** Voyage's free tier allows 3 embedding
  requests per minute, and each question uses one to three. Asked back
  to back, the third question can hit the limit: the agent still
  answers, but the round stalls for up to 35 seconds while it retries.
  Wait about a minute between questions and cut the gaps in editing.
  On a live call, fill the gap with the talking points below. (Adding a
  payment method to the Voyage account removes this constraint.)
- **Remember the limits.** 5 questions per visitor per 10 minutes. A
  rehearsal plus a take can use that up, so rehearse on localhost.
- **Screen setup.** One browser tab, page zoomed so the answer and the
  trace fit without scrolling, notifications off.

## Script

### 0:00 to 0:15: the problem

*On screen: the page, before any question.*

> "Atlas Underwriting is a fictional commercial insurance carrier. Its
> underwriters need answers from policy documents that change over time,
> and a wrong answer means binding a risk they weren't authorized to
> bind. I built an agent that answers only from Atlas's own documents,
> cites every claim, and says so when the documents don't cover a
> question."

### 0:15 to 0:50: a real conflict between document versions

*Click the **Current rule** sample: "What is the maximum TIV a field
underwriter can bind in a Tier 1 coastal county?"*

> "The corpus has two versions of the underwriting guidelines, and they
> disagree on this number. In retrieval they score almost identically,
> so similarity alone can't pick the right one."

*The answer arrives: $8,000,000 per location, from v3. Click the
`uw-guidelines-cp-v3 §2.2` citation: the source shows **Active**,
effective 2025-11-01. Close it and click the `uw-guidelines-cp-v2 §2.2`
citation: **Superseded by uw-guidelines-cp-v3**, with $5,000,000.*

> "I decided the rule up front: the most recent effective date governs.
> The agent answers with v3's $8 million and names the old $5 million
> limit as superseded. Every citation opens the exact source text, and
> the citations are checked in code against what the agent actually
> retrieved."

### 0:50 to 1:25: a question that takes more than one lookup

*Click the **Multi-step** sample: a $6M Tier 1 coastal risk with a
5-year-old roof and no wind mitigation report.*

*While it runs, point at the trace filling in round by round.*

> "This one needs several sections. The agent searches, checks whether
> it has enough, and goes back for more. That's capped at three rounds,
> so cost and latency stay bounded."

*The answer arrives: no, this needs home office referral, citing v3
§3.2 and §5.*

> "The TIV is within the limit, and the roof age doesn't matter here.
> What forces a referral is the missing wind mitigation report, and it
> took two different sections to establish that."

### 1:25 to 1:45: what it won't do

*Click the **Not in the documents** sample: Atlas's per-occurrence
limit for professional liability (E&O).*

*The answer arrives with the **Not found in the documents** badge.*

> "None of Atlas's documents cover E&O as an Atlas product, so there's
> no limit to find. They do mention E&O, but only as coverage that
> Atlas's producers must carry themselves. The agent tells those apart
> and says not found instead of passing that number off as an answer.
> It also doesn't claim Atlas never writes E&O, because the documents
> don't say that either."

### 1:45 to 2:00: how I know it works

*Switch to the README results, or stay on the page.*

> "I measured it with a 12-scenario eval that includes these traps. The
> baseline scored 86%. The version I shipped scores 90%, with the
> answered-or-not-found call right on every graded run. The biggest
> remaining failure is the agent occasionally adding a claim beyond
> what it retrieved, and the citation check catches it."

## Talking points for gaps or questions

- **Why one agent, not a planner and workers?** Three tools and a
  3-round cap don't need orchestration. I wrote down when a split
  would earn its cost in docs/architecture.md.
- **How the round cap is enforced:** in code, not in the prompt. After
  round 3 the model is called with tool use turned off, so it has to
  answer from what it has.
- **How "not found" is decided:** the final answer is structured JSON
  with a status field the model sets, not a phrase parsed out of prose.
  That change took answer status from 92% to 100% correct in the eval.
- **Why the citation check matters:** a citation to a section the agent
  never retrieved is flagged, even if it looks plausible.
- **What's POC and not production:** free-tier hosting, in-memory
  per-visitor limits, a 12-scenario eval (about ±13 points), no auth.
  The daily question cap is stored in Postgres so it holds across
  restarts.

## If something goes wrong on a live call

- **The trace shows "This lookup returned an error":** almost always
  the Voyage rate limit. Say so, and point out that the agent carries
  on with the other tools instead of failing the question.
- **The first request hangs for 30 to 60 seconds:** a cold start. Talk
  through the opening while it wakes.
- **A 429 message:** the per-visitor limit. Switch to localhost
  (`npm run dev`), which has the same page and data.
