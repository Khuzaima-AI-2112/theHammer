/**
 * #54 — EXTENSION_ID names more than one extension.
 *
 * manifest.json declares no "key", so Chrome derives the extension's id from
 * the folder it is loaded from and every unpacked copy has a different one. It
 * declares no host_permissions either, so extension calls are subject to CORS.
 * The allowlist therefore has to name each id it trusts.
 *
 * ALLOWED_ORIGINS is built once, at module load, from process.env. These
 * assignments must run before src/index is required. Jest gives each test file
 * its own module registry, so nothing here leaks into the other suites.
 */

'use strict';

const AHMED = 'effbpmnbheohelnnpgpjdknofinhnagc';
const CHRIS = 'ndmbjlbmcdlmijglkfcelbiejmghiikm';
const ADMIN = 'https://portal.example.test';

// Padded and double-separated on purpose: whatever splits this has to trim, and
// has to drop the empty entry rather than emit `chrome-extension://`.
process.env.EXTENSION_ID = `  ${AHMED} , , ${CHRIS}  `;
process.env.ADMIN_ORIGIN = ADMIN;

const request = require('supertest');
const { app } = require('../src/index');

const preflight = (origin) => request(app).options('/health').set('Origin', origin);

describe('CORS — EXTENSION_ID names more than one extension', () => {
  test.each([['Ahmed', AHMED], ['Chris', CHRIS]])(
    "%s's extension is allowed",
    async (_who, id) => {
      const origin = `chrome-extension://${id}`;
      const res = await preflight(origin);
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers.vary).toBe('Origin');
    }
  );

  test('an extension id nobody listed is refused', async () => {
    const res = await preflight('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('the empty entry does not become a bare chrome-extension:// origin', async () => {
    const res = await preflight('chrome-extension://');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('the admin origin is still allowed alongside the extensions', async () => {
    const res = await preflight(ADMIN);
    expect(res.headers['access-control-allow-origin']).toBe(ADMIN);
  });
});
