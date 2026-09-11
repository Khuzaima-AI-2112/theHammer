'use strict';

/**
 * The model ids this product is allowed to name (#108).
 *
 * Every AI call used to write `gemini-1.5-flash` inline, in seven files. That
 * model retired on Vertex on 2025-09-24 and now 404s, and because #8's
 * graceful degradation completes a Report either way, the failure was visible
 * only as a narrative that never appeared. Fixing seven literals would have
 * left the same trap for the next retirement, so the ids live here instead and
 * tests/model-ids.test.js fails if one is written anywhere else under src/.
 *
 * Confirmed 2026-09-08 by live generateContent calls against
 * `northamerica-northeast1` on project `thehammer` — documentation alone was
 * what made #108 wrong in the first place. Full working:
 * docs/planning/research-vertex-model-migration-2026-09-08.md
 */

/**
 * Text generation. `gemini-3.5-flash` is GA, served in
 * `northamerica-northeast1`, and carries a retirement of "May 19, 2027 or
 * later" — so it does not force a second migration inside the year, which is
 * what ruled out `gemini-2.5-flash` (retires 2026-10-20).
 *
 * Note this is a *thinking* model: reasoning tokens are billed at the output
 * rate and count against `maxOutputTokens`, so a budget sized for the visible
 * answer alone returns an empty one. See REPORT_MAX_OUTPUT_TOKENS below.
 */
const DEFAULT_LLM_MODEL = 'gemini-3.5-flash';

/**
 * Speech synthesis for storyboard narration.
 *
 * The previous value, `gemini-2.5-flash-preview-tts`, is an ai.google.dev
 * (Gemini API) id and has never existed on Vertex — a live probe returns 404.
 * The storyboard audio path has therefore never once succeeded, which nothing
 * noticed for the same reason nothing noticed the narrative model.
 *
 * `gemini-3.1-flash-tts-preview`, the successor Google names, is global-
 * endpoint only and would route narration text out of Canada. Not adopted.
 */
const TTS_MODEL = 'gemini-2.5-flash-tts';
const TTS_VOICE = 'Kore';

/**
 * What `llmModel` on a Project is allowed to be.
 *
 * Every entry was confirmed callable in `northamerica-northeast1` on
 * 2026-09-08. `gemini-3.6-flash` — the target issue #108 originally proposed —
 * is deliberately absent: it 404s in that region, and adopting it would have
 * meant either a silent failure or moving to the `global` endpoint, which
 * processes outside Canada.
 *
 * Frozen because an allowlist a caller can push onto is not an allowlist.
 */
const SUPPORTED_LLM_MODELS = Object.freeze([
  DEFAULT_LLM_MODEL,
  'gemini-2.5-flash', // GA, cheaper, but retires 2026-10-20 — kept as a costed fallback
  'gemini-2.5-pro',   // GA, served in-region, for Projects that want the slower reasoner
]);

/**
 * Ids that must never be accepted again. Kept as data rather than a comment so
 * the backfill can recognise a stored value that needs replacing, and so
 * "is this string one of the dead ones" has a single answer.
 */
const RETIRED_MODEL_IDS = Object.freeze([
  'gemini-1.5-flash',              // retired 2025-09-24 (-002); -001 2025-05-24
  'gemini-1.5-pro',                // same family, same retirement
  'gemini-2.5-flash-preview-tts',  // never a Vertex id at all
  'claude-3-5-sonnet@20240620',    // offered by the portal, never wired to anything
]);

/**
 * Ceiling for a Report narrative.
 *
 * On a thinking model this budget is shared with reasoning tokens — a probe
 * with 20 spent 16 of them thinking and returned no text, with
 * `finishReason: MAX_TOKENS` and a structurally valid empty answer. 2048 is
 * ample for three sentences plus the thinking that precedes them; it is named
 * here so the reason it is not smaller stays attached to the number.
 */
const REPORT_MAX_OUTPUT_TOKENS = 2048;

/**
 * How many consecutive Capture pairs one OCR Report compares (#96, ADR 0017).
 *
 * The Customer chose a capped build over an uncapped one after being shown
 * measured figures: a real two-screenshot comparison cost 2,239 input and ~870
 * output tokens, about USD 0.012, so a Storyboard of 66 Captures — 65 pairs —
 * would be roughly USD 0.80 and would grow with the Project. Twenty pairs
 * holds a Report near USD 0.25 whatever size the Storyboard reaches.
 *
 * It is a *ceiling on the comparison*, not a sample: the first twenty
 * consecutive pairs are compared and the rest are not looked at. Sampling
 * evenly across a longer Storyboard was rejected in ADR 0017 — non-adjacent
 * frames report as one change what may have taken several steps, which is
 * fabrication with a real screenshot attached.
 *
 * The artifact and the portal both state the coverage this produces, because a
 * Report that quietly examined a third of a workflow is the kind of omission
 * this issue's family is made of.
 */
const OCR_MAX_PAIRS = 20;

/**
 * How long one Storyboard slide caption may run (#124, ADR 0019).
 *
 * The layout decides this number, not taste: the hand-built Softomedia
 * Storyboard puts **six frames on a page**, which leaves each caption a fixed
 * amount of room under its screenshot. Forty-five words is what fits there at
 * a readable size — about the length of the captions in that document, which
 * run two or three short sentences.
 *
 * It is an instruction to the model, not an enforced truncation. #125 draws
 * the caption and is where an over-long one has to be made visible rather than
 * clipped; a limit that silently cut the last sentence off a client-facing
 * page would be the same class of defect as the Markdown that printed as
 * syntax.
 */
const STORYBOARD_CAPTION_MAX_WORDS = 45;

/**
 * Output budget for a Storyboard narrative, which — unlike a Report's —
 * grows with the Storyboard.
 *
 * Before #124 this call sent **no generationConfig at all**, on a thinking
 * model whose reasoning tokens are billed at the output rate and count against
 * this same budget (see DEFAULT_LLM_MODEL above). One block of prose fit
 * inside the API default; a synthesis plus a caption for every one of 66
 * Captures is a different size of answer, and a budget that runs out returns a
 * structurally valid empty one — the failure this product keeps re-learning.
 *
 * The base covers the synthesis and the model's reasoning over the images; the
 * per-slide term covers one caption at STORYBOARD_CAPTION_MAX_WORDS plus the
 * JSON around it. The ceiling is not a cost control — it is the point past
 * which a Storyboard is too large for one call and should be told so rather
 * than truncated mid-answer.
 */
const STORYBOARD_NARRATIVE_BASE_TOKENS = 8192;
const STORYBOARD_NARRATIVE_TOKENS_PER_SLIDE = 128;
const STORYBOARD_NARRATIVE_MAX_TOKENS = 32768;

function storyboardMaxOutputTokens(slideCount) {
  const slides = Number.isFinite(slideCount) && slideCount > 0 ? Math.floor(slideCount) : 0;
  return Math.min(
    STORYBOARD_NARRATIVE_BASE_TOKENS + slides * STORYBOARD_NARRATIVE_TOKENS_PER_SLIDE,
    STORYBOARD_NARRATIVE_MAX_TOKENS
  );
}

/**
 * True only for an exact allowlisted id.
 *
 * Deliberately does not trim: callers trim before validating, and a predicate
 * that quietly accepted ' gemini-3.5-flash ' would let a padded id through to
 * Vertex, which 404s on it — the same invisible failure this issue exists to
 * end.
 */
function isSupportedLlmModel(id) {
  return typeof id === 'string' && SUPPORTED_LLM_MODELS.includes(id);
}

module.exports = {
  DEFAULT_LLM_MODEL,
  TTS_MODEL,
  TTS_VOICE,
  SUPPORTED_LLM_MODELS,
  RETIRED_MODEL_IDS,
  REPORT_MAX_OUTPUT_TOKENS,
  OCR_MAX_PAIRS,
  STORYBOARD_CAPTION_MAX_WORDS,
  STORYBOARD_NARRATIVE_MAX_TOKENS,
  storyboardMaxOutputTokens,
  isSupportedLlmModel,
};
