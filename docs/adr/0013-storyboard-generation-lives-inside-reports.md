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

## Amendment (2026-09-11, during #122's implementation): "bounded and fast" holds, and the measurement that seemed to refute it was taken in the wrong place

The amendment above rests on one sentence — *"PDF assembly is bounded and fast,
unlike Vertex AI generation"* — which was written without a measurement. #122
was filed to say that sentence is false at real sizes, having timed the real
66-Capture Softomedia draft at **2m49s** (2026-09-09, the 73-page layout) and,
re-timed after #125, at **75s, 76s, 75s and 120s**, against a backend that
deploys with `--timeout 300s`. On those numbers one Storyboard was eating
between a quarter and over half the request budget, and a draft twice the size
would not finish.

**Every one of those numbers was measured from a developer machine**, through
`backend/scripts/storyboard-grid-preview.js`, over the public internet — and
#122's own comment says so. Production disagrees by a factor of thirty. The
only real finalize this product has ever run, of that same 66-Capture draft,
is report `L8iuk0ux2HUgYvhCIVbg`, 2026-09-11T11:31:08Z, and its own row dates
it: `createdAt` is written before assembly starts and `updatedAt` when the PDF
is uploaded and the row goes `done`. The gap is **5.2 seconds** — assembly,
a 9.2MB upload and the Firestore writes included. **1.7% of the budget, not
56%.** Cloud Run shares a region with the bucket; a developer machine does
not, and 66 sequential round trips is where the whole difference lives.

So the original claim survives, for a reason it never stated: assembly is fast
*in the place it runs*. What it was missing is that the cost is 66 sequential
round trips, so it is linear in Captures and entirely at the mercy of the
distance to the bucket.

**What #122 changed anyway, and why it was still worth doing.** The frames are
now fetched through `lib/prefetch.js`, eight in the air at a time, yielded in
curated order. Measured on the same developer machine: **89.7s before**, and
**15.3s, 15.4s and 13.3s after**, producing the same 12 pages, the same 9.2MB,
and the same text in the same order. (12 pages where #122's own comment
recorded 17: the draft's synthesis has been edited since, which moves the page
count and is not what this amendment is about. Both runs on the day were 12.)
Three things justify it even at 5.2s in production:

- `storyboard-grid-preview.js` is the tool every defect in this feature has
  been found with (#121, #124, #125, #126, #128), and it runs on a developer
  machine. A minute and a half per look is a tax on the only inspection loop
  that works.
- The round trips are linear in Captures wherever it runs. The margin is
  enormous today; the shape of the cost was not bounded, and now is.
- It removes a risk without adding infrastructure, which is the one thing this
  ADR's amendment above says in-process assembly must not do.

**The size at which this is worth revisiting**, stated so a later reader can
check it rather than inherit it: in production, 66 Captures cost 5.2s
end-to-end with the sequential loop. Since the loop was the linear part, the
same draft should now be a second or two, and even ten times the Captures
leaves the request budget untroubled. If that is ever not true, the number to
look at is a real `reports` row's `createdAt`→`updatedAt` gap, not a developer
machine's.

**What is not fixed here.** If a finalize ever does outrun the timeout, Cloud
Run kills the request without running the `catch`, and the `reports` row stays
at `processing` — visible, which is what #122's third bullet asked for and
what #89 had already built (this ADR's implementer had it right; #122's
premise that there was "no `reports` doc" was wrong, and there is now a test
holding the ordering in place). But `processing` is indistinguishable from a
row that is about to succeed. That is the same defect the video path has at
`queued`, and #127 is where it is argued, because it wants one answer rather
than two.

*Answered in part, 2026-09-11 (#127):* a row whose work happens inside its own
request is now stamped with an `mustFinishBy` deadline, and a read settles
anything that outlived it to `error` (`lib/reportDeadline.js`). A killed
finalize is therefore distinguishable from one about to succeed. Where the
work itself should live is still open — that half of #127 is an architecture
decision with infrastructure behind it, and this amendment's "if the dispatch
hop is ever made real" remains the condition for moving finalize off the
request.

**The alternative #122 offered and this did not take**: capping the Captures a
single Storyboard may finalize, the way ADR 0017 caps OCR pairs. Declined,
not deferred — a cap is a product limit imposed to dodge an engineering cost,
and the engineering cost turns out to be 5.2 seconds. Nothing about the real
numbers justifies telling an Analyst their Storyboard is too long.
