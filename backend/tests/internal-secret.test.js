/**
 * #105 — the internal worker secret has no literal to fall back to
 *
 * `requireWorkerAuth` and `POST /reports/generate` both used to read
 * `process.env.INTERNAL_SECRET || 'dev-secret'`. That expression never fails
 * and never logs, so nothing distinguished a configured deployment from an
 * unconfigured one — and #104 confirmed the deployed backend was the latter:
 * `INTERNAL_SECRET` is named neither in `cloudbuild.yaml` nor on the live
 * revision, so production ran on a four-word literal published in this
 * repository, on a service deployed `--allow-unauthenticated`.
 *
 * That matters because the internal path is *exempt* from #104's Workspace
 * ownership check — a genuine internal caller has no `hammerUser` to scope
 * against. A guessable secret therefore walks around the tenancy check with
 * one header.
 *
 * The rule these cases pin down: an unset `INTERNAL_SECRET` must refuse the
 * internal path, never silently accept a known value. Outside production the
 * process generates its own random secret so local development still works —
 * that value is unguessable and unwritten, so it is not a fallback in the
 * sense that matters. In production there is no such generation: one process
 * cannot invent a secret its sibling instances would have to agree on.
 *
 * Offline like the rest of the suite: Firestore is the `demo-hammer` emulator.
 */

'use strict';

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock());
jest.mock('@google/genai', () => require('./helpers/genaiMock').createGenAIMock());

process.env.GCS_BUCKET = 'fake-bucket';

// The app under test is required with the variable unset, which is the whole
// point of the route cases below. It is deleted before the require rather than
// inside a hook because the resolved secret is fixed for the life of a process.
delete process.env.INTERNAL_SECRET;

const request = require('supertest');
const { app } = require('../src/index');

/**
 * A fresh copy of the module, resolved against `env`.
 *
 * The secret is resolved once per process and cached — a value that changed
 * under a running server would refuse the requests it had just issued — so
 * each case needs its own module registry rather than its own call.
 */
function resolveWith(env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
  }

  let resolved;
  jest.isolateModules(() => {
    resolved = require('../src/lib/internalSecret').resolveInternalSecret();
  });

  for (const key of Object.keys(env)) {
    if (key in saved) process.env[key] = saved[key];
    else delete process.env[key];
  }
  return resolved;
}

// ── The route, with nothing configured ───────────────────────────────

describe('#105 — an unset INTERNAL_SECRET does not accept the published default', () => {
  test("POST /worker/reports refuses 'dev-secret'", async () => {
    const res = await request(app)
      .post('/worker/reports')
      .set({ 'x-internal-secret': 'dev-secret', 'content-type': 'application/json' })
      .send({ reportId: 'any-report', projectId: 'any-project', reportType: 'project_progress' });

    expect(res.status).toBe(401);
  });

  test("POST /worker/ocr refuses 'dev-secret'", async () => {
    const res = await request(app)
      .post('/worker/ocr')
      .set({ 'x-internal-secret': 'dev-secret', 'content-type': 'application/json' })
      .send({ reportId: 'any-report', projectId: 'any-project', reportType: 'ui_state_changes' });

    expect(res.status).toBe(401);
  });

  // The header is refused because it does not match, not because the route
  // stopped reading it. Without this, a route that ignored `x-internal-secret`
  // entirely would pass the two cases above.
  test('an empty or absent header is refused the same way', async () => {
    const absent = await request(app).post('/worker/reports')
      .set({ 'content-type': 'application/json' })
      .send({ reportId: 'any-report', projectId: 'any-project' });

    expect(absent.status).toBe(401);
  });
});

// ── The resolution rule itself ───────────────────────────────────────

describe('#105 — resolveInternalSecret()', () => {
  test('a configured secret is used as given', () => {
    expect(resolveWith({ INTERNAL_SECRET: 'a-real-configured-secret' }))
      .toBe('a-real-configured-secret');
  });

  test('an empty INTERNAL_SECRET counts as unset, not as an empty secret', () => {
    const resolved = resolveWith({ INTERNAL_SECRET: '', NODE_ENV: 'production' });
    expect(resolved).toBeNull();
  });

  test('unset in production resolves to nothing, so the internal path is refused', () => {
    expect(resolveWith({ INTERNAL_SECRET: undefined, NODE_ENV: 'production' })).toBeNull();
  });

  test('unset outside production generates a secret that is not the old literal', () => {
    const resolved = resolveWith({ INTERNAL_SECRET: undefined, NODE_ENV: 'development' });

    expect(resolved).toBeTruthy();
    expect(resolved).not.toBe('dev-secret');
    expect(resolved.length).toBeGreaterThanOrEqual(32);
  });

  test('the generated secret differs between processes', () => {
    const first  = resolveWith({ INTERNAL_SECRET: undefined, NODE_ENV: 'development' });
    const second = resolveWith({ INTERNAL_SECRET: undefined, NODE_ENV: 'development' });

    expect(second).not.toBe(first);
  });

  test('within one process it is resolved once and stays put', () => {
    let first;
    let second;
    jest.isolateModules(() => {
      const { resolveInternalSecret } = require('../src/lib/internalSecret');
      first = resolveInternalSecret();
      second = resolveInternalSecret();
    });

    expect(second).toBe(first);
  });
});
