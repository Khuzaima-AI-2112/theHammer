# An OCR Report is generated for a Storyboard, not for a Project

Grilled 2026-09-08/09 while designing #96, after the Customer chose a capped
build over an uncapped one (`deliverables/message-to-chris-ocr-report-cost-2026-09-08.md`).

## Decision

The two OCR Report types are generated for a **Storyboard**: the Analyst's own
ordered, curated set of Captures. The Report walks that order in consecutive
pairs and reports what changed at each step.

`POST /admin/reports/generate` gains an optional `storyboardId`, required for
this report type and rejected alongside a `dateRange`. The `reports` row still
carries `projectId` and `workspaceId`, so ownership scoping, the Reports tab
and the status poll are unchanged (ADR 0013 still holds).

## Why

**A Project is not a sequence.** Softomedia's 66 Captures span 28 distinct
`tabUrl`s and 8 distinct `tool` values. Pairing them by time means repeatedly
asking a model what changed between two screenshots of unrelated pages. It
would answer — that is the failure this issue exists to end, reintroduced one
layer down, and it would be harder to disbelieve than #119's prose because
each finding names a specific element and a specific transition.

**A Storyboard is already the answer to "which Captures belong together".**
The glossary defines it as an ordered set of Captures, with a note against
each, that demonstrates a single workflow. "What changed between consecutive
screenshots" is the question that object exists to support. The selection is
made by a human who was there, rather than by a heuristic guessing from
timestamps.

**It caps the cost by construction.** A Storyboard is curated, so its size is
chosen rather than accumulated. The explicit cap (first 20 pairs) sits on top
of that, and the number lives in `lib/models.js`.

## What this means concretely

- **Consecutive pairs only.** Never sampled, never bridged. A comparison that
  spans a skipped step reports as one change what may have taken three, which
  is fabrication with a real screenshot attached.
- **Abandoned Uploads break the chain.** A Capture whose bytes never landed
  (glossary: *Abandoned Upload*) is detected by an existence check, skipped,
  and no pair spans it. The artifact records how many were dropped.
- **The artifact is a list of comparisons**, each naming its two Capture ids
  and Storyboard positions, each carrying its findings — including the empty
  ones. An absent finding and an unexamined pair must not look alike.
- **The Analyst's notes never reach the model.** A note is the Analyst's claim
  about what a step does; feeding "Slide 8: user accepts the terms" to a model
  asked what changed between 7 and 8 is leading the witness. The notes go in
  the artifact beside each comparison, so the reader can see whether the note
  and the finding agree.
- **One report type, not two.** "UI State Changes" and "Text Entry Tracking"
  were never two analyses — one pass over a pair produces both, and the
  scaffolded prompt already asked for both. Two entries would bill twice for
  the same reading of the same two images.
- **Nothing groups Captures by `tool`.** Production uses that field as a
  workflow label; the glossary now says it names the product under observation
  and that the workflow-shaped values are drift.

## Considered and rejected

**The Project, as the pipeline shapes it today.** Rejected above: no adjacency
rule over a Project survives contact with 28 interleaved pages, and inventing
one is how fabricated findings return.

**A Session.** The Customer was offered this as a way to cap cost, and it
cannot be built: a Capture carries no `sessionId` (`index.js:355-381`), and
Sessions relate to Captures only by `(projectId, userId, time window)`.
Softomedia has 66 Captures and **zero** Session rows, so there is nothing to
cap by. Adopting it would mean an extension change and a backfill before the
first Report could be generated. If Captures ever gain a Session link, this
decision is worth reopening — a Session is the other honest unit.

**Sampling evenly across a long Storyboard** to hold cost while keeping
coverage. Rejected as the same fabrication as bridging: sampled frames are not
adjacent, and every change they report silently spans unknown intermediate
steps.

**Refusing above the cap** and making the Analyst deselect Captures until the
Storyboard fits. The more principled option, and the one to revisit if 20
proves wrong: it puts the editorial choice with the human, who already has a
curation tool. Not taken now because it would have the Customer deselecting 45
Captures by hand before seeing the feature work at all, and truncation stated
on the artifact's face is not the defect class this issue is about.
