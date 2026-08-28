'use strict';

// Issue #31 — the popup's PROJECT dropdown reads "Could not load projects".
//
// These drive the real popup-open path against the exact JSON the backend's
// GET /me/projects returns (backend/src/routes/admin/me.js:127), with a valid
// token already in storage, so the sign-in bridge is out of the picture.
//
// Run with: npm run test:extension

const test = require('node:test');
const assert = require('node:assert');
const { loadPopup } = require('./popup-harness.js');

const TOKEN = 'valid-firebase-id-token';

/** Exactly what backend/src/routes/admin/me.js:109-127 builds. */
const backendProjects = (projects) => ({ projects, total: projects.length });

const PROJECT_A = {
  id: 'proj-alpha', name: 'Alpha', memberCount: 3, status: 'active',
  role: 'member', createdAt: '2026-01-01T00:00:00.000Z', schemaVersion: 1
};
const PROJECT_B = {
  id: 'proj-beta', name: 'Beta', memberCount: 1, status: 'active',
  role: 'member', createdAt: '2026-01-02T00:00:00.000Z', schemaVersion: 1
};

/** A backend that answers /config and /me/projects the way the real one does. */
function backend(projects) {
  return async (url) => {
    if (url.endsWith('/config')) {
      return { ok: true, status: 200, json: async () => ({
        retentionDays: 90, maxFileSizeBytes: 10485760,
        defaultCaptureQuality: 'png', backendUrl: 'https://backend.test',
        schemaVersion: 1
      }) };
    }
    if (url.endsWith('/me/projects')) {
      return { ok: true, status: 200, json: async () => backendProjects(projects) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
  };
}

function signedIn(projects) {
  return loadPopup({
    local: { settings: { cloudRunUrl: 'https://backend.test', firebaseToken: TOKEN } },
    fetch: backend(projects)
  });
}

test('a signed-in popup lists the projects the backend returned', async () => {
  const popup = signedIn([PROJECT_A, PROJECT_B]);

  await popup.fireDOMContentLoaded();

  assert.ok(
    popup.requests.some((r) => r.url.endsWith('/me/projects')),
    'the popup asked the backend for projects'
  );
  assert.deepStrictEqual(
    popup.projectOptions(),
    ['— select project —', 'Alpha', 'Beta'],
    `dropdown shows: ${JSON.stringify(popup.projectOptions())}`
  );
});

test('the option values carry the project id the Session is saved against', async () => {
  const popup = signedIn([PROJECT_A, PROJECT_B]);

  await popup.fireDOMContentLoaded();

  assert.deepStrictEqual(popup.projectValues(), ['', 'proj-alpha', 'proj-beta']);
});

test('no projects assigned is a normal empty state, not a failure', async () => {
  const popup = signedIn([]);

  await popup.fireDOMContentLoaded();

  assert.deepStrictEqual(popup.projectOptions(), ['— no projects assigned —']);
});

test('a single project is auto-selected', async () => {
  const popup = signedIn([PROJECT_A]);

  await popup.fireDOMContentLoaded();

  assert.strictEqual(popup.el('project-select').value, 'proj-alpha');
  assert.strictEqual(popup.el('project-single').textContent, 'Alpha');
});

// Minimised: no storage, no fetch, no popup-open path — just the decode step
// handed the shape the backend actually sends. This is the seam the bug lived at.
test('normaliseProjects unwraps the { projects, total } envelope', () => {
  const popup = loadPopup();

  const out = popup.normaliseProjects(backendProjects([PROJECT_A, PROJECT_B]));

  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map((x) => x.name), ['Alpha', 'Beta']);
});

test('normaliseProjects carries the backend id across as projectId', () => {
  const popup = loadPopup();

  const out = popup.normaliseProjects(backendProjects([PROJECT_A]));

  assert.strictEqual(out[0].projectId, 'proj-alpha',
    'the backend names it id; the dropdown reads projectId');
});

test('normaliseProjects still accepts a bare array', () => {
  const popup = loadPopup();

  const out = popup.normaliseProjects([{ projectId: 'p1', name: 'One' }]);

  assert.deepStrictEqual(out.map((x) => x.projectId), ['p1']);
});

test('normaliseProjects refuses a body in neither shape', () => {
  const popup = loadPopup();

  for (const junk of [null, undefined, {}, { projects: null }, 42, 'nope']) {
    assert.throws(() => popup.normaliseProjects(junk), (e) => e.message.includes('unexpected'),  // not instanceof: cross-realm
      `should have refused: ${JSON.stringify(junk)}`);
  }
});

// ── Failure paths ────────────────────────────────────────────────
// The whole reason this bug survived two sessions is that every cause printed
// the same string. These pin the causes apart.

/** A signed-in popup whose backend answers /me/projects however the test says. */
function signedInWith(projectsResponse) {
  return loadPopup({
    local: { settings: { cloudRunUrl: 'https://backend.test', firebaseToken: TOKEN } },
    fetch: async (url) => url.endsWith('/me/projects')
      ? projectsResponse
      : { ok: true, status: 200, json: async () => ({ backendUrl: 'https://backend.test' }) }
  });
}

test('a 200 carrying a body in an unknown shape is reported, not shown as empty', async () => {
  const popup = signedInWith({ ok: true, status: 200, json: async () => ({ items: [] }) });

  await popup.fireDOMContentLoaded();

  assert.deepStrictEqual(popup.projectOptions(), ['Could not load projects'],
    'a wire-format fault must not masquerade as a workspace with no projects');
});

test('a 401 says the session expired rather than blaming the project list', async () => {
  const popup = signedInWith({ ok: false, status: 401, json: async () => ({}) });

  await popup.fireDOMContentLoaded();

  assert.deepStrictEqual(popup.projectOptions(), ['Session expired — sign in again']);
});

test('a 403 says the account is not provisioned', async () => {
  const popup = signedInWith({ ok: false, status: 403, json: async () => ({}) });

  await popup.fireDOMContentLoaded();

  assert.deepStrictEqual(popup.projectOptions(), ['Account not provisioned']);
});
