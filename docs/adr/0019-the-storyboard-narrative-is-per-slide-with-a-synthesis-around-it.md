# The Storyboard narrative is written per slide, with a synthesis around it

Decided 2026-09-09, closing the question in #123, against the one hand-built
Storyboard that exists — the Softomedia Persona Storyboard (2026-09-02, 19
pages). Chris supplied it on 2026-09-09, with its source: nineteen `.dc.html`
artboards, a `canvas.json`, a `makepdf.mjs`, and a `frames/` directory, at
`D:\PersonalFiles\Softomedia\storyboard\`. #84's Further Notes recorded that it
had never been found saved in this repo, and #123 said reading it would settle
this ticket faster than reasoning about it. It did, and it did not choose any
of the three options as written.

## Decision

Narrative generation returns **two things in one call**: a short free-form
synthesis, and one caption per included Capture. The model answers by slide
number — the number already stated in the request — and the caption is stored
against its `captureId`, so a reorder afterwards moves the slide number without
moving the words.

The PDF draws each caption with its slide. Section headers come from **Capture
metadata** (`stage`, the Persona; `tool`), never from parsing the model's prose,
and the per-frame label is derived from the Capture's `tabUrl` when the PDF is
drawn rather than asked of the model.

## Why

The hand-built document is not a narrative in front of slides, and it is not
per-slide prose instead of a narrative. It is both, in fixed proportions:

- **19 pages, 52 images** — 42 numbered frames plus 10 zoomed evidence crops.
  **Six frames to a page**, in a grid. Not one page per screenshot.
- **Every frame carries its own prose.** Frame `001`, the route
  `/dashboard/admin`, two or three sentences written about *that frame* ("the
  Screens and Users tiles are missing, which is the first sign the session is
  not being treated as a superadmin"), and defect-log tags.
- **The grouping is per persona walk** — `WORKFLOW 01 · Super Admin · MVP §3.1
  · frames 001–006`. Coarse, structural, and known before a word is written.
- **The free-form analysis is front and back matter**: a cover, Themes, a
  Method page (how to read it, the severity scale, the environment), then
  Coverage (35 MVP functionalities scored) and Recommendations. Roughly five
  pages of nineteen — not a seven-page preamble carrying the whole load.
- **Absence is a page too.** Workflow 05, Tech Op, has no frames at all and
  still gets one: `NO CAPTURE EXISTS`.

The hard half of #123 — that the model groups slides on its own ("9 & 10.
Business Hours Setup") so no mapping can be recovered from the text — was
self-inflicted. Grouping was never something to extract. It is a field on the
Capture that nothing has ever read.

## What this changes in #84

- **Story 11** — *"the AI infers its own structure (sections, groupings,
  ordering rationale)"* — is narrowed. The model infers what to *say*; it does
  not choose the section boundaries. What story 11 was actually protecting
  against is unchanged: the Analyst still pre-tags nothing.
- **Story 16** stands exactly as written and is now implementable.
- **Story 22** is what this serves, unchanged.

## What this means concretely

- `buildNarrativeRequest` asks for a structured response keyed by Capture id,
  in place of one free block of text. The images and notes it already sends are
  unchanged.
- `buildStoryboardPdf` lays out a grid rather than a page per Capture, groups
  under a header derived from `stage`, and prints each caption with its frame.
  The per-frame label comes from the Capture's `tabUrl`.
- **`stage` gets its first reader.** `backend/src/index.js` has stamped the
  Persona onto every `uploads` document since #63, noting in as many words that
  nothing has ever read it. This is what it was for.
- **Page count collapses.** 66 Captures at six to a page is about eleven pages
  plus front and back matter, against the 73 the current layout produces. That
  is a straight reduction in the image work #122 is about.
- Two empty cases now need a defined rendering, because the hand-built document
  has an answer for one of them: a Capture with no note (0 of 66 in the real
  draft have one), and a Persona with no included Captures.

## Considered and rejected

**Close story 16 as written wrong** (#123's third option, and the one the
issue was most careful to legitimise). Rejected: the evidence is a document
whose author put prose on every single frame.

**Per-slide prose only, dropping the synthesis.** Rejected: Themes, Coverage
and Recommendations are where the document says what it *means*, and they are
the pages a client reads first.

**Parsing the existing free-form narrative into slide-sized pieces.** Rejected
for the reason #123 gives — one section legitimately covers two slides, and a
parser that splits it is inventing a boundary the model deliberately did not
draw.

## Consequences

- **Structured output is a new failure mode.** The model can return a caption
  for a `captureId` that is not included, or miss one that is. That must fail
  visibly rather than quietly dropping a slide out of a client deliverable —
  the same instinct as ADR 0018's malformed marker and ADR 0016's replaced
  narrative.
- **Density becomes a constraint on the prose.** Six frames to a page gives
  each caption a length budget. A model that writes two hundred words per slide
  breaks the layout, so the budget belongs in the prompt and the overflow has to
  be visible, not clipped.
- ADR 0018 still applies to the synthesis, which stays Markdown. Whether a
  short caption needs the renderer at all is an implementation detail, not a
  reversal.
- **Not decided here:** whether the evidence pages — a zoomed crop of one frame
  with longer prose beside it — belong in the product at all. In the hand-built
  document they are ten of the fifty-two images and some of its best pages, but
  they require choosing which frames deserve one, which nothing in the current
  curation flow asks the Analyst for.

## Amendment (2026-09-11, during #124's implementation)

**Why the model answers by slide number and not by Capture id.** The Decision
above was written expecting the model to key each caption by `captureId`. It
does not, and the reason is worth keeping: a `captureId` is the URL-encoded
object path of the screenshot, over a hundred characters long. Asking a model
to echo sixty-six of those exactly, when the slide number is already stated
beside each image and is unique within the draft, adds a failure mode for
nothing. The mapping to `captureId` happens where it is free and reliable — in
`parseNarrativeResponse`, against the curated set the request was built from.

**`narrativeText` is now the synthesis, not the whole narrative.** That is the
point of the decision, but it narrows a field three other things read:

- **#89, the PDF** renders it as the opening pages, which is what it should be,
  and draws no captions until #125.
- **#90, the video** narrated `narrativeText` on the grounds that it was the
  whole narrative. Left alone it would have gone on narrating only the
  synthesis — a video that quietly stopped saying anything about the slides it
  shows. `buildNarrationText` now speaks the synthesis, then each included
  slide's caption in curated order. A pre-#124 draft carries no captions and
  narrates exactly as it did.
- **#87, the editor** still edits `narrativeText` alone, so the captions are
  the one part of a client deliverable an Analyst cannot correct. That gap is
  recorded on #123 and is not closed here.
