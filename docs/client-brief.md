# Client Brief: Atlas Policy Assistant

Atlas Underwriting is a fictional client. I wrote the scenario and its
seven source documents for this project, and I built the assistant as
if delivering it to Atlas's underwriting and compliance leads.

## The problem

Atlas's underwriters and compliance reviewers answer rule questions
from a small set of internal documents: commercial property guidelines,
a cyber addendum, the risk appetite statement, and the claims,
producer compensation and data retention policies. Two things make that
harder than a search box.

- **The rules change, and the old versions stay on file.** Version 3.0
  of the commercial property guidelines replaced 2.0 on November 1,
  2025, changing the Tier 1 coastal binding limit from $5M to $8M along
  with deductibles and roof-age inspection triggers. Atlas keeps 2.0 for
  audit and E&O defense, and a search ranks the two versions almost
  equally.
- **A confident wrong answer costs more than no answer.** A stale
  binding limit means a risk bound outside authority. A plausible answer
  to a question the documents don't cover is worse than "we don't have
  a rule for that."

## What I built

A web assistant that answers only from Atlas's documents:

- **Every claim is cited** to a numbered section, and each citation
  opens the source text with its effective date and whether it's been
  superseded. I check every citation against the sections the assistant
  actually read, and flag any that don't match.
- **The most recent effective date governs** when documents conflict.
  The answer names the superseded rule when that helps, and still
  answers historical questions ("what did v2 say?") correctly.
- **It says "not found" instead of guessing.** Asked for Atlas's E&O
  coverage limit, it recognizes that the only E&O text in the corpus is
  the producers' own insurance requirement, not an Atlas product.
- **It investigates before answering.** It searches, reads, and
  refines across up to three rounds, a cap I enforce in code to keep
  cost and response time predictable.

## How I measured it

I wrote 12 test questions from the document text, covering lookups,
the v2/v3 conflict, questions that span documents, and questions the
documents can't answer. Each ran 3 times, graded by code checks and a
separate Claude model reviewing every claim against its source. The
shipped version passes 90% of attempts and gets "answered vs. not
found" right 100% of the time. The main remaining failure is an answer
adding a detail its sources don't state, which both checks catch.

## What a production rollout would need

- **A larger evaluation built from real underwriter questions.** Twelve
  scenarios catch a broken behavior but can't rank small changes.
- **A fix for unsupported details**, for example retrying when the
  citation check fails, measured against the same evaluation.
- **Sign-in, per-role document access, and an audit log** of every
  question, answer and cited source.
- **A document update workflow.** The version and supersession rules
  already live in the data model, so publishing a new guideline means
  loading it with its effective date and the version it replaces.
- **Paid hosting and embedding tiers.** The demo runs on free tiers,
  which add a cold start after idle periods and occasional rate-limit
  delays.

The technical plan for each of these, with the tools I'd expect to use,
is in the "Path to production" section of
[docs/architecture.md](architecture.md).
