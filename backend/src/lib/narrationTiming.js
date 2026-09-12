'use strict';

/**
 * How long each slide holds the screen (#128).
 *
 * `buildShotstackTimeline` used to give every slide a fixed four seconds and
 * lay the whole narration underneath as one soundtrack. Shotstack renders the
 * *timeline's* length, so on the real 66-Capture draft that was 4.4 minutes of
 * slides under 8.2 minutes of speech: 46% of the narration synthesized,
 * paid for, and discarded. What did play was already drifting — a caption
 * taking nine seconds and one taking three both held the screen for four, so
 * by slide 30 the words were 98 seconds ahead of the slide.
 *
 * That was defensible while `narrativeText` was one block of prose about the
 * run as a whole. Since #124 the narration is the synthesis followed by one
 * caption per slide in slide order (ADR 0019), so the words are per-slide
 * and the misalignment is the product.
 *
 * The one duration that *was* measured — the synthesized WAV's own length,
 * free from its header — is divided across the captions by how much each has
 * to say. ADR 0019's 2026-09-11 section carries the argument for doing it this
 * way rather than with 67 TTS calls, and why the API offers no cheaper
 * exactness; it is not repeated here.
 *
 * **What this does not fix, stated so nobody reads more into it.** Characters
 * are a proxy for speaking time, not a measure of it, and the error is per
 * slide. Only the *endpoint* is anchored: the clips end where the audio ends,
 * but each slide's start carries the accumulated error of every slide before
 * it, pinned at both ends rather than growing without limit. That is a bounded
 * drift, not no drift, and it is worst for a caption full of URLs or
 * identifiers, which take longer to say per character than prose does.
 *
 * A blank caption is the sharper case. `buildNarrationText` drops it from the
 * speech entirely, so nothing is said while that slide is on screen, but it
 * still holds MIN_SLIDE_SECONDS — time the audio never accounted for. Every
 * slide after it runs that much late, permanently. With one soundtrack and no
 * per-slide audio there is no way to both show a Capture the Analyst included
 * and keep the words aligned; showing it wins, because a frame dropped from a
 * client deliverable is the worse failure.
 */

/**
 * The least time a slide may hold the screen.
 *
 * Two ways a slide asks for less. A caption nobody wrote has a share of zero —
 * a real state, since a draft from before #124 has none and #129 leaves an
 * Analyst unable to write one — and a zero-length clip is a frame silently
 * missing from a client deliverable. And a draft with many slides over short
 * audio divides into fractions of a second each, which is a flicker rather
 * than a Capture anyone can look at.
 *
 * Both are floored, so the floor's guarantee holds for every input: it only
 * ever lengthens the timeline, never shortens it.
 */
const MIN_SLIDE_SECONDS = 2;

/**
 * The playing time of a WAV this codebase wrote, or null if it cannot tell.
 *
 * The rate is read from the header rather than assumed: Vertex names it in
 * `inlineData.mimeType` (`audio/L16;rate=24000`) and `pcmToWav` writes back
 * whatever it was told, so a reader that hardcoded 24kHz would silently halve
 * or double every slide length the moment that changed.
 *
 * Null rather than 0 for anything unrecognisable — "I cannot tell how long
 * this is" and "this is silent" call for different behaviour from the caller,
 * and only the first should fall back to fixed-length slides.
 */
function wavDurationSeconds(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  // The byte rate and the data size are read at fixed offsets, which is only
  // sound for the canonical 44-byte layout `pcmToWav` writes. A WAV carrying a
  // `LIST` or `fact` chunk puts different numbers at 28 and 40, so checking
  // the two chunk names is what stops this answering a confident wrong
  // duration for a file it does not actually understand.
  if (buffer.toString('ascii', 12, 16) !== 'fmt ') return null;
  if (buffer.toString('ascii', 36, 40) !== 'data') return null;

  const byteRate = buffer.readUInt32LE(28);
  if (!byteRate) return null;

  const dataBytes = buffer.readUInt32LE(40);
  return dataBytes / byteRate;
}

/** Characters worth speaking. Whitespace is not time. */
function weigh(text) {
  return typeof text === 'string' ? text.trim().length : 0;
}

/**
 * Divides `audioSeconds` across the captions, in proportion to each.
 *
 * Returns `{ leadInSeconds, slideSeconds }`, or null when there is nothing to
 * divide — no slides, or no measured duration — so the caller can keep its
 * fixed-length behaviour rather than render a timeline of length nothing.
 *
 * `leadInSeconds` is the synthesis: it is about the whole run, so no single
 * slide belongs to it (ADR 0019), and it is time the first slide holds
 * before its own words begin. The caller decides what to do with it.
 *
 * The inputs must be the same text `buildNarrationText` speaks, in the same
 * order, or the shares describe a recording that was never made.
 */
function apportionNarration({ synthesis = '', captions = [], audioSeconds } = {}) {
  if (!Array.isArray(captions) || captions.length === 0) return null;
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) return null;

  const captionWeights = captions.map(weigh);
  const captionTotal = captionWeights.reduce((a, b) => a + b, 0);

  // Nothing is said about any individual slide — a draft from before #124,
  // whose narration is one block about the run. There is no alignment to be
  // had, but the timeline should still last as long as the audio rather than
  // stopping partway through it.
  if (captionTotal === 0) {
    const each = Math.max(audioSeconds / captions.length, MIN_SLIDE_SECONDS);
    return { leadInSeconds: 0, slideSeconds: captions.map(() => each) };
  }

  const synthesisWeight = weigh(synthesis);
  const perCharacter = audioSeconds / (synthesisWeight + captionTotal);

  return {
    leadInSeconds: synthesisWeight * perCharacter,
    // Flooring spends time the audio did not account for, so a floored
    // timeline runs longer than its soundtrack. That is the survivable
    // direction: silence under the last slide, rather than the narration cut
    // off mid-sentence, which is the defect being fixed.
    slideSeconds: captionWeights.map((w) => Math.max(w * perCharacter, MIN_SLIDE_SECONDS)),
  };
}

module.exports = { wavDurationSeconds, apportionNarration, MIN_SLIDE_SECONDS };
