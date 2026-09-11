# A Report narrative is checked after generation, not only instructed before it

Decided 2026-09-08 while closing #119.

## Decision

The narrative on a standard Report passes through two mechanisms, both in
`backend/src/lib/narrativeGuard.js`:

1. **Prevention.** `buildReportNarrativePrompt` asks the model to describe the
   measurements and explicitly forbids recommendations, plans, intentions,
   forecasts, next steps, goals and opinions. It no longer casts the model as
   an "executive assistant".
2. **Detection.** `findForwardLookingClaims` scans what came back for markers
   of those same claim types. On a hit the narrative is **not published**: the
   summary becomes a deterministic restatement of the measured values, and the
   rejected text is kept beside it under `summaryGuard` in the artifact.

`summaryGuard.status` is written on every narrated Report, including the ones
that pass, so an accepted narrative and a guard that never ran are
distinguishable in the artifact.

## Why not prompt alone

#119's acceptance criteria left this open, calling prompt-only "weaker but
honest about being weaker". Three things settled it toward doing both.

**A prompt cannot be asserted to have worked.** The only test available for
prompt-only is that the prompt contains certain words — which is a test of the
string, not of the product. #119 asks for a test that drives
`generateStandardReport` with an embellished narrative and asserts a
*behaviour*; with prompt-only, the behaviour being pinned is "the invented
sentence is published anyway".

**The model volunteers commitments unprompted.** The old prompt did not ask
for a plan, and got one. Nothing about a better prompt makes that structurally
impossible — it lowers the rate, which is worth doing, and is why prevention
stays.

**The costs are asymmetric.** A false positive costs a blander summary on a
Report whose numbers are all still present and correct. A false negative puts
an intention the Customer never expressed into a document they may forward.
That asymmetry is the whole argument; where the two mechanisms disagree, the
detector wins.

## Why the detector is narrow

It does not attempt to decide whether a statement is *supported* by the
metrics — that is not decidable here. It decides whether a statement is the
*kind* no metric could support. A restatement of counts and rates has no
reason to reach for "we plan to", "next steps" or "will increase", so
precision is high in this domain even though these patterns would be useless
against prose generally.

The consequence to accept: a genuinely faithful sentence phrased with one of
these words gets replaced by the deterministic restatement. That is the
cheaper error, and it is visible in the artifact rather than silent.

## Considered and rejected

**Re-asking the model on rejection.** Another call costs money (~1 cent per
Report, doubled), can fail the same way, and delays the Report. The
deterministic restatement is free, always correct, and says plainly what
happened.

**Blanking the summary on rejection.** Rejected because a Report that
completes with something quietly missing is precisely the failure mode of
#107, #108 and #96. The restatement, the marker list and the rejected text all
land in the artifact.

## Explicitly cleared: the Storyboard narrative

#119 asked that `buildNarrativeRequest` in `backend/src/routes/admin/storyboards.js`
be reviewed for the same defect. It is cleared, not fixed, for three reasons:

- The product supplies **no prompt** there. The instruction is typed by the
  Analyst, or transcribed from their own recording (#88); there is no persona
  and no product-authored register to correct.
- The output is `narrativeText` on a draft the Analyst is authoring and reading
  inside the Storyboard editor. It is their draft, not a figure presented to a
  Customer as measurement.
- It is grounded in the Captures themselves as images, not in two integers, so
  the specific pressure that produced #119 — a model asked to fill three
  sentences from almost no material — is not present.

Applying this guard there would reject phrasing an Analyst may have
deliberately asked for. If Storyboard narratives ever gain a product-authored
prompt, this clearance lapses.

## Amendment (2026-09-11, during #124): the clearance is re-argued, not retained

The lapse condition above fired. #124 adds `NARRATIVE_FORMAT_INSTRUCTION` to
`buildNarrativeRequest` — a product-authored prompt, which is exactly what the
clearance said it could not survive. Re-examined, its three reasons did not
fail together:

- **"The product supplies no prompt"** is gone in letter. What it was
  protecting is not: #119's defect was a prompt that asked for a *voice* ("an
  executive assistant"), and forward-looking filler is what that register is
  made of. The new instruction asks for a *shape* — which slide a caption
  belongs to, how many words it has, that the synthesis is not repeated in the
  captions. It says nothing about stance, and the Analyst's own instruction is
  still the first part of the request.
- **"Their draft, not a figure presented to a Customer"** is simply false now,
  and ADR 0018 already said so: the finalized narrative is the opening of a
  72-page document whose stated purpose is to be handed to a client unedited.
  This reason is withdrawn.
- **"Grounded in the Captures themselves, not in two integers"** holds, and is
  now the strongest of the three. The pressure that produced #119 — a model
  asked to fill three sentences from almost no material — is still absent.

## The decision: the guard still does not run over a Storyboard

Not because the narrative is private any more, but for a reason the original
clearance did not reach: **the guard's markers are a Storyboard's legitimate
content.** `findForwardLookingClaims` fires on `recommend`, `should`, `focus
on`, `next steps`. The hand-built Softomedia Storyboard that ADR 0019 was
decided against closes on a page titled **Recommendations**, and its captions
say plainly what the client should fix. An Analyst's Storyboard is advisory by
nature; a Report is not.

That inverts #119's asymmetry. There, a false positive cost a blander summary
and a false negative put an intention in the Customer's mouth. Here a false
positive would delete the most valuable page of the deliverable, and there is
no invented commitment to catch: the Analyst asked for the advice, reads it in
the editor (#87), and can edit it before finalizing.

What stands in the guard's place is narrower and structural, not rhetorical:
#124 refuses a response with a caption missing, duplicated, or aimed at a slide
that is not in the Storyboard, so a run cannot reach `done` with a slide that
would print blank.

This answers, for the guard, the open question left at the foot of ADR 0018.

**What would re-open it:** a product-authored instruction here that asks for a
register or a stance rather than a shape, or a Storyboard that can be finalized
without an Analyst having read the narrative.
