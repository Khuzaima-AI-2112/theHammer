/**
 * Issue #4  —  Complete the API key deprecation server-side
 *
 * The architecture doc recorded API keys as fully deprecated in Sprint 23, but
 * the collection constant, the key rotation worker and a CORS advertisement of
 * the `X-Api-Key` header all outlived the decision. These tests assert the
 * *absence* of that surface, so a future change that reintroduces it fails here
 * rather than quietly re-opening a retired authentication path.
 *
 * Authentication itself is covered by tests/auth.firebase-token.test.js.
 */

'use strict';

const request = require('supertest');

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

  test('CORS no longer advertises X-Api-Key, and still advertises Authorization', async () => {
    const { app } = require('../src/index');

    const res = await request(app).options('/health');

    expect(res.status).toBe(204);
    const allowed = res.headers['access-control-allow-headers'];
    expect(allowed).not.toMatch(/x-api-key/i);
    expect(allowed).toMatch(/Authorization/);
    expect(allowed).toMatch(/Content-Type/);
  });
});
