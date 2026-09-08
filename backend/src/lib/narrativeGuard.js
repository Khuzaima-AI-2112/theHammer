'use strict';

/**
 * Keeping a Report's prose inside its metrics (#119).
 *
 * #8 removed hardcoded metrics because invented numbers read as measurement.
 * #96 made OCR Reports refuse rather than return fabricated findings. This is
 * the same defect one layer up: the numbers are honest and the sentences
 * around them are not. The first real narrative this product ever produced
 * ended with "We are focused on onboarding additional team members in the
 * coming days" — from `{"totalCaptures":8,"activeUsers":1}`, with no such plan
 * anywhere in the system.
 *
 * Two mechanisms, because either alone is insufficient (ADR 0016):
 *
 *  - `buildReportNarrativePrompt` stops asking for a *voice*. The old prompt
 *    cast the model as an executive assistant, which is a request for a
 *    register, and forward-looking filler is what that register is made of.
 *  - `findForwardLookingClaims` checks what came back. A prompt constraint
 *    cannot be observed to have worked, and this model volunteers commitments
 *    unprompted; a Report is forwarded to a Customer, so a bland summary is a
 *    far cheaper mistake than one that puts words in their mouth.
 */

/**
 * Markers of a claim about the future, an intention, or an opinion.
 *
 * Deliberately narrow. This does not attempt to decide whether a statement is
 * supported by the metrics — that is undecidable here — only whether it is the
 * *kind* of statement no metric can support. A restatement of counts and rates
 * has no reason to reach for any of these words, so precision is high in this
 * domain even though these patterns would be useless in prose generally.
 */
const FORWARD_LOOKING_MARKERS = Object.freeze([
  { label: 'first-person intention', pattern: /\bwe (are|will|plan|intend|aim|hope|expect|look|continue)\b/i },
  { label: 'recommendation',         pattern: /\brecommend\w*\b/i },
  { label: 'suggestion',             pattern: /\b(should|ought to|worth) \w+/i },
  { label: 'plan',                   pattern: /\b(plans?|planning|intends?|intending|aims?|aiming|seeks?|seeking) to\b/i },
  { label: 'focus or priority',      pattern: /\b(focus(ed|ing)? on|prioritis\w+|prioritiz\w+)\b/i },
  { label: 'forecast',               pattern: /\b(will|shall|would likely|is expected to|are expected to)\b/i },
  { label: 'near future',            pattern: /\b(coming (days|weeks|months)|near (future|term)|upcoming|going forward|moving forward|next (month|quarter|week))\b/i },
  { label: 'next steps',             pattern: /\bnext steps?\b/i },
  { label: 'roadmap',                pattern: /\b(roadmap|milestones? ahead)\b/i },
  { label: 'goal',                   pattern: /\b(goal|target|objective)s? (is|are|of|to)\b/i },
]);

/**
 * The labels of every marker present in `text`, or `[]`.
 *
 * Labels rather than the matched substrings: what lands in the artifact should
 * say what kind of claim was rejected, and the offending sentence is preserved
 * whole alongside it, so echoing fragments adds nothing.
 */
function findForwardLookingClaims(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  return FORWARD_LOOKING_MARKERS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label);
}

/** `totalCaptures` -> `total captures`. */
function humaniseKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
}

/**
 * The metrics as a flat English clause: "total captures 8, active users 1".
 *
 * `null` becomes "not measured", never "0". reportMetrics.js returns null
 * where there was nothing to divide by, on the explicit grounds that zero
 * would be a claim about work nobody measured; restating it as zero here
 * would undo that in the one place a Customer actually reads.
 */
function describeMeasuredValues(metrics) {
  return Object.entries(metrics || {})
    .map(([key, value]) => {
      const shown = (value === null || value === undefined) ? 'not measured' : String(value);
      return `${humaniseKey(key)} ${shown}`;
    })
    .join(', ');
}

/**
 * What to ask for instead of a voice.
 *
 * Every rule here exists because the narrative in #119 broke it. The sentence
 * count is a ceiling, not a quota — "write less" is stated outright, because
 * a model asked for three sentences about two integers will manufacture a
 * third.
 */
function buildReportNarrativePrompt(reportType, metrics) {
  return [
    `Describe the measurements below for a report of type ${reportType}.`,
    '',
    'Rules:',
    '- Describe only what these measurements state. Every figure you write must appear in them.',
    '- Add no recommendations, plans, intentions, forecasts, next steps, goals or opinions.',
    '- Say nothing about what anyone did, wants, or will do beyond what is measured here.',
    '- At most 3 sentences. If there is little to describe, write less; do not fill space.',
    '',
    `Measurements: ${JSON.stringify(metrics)}`,
  ].join('\n');
}

/**
 * The summary to publish, and the record of how it was decided.
 *
 * On rejection the narrative is replaced with a deterministic restatement and
 * the rejected text is kept beside it. Dropping it would reproduce exactly the
 * failure this issue's family is made of — a Report that completes with
 * something missing and no way to tell why.
 *
 * `status` is written on every guarded Report, including the ones that pass,
 * so "the guard accepted this" and "the guard never ran" are distinguishable
 * in the artifact (lesson 73).
 */
function guardNarrative(text, metrics) {
  const markers = findForwardLookingClaims(text);
  if (markers.length === 0) {
    return { summary: text, guard: { status: 'accepted' } };
  }
  return {
    summary: 'The generated narrative was rejected for stating things the '
      + `measurements do not support. The measured values are: ${describeMeasuredValues(metrics)}.`,
    guard: { status: 'rejected', markers, rejectedSummary: text },
  };
}

module.exports = {
  FORWARD_LOOKING_MARKERS,
  findForwardLookingClaims,
  describeMeasuredValues,
  buildReportNarrativePrompt,
  guardNarrative,
};
