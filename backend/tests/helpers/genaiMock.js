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

  const generateContent = jest.fn().mockResolvedValue({ text });

  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: { generateContent }
    }))
  };
}

module.exports = { createGenAIMock };
