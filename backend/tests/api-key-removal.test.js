/**
 * Issue #4  —  Complete the API key deprecation server-side
 *
 * The architecture doc recorded API keys as fully deprecated in Sprint 23, but
 * the collection constant, the key rotation worker and a CORS advertisement of
 * the `X-Api-Key` header all outlived the decision. These tests assert the
 * *absence* of that surface, so a future change that reintroduces it fails here
 * rather than quietly re-opening a retired authentication path.
 *
 * Authentication itself is covered by tests/auth.firebase-token.test.js, and
 * the matching CORS assertion lives in tests/validation.test.js — that suite
 * already loads the app, so asserting it here would cost a second app boot for
 * one header check.
 *
 * Deliberately requires neither the app nor the emulator.
 */

'use strict';

describe('Issue #4 — API key surface is gone from the backend', () => {
  test('the collections module exports no API_KEYS constant', () => {
    const collections = require('../src/lib/collections');

    expect(collections).not.toHaveProperty('API_KEYS');
    expect(Object.values(collections)).not.toContain('api_keys');
  });

  // require() cannot tell 'file deleted' from 'file present but throwing
  // MODULE_NOT_FOUND on its own broken require' — and the worker did exactly
  // that, so require() passed this test before the file was touched.
  // require.resolve only consults the filesystem.
  test('the key rotation worker module no longer exists', () => {
    expect(() => require.resolve('../src/worker/keyRotationWorker'))
      .toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }));
  });
});
