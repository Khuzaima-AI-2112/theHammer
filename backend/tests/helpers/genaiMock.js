'use strict';

/**
 * Shared Vertex AI (`@google/genai`) double.
 *
 * Tests must never make a real Gemini call, and more than one suite needs the
 * same `models.generateContent` shape `lib/vertex.js`'s getAIClient() exposes.
 * The returned `generateContent` jest.fn is reachable through the real
 * getAIClient() singleton (`require('../../src/lib/vertex').getAIClient()`),
 * so a test can call `.mockRejectedValueOnce()` / `.mockResolvedValueOnce()`
 * on it directly to control one specific call, the same way
 * auth.firebase-token.test.js reconfigures its mocked verifyIdToken.
 *
 * Call this from inside a `jest.mock` factory. Such a factory may not close
 * over out-of-scope variables, so pass any options in as a literal.
 */
function createGenAIMock(options = {}) {
  const text = options.text ?? 'Mock narrative text.';

  // A Storyboard narrative request asks for `{ synthesis, captions }` against a
  // schema (#124, ADR 0019), and #124's own validation refuses a response whose
  // captions do not cover exactly the slides that were sent. A fixed canned
  // string cannot satisfy that across suites whose drafts hold different
  // numbers of Captures, so this double does the one thing a model following
  // the instruction would: it answers the slide numbers it was actually given.
  // `options.text` stays the synthesis, which is what those suites assert on.
  //
  // Every other call — transcription, a Report narrative, TTS — is untouched
  // and still resolves to `{ text }`. A test that needs an exact response,
  // including a malformed one, still uses mockResolvedValueOnce, which takes
  // precedence over this implementation.
  const generateContent = jest.fn().mockImplementation((req) => {
    if (!req?.config?.responseSchema?.properties?.captions) {
      return Promise.resolve({ text });
    }
    const slides = (req.contents?.[0]?.parts ?? [])
      .map((p) => /^Slide (\d+):$/.exec(p.text ?? ''))
      .filter(Boolean)
      .map((m) => Number(m[1]));
    return Promise.resolve({
      text: JSON.stringify({
        synthesis: text,
        captions: slides.map((slide) => ({ slide, caption: `Canned caption for slide ${slide}.` })),
      })
    });
  });

  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: { generateContent }
    }))
  };
}

module.exports = { createGenAIMock };
