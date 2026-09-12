/**
 * A slide lasts as long as the words about it (#128)
 *
 * `buildShotstackTimeline` gave every slide a fixed four seconds and laid the
 * whole narration underneath. On the real draft that is 66 × 4s = 4.4 minutes
 * of slides under 8.2 minutes of speech: **46% of the narration never plays**,
 * and what does play drifts — 33s out by slide 10, 201s by the end.
 *
 * Why the one measured duration is apportioned rather than measured per
 * caption is argued in ADR 0019's 2026-09-11 section and in the module's own
 * header; what is tested here is that the arithmetic holds, and that the two
 * properties it is bought for are real — the slides last exactly as long as
 * the audio, and none of them vanishes.
 *
 * Pure arithmetic over text and a byte count. No Vertex, no Shotstack.
 */
'use strict';

const {
  wavDurationSeconds,
  apportionNarration,
  MIN_SLIDE_SECONDS,
} = require('../src/lib/narrationTiming');

/** A WAV of exactly `seconds`, shaped like the one `pcmToWav` writes. */
function wavOf(seconds, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const pcm = Buffer.alloc(Math.round(seconds * byteRate));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const sum = (ns) => ns.reduce((a, b) => a + b, 0);

describe('wavDurationSeconds', () => {
  test('reads the duration out of the header the synthesis wrote', () => {
    expect(wavDurationSeconds(wavOf(10))).toBeCloseTo(10, 3);
    expect(wavDurationSeconds(wavOf(492))).toBeCloseTo(492, 3);
  });

  test('reads the rate from the header rather than assuming 24kHz', () => {
    // Vertex names the rate in `inlineData.mimeType` (`audio/L16;rate=24000`)
    // and pcmToWav writes whatever it was told. A reader that assumed one rate
    // would silently double or halve every slide length.
    expect(wavDurationSeconds(wavOf(10, { sampleRate: 48000 }))).toBeCloseTo(10, 3);
    expect(wavDurationSeconds(wavOf(10, { sampleRate: 16000 }))).toBeCloseTo(10, 3);
  });

  test('answers null for anything that is not a WAV it wrote', () => {
    // Null rather than 0 or a throw: the caller falls back to fixed-length
    // slides, and "I could not tell" is a different thing from "no audio".
    expect(wavDurationSeconds(Buffer.alloc(10))).toBeNull();
    expect(wavDurationSeconds(Buffer.from('not audio at all, but long enough'))).toBeNull();
    expect(wavDurationSeconds(null)).toBeNull();
  });

  test('answers null for a RIFF/WAVE file laid out differently', () => {
    // A WAV carrying a `LIST` or `fact` chunk before its data is still a WAV,
    // and its byte rate and data size are not at offsets 28 and 40. Reading
    // them anyway yields a confident wrong duration, which is worse than
    // admitting it cannot tell: every slide length is derived from it.
    const wav = wavOf(10);
    wav.write('LIST', 36, 'ascii'); // where 'data' belongs
    expect(wavDurationSeconds(wav)).toBeNull();

    const noFmt = wavOf(10);
    noFmt.write('junk', 12, 'ascii'); // where 'fmt ' belongs
    expect(wavDurationSeconds(noFmt)).toBeNull();
  });
});

describe('apportionNarration', () => {
  const captions = ['one two three', 'four', 'five six seven eight nine ten'];

  test('the slides and the lead-in together last exactly as long as the audio', () => {
    // The whole point: Shotstack renders the timeline's length, so a timeline
    // shorter than its soundtrack is a narration cut off mid-sentence.
    const { leadInSeconds, slideSeconds } = apportionNarration({
      synthesis: 'A short opening.', captions, audioSeconds: 60,
    });

    expect(leadInSeconds + sum(slideSeconds)).toBeCloseTo(60, 6);
  });

  test('a slide with more to say holds the screen longer', () => {
    const { slideSeconds } = apportionNarration({
      synthesis: '', captions, audioSeconds: 60,
    });

    expect(slideSeconds[2]).toBeGreaterThan(slideSeconds[0]);
    expect(slideSeconds[0]).toBeGreaterThan(slideSeconds[1]);
    // In proportion to the words, not merely in order.
    expect(slideSeconds[0] / slideSeconds[1]).toBeCloseTo(13 / 4, 1);
  });

  test('the synthesis is a lead-in, not a slide', () => {
    // ADR 0019: the synthesis is about the run as a whole, so no one slide
    // belongs to it. It is time the first slide holds before its own words
    // start — the caller adds it to that clip.
    const { leadInSeconds } = apportionNarration({
      synthesis: 'x'.repeat(100), captions: ['y'.repeat(100)], audioSeconds: 20,
    });

    expect(leadInSeconds).toBeCloseTo(10, 6);
  });

  test('a caption nobody wrote still gets long enough to be seen', () => {
    // #129 leaves an Analyst unable to correct a caption, and a draft can
    // carry a blank one. Zero characters is zero seconds, which is a slide
    // that never appears — a frame silently dropped from a client deliverable
    // is the exact class of defect this feature keeps producing.
    const { slideSeconds } = apportionNarration({
      synthesis: '', captions: ['plenty to say here', '', 'also plenty to say'], audioSeconds: 30,
    });

    expect(slideSeconds[1]).toBe(MIN_SLIDE_SECONDS);
    expect(slideSeconds.every((s) => s > 0)).toBe(true);
  });

  test('a floor only ever lengthens the timeline, so the audio is never cut', () => {
    // Flooring spends time the audio did not account for. Lengthening leaves
    // silence under the last slide; shortening would truncate speech, which is
    // the defect being fixed. Only one of those is survivable.
    //
    // The one captioned slide takes the whole 10s by weight, and the three
    // blank ones are floored — so the total is 10 + 3 × MIN, and asserting
    // only ">= 10" would pass against code with no floor at all.
    const { leadInSeconds, slideSeconds } = apportionNarration({
      synthesis: '', captions: ['a lot of words here indeed', '', '', ''], audioSeconds: 10,
    });

    expect(slideSeconds[0]).toBeCloseTo(10, 6);
    expect(slideSeconds.slice(1)).toEqual([MIN_SLIDE_SECONDS, MIN_SLIDE_SECONDS, MIN_SLIDE_SECONDS]);
    expect(leadInSeconds + sum(slideSeconds)).toBeCloseTo(10 + 3 * MIN_SLIDE_SECONDS, 6);
  });

  test('a draft from before #124 spreads its slides evenly across the audio', () => {
    // No per-slide captions means nothing is said about any one slide, so
    // there is nothing to align to — but the timeline should still match the
    // audio rather than stopping 46% early.
    const { leadInSeconds, slideSeconds } = apportionNarration({
      synthesis: 'One block of prose about the whole run.',
      captions: ['', '', '', ''],
      audioSeconds: 40,
    });

    expect(leadInSeconds).toBe(0);
    expect(slideSeconds).toEqual([10, 10, 10, 10]);
  });

  test('and is floored too, so a long draft over short audio still shows each slide', () => {
    // The even spread is a division, and 66 slides over a minute of narration
    // is 0.9s each — a flicker, not a Capture anyone can look at. This is the
    // branch where the floor's "only ever lengthens" guarantee was false.
    const { slideSeconds } = apportionNarration({
      synthesis: 'prose', captions: Array(66).fill(''), audioSeconds: 60,
    });

    expect(slideSeconds.every((s) => s === MIN_SLIDE_SECONDS)).toBe(true);
    expect(sum(slideSeconds)).toBeGreaterThan(60);
  });

  test('answers null when there is nothing to apportion', () => {
    // The caller keeps its fixed-length behaviour rather than dividing by
    // zero or rendering a timeline of length nothing.
    expect(apportionNarration({ synthesis: 'x', captions: [], audioSeconds: 60 })).toBeNull();
    expect(apportionNarration({ synthesis: 'x', captions: ['y'], audioSeconds: 0 })).toBeNull();
    expect(apportionNarration({ synthesis: 'x', captions: ['y'], audioSeconds: null })).toBeNull();
  });

  test('the real draft: 66 captions over 8.2 minutes', () => {
    // The numbers from the issue, as a shape check on real proportions: 66
    // captions averaging ~111 characters, against 492s of measured audio.
    const real = Array.from({ length: 66 }, (_, i) => 'w'.repeat(90 + (i % 40)));
    const { leadInSeconds, slideSeconds } = apportionNarration({
      synthesis: 'w'.repeat(421), captions: real, audioSeconds: 492,
    });

    expect(leadInSeconds + sum(slideSeconds)).toBeCloseTo(492, 6);
    // Every slide lands in the band the real captions produce, and none is
    // anywhere near the four seconds they all used to get.
    expect(Math.min(...slideSeconds)).toBeGreaterThan(4);
    expect(Math.max(...slideSeconds)).toBeLessThan(12);
  });
});
