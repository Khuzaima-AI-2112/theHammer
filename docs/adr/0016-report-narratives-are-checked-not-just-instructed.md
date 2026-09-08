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
