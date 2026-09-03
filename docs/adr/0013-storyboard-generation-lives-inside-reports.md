# The Storyboard PDF/video generator is a Report type, not a new surface

Grilled 2026-09-03, alongside the Storyboard PDF/video spec
(`deliverables/storyboard-pdf-video-grilled-spec-2026-09-03.md`).

## Decision

Storyboard generation is built as a new `reportType` (`storyboard`) flowing
through the existing Reports pipeline — `POST /admin/reports/generate` →
`reports` Firestore doc → worker → Vertex AI (`backend/src/lib/vertex.js`) →
GCS artifact → status poll — rather than as a separate portal surface with its
own routes and Firestore collection.

## Why

The Reports pipeline already exists end to end for exactly this shape: queue
an AI job against a Project, get an artifact back, poll for it, view it. It
already carries a per-Project `llmModel` setting and an `requireAnalyst` gate.
Building Storyboard as a sibling system next to it would duplicate that
plumbing for no benefit — the only thing that changes is what the worker does
with the Captures, not the shape of the pipeline around it.

This also lines up with ADR 0010 (*"AI reads a Capture only when a report is
generated"*): Storyboard assembly is the second real case of that rule, not an
exception to it.

## What this means concretely

- Nothing in `reportsWorker.js` or `ocrWorker.js`'s current logic is reused —
  both are mock MVP stubs (per `lessons_learned.md` #8, already flagged to the
  Customer as not-to-be-trusted). Only the surrounding pipeline (route →
  Firestore doc → worker dispatch → GCS write → status poll) is reused.
- The portal's existing "Reports" nav tab is where Storyboard generation and
  viewing live — no new nav item.
- A future "make this its own thing" migration is possible but not free: it
  would mean moving Storyboard drafts and generated artifacts out of the
  `reports` collection/GCS layout this decision puts them in.

## Considered and rejected

**A dedicated new surface** (new nav item, new routes, new collection) was
the alternative. Rejected because it duplicates infrastructure that already
does the job, purely to avoid sharing a nav tab with a feature the Customer
was told is currently full of placeholders — that reputational concern is
better solved by making the `storyboard` report type real, not by hiding it
somewhere else.

## Amendment (2026-09-03, during #89's implementation): the dispatch hop is not reused

`POST /admin/storyboards/:id/finalize` (#89) creates the `reports` doc and
writes the finalized PDF directly to GCS, in-process, rather than going
through `POST /admin/reports/generate` → the fire-and-forget self-HTTP call
to `/worker/reports` this ADR's Decision names. That dispatch mechanism has
no listening server in the test suite (`request(app)` never calls
`.listen()`), so nothing exercises it; it is the same untested MVP plumbing
this ADR's own "What this means concretely" section already declines to
reuse for `reportsWorker.js`'s *logic* — this amendment extends that same
judgement to the *dispatch hop*, not just the worker body.

What is unchanged from the Decision above, and is the part that was actually
load-bearing for the "Why": the artifact lands in the `reports` collection
as `reportType: 'storyboard'`, with a `gcsPath`, and shows up in the
existing Reports tab exactly like any other report. Assembling the PDF
in-process (no queue, no separate worker hop) is possible here because PDF
assembly is bounded and fast, unlike Vertex AI generation — narrative
generation (#86) faced the same choice and made it the same way, calling
Vertex AI in-process rather than through `reportsWorker.js`.

If the dispatch hop is ever made real (a genuine Cloud Tasks queue, an
authenticated internal call), finalize should move onto it then — this
amendment is a statement of current fact, not a case against ever building
that hop.
