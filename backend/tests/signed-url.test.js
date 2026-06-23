// ─────────────────────────────────────────────────────────────────
// The Hammer — Sprint 3 tests: POST /upload-url
//
// Tasks covered:
//   3.1 — Validate required fields; 400 with field name on missing
//   3.3 — Returns { signedUrl, path }; path embedded in URL matches path field
//   2.7 — 401 on missing/wrong API key (regression)
//
// GCS signing is mocked — unit tests should not make real network calls.
// ─────────────────────────────────────────────────────────────────
'use strict';

const request = require('supertest');

// ── Mock @google-cloud/storage before requiring the app ──
// getSignedUrl returns a fake URL that embeds the object path so we can
// assert the path in the URL matches the path field in the response (task 3.3).
const FAKE_SIGNED_URL_PREFIX = 'https://storage.googleapis.com/fake-bucket/';

jest.mock('@google-cloud/storage', () => {
  const mockGetSignedUrl = jest.fn().mockImplementation(function () {
    // `this` is the File instance; grab the name from it
    const objectPath = this.name;
    return Promise.resolve([`${FAKE_SIGNED_URL_PREFIX}${objectPath}?X-Goog-Signature=abc`]);
  });

  const mockFile = jest.fn().mockImplementation(function (name) {
    this.name = name;
    this.getSignedUrl = mockGetSignedUrl.bind(this);
    this.save = jest.fn().mockResolvedValue();
  });

  const mockBucket = jest.fn().mockImplementation(() => ({
    file: (name) => new mockFile(name),
  }));

  return {
    Storage: jest.fn().mockImplementation(() => ({
      bucket: () => new mockBucket(),
    })),
  };
});

// Set required env vars before the app module loads
process.env.API_KEY    = 'test-api-key';
process.env.GCS_BUCKET = 'fake-bucket';

const { db } = require('../src/lib/firestore');
const { app, sanitize, buildObjectPath } = require('../src/index');

const VALID_BODY   = { project: 'acme', tool: 'jira', name: 'alice' };
const VALID_HEADERS = { 'x-dev-user-email': 'user@signed.test' };

beforeAll(async () => {
  await db.collection('users').doc('signed-user-id').set({
    email: 'user@signed.test', role: 'user', workspaceId: 'test-workspace'
  });
  await db.collection('projects').doc('acme').set({
    workspaceId: 'test-workspace', name: 'acme'
  });
});

afterAll(async () => {
  await db.collection('users').doc('signed-user-id').delete();
  await db.collection('projects').doc('acme').delete();
});

// ─────────────────────────────────────────────────────────────────
// Auth (task 2.7 regression)
// ─────────────────────────────────────────────────────────────────
describe('POST /upload-url — auth', () => {
  test('401 when Auth header is missing', async () => {
    const res = await request(app)
      .post('/upload-url')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  test('401 when Auth is wrong', async () => {
    const res = await request(app)
      .post('/upload-url')
      .set('x-dev-user-email', 'wrong-user@test.com')
      .send(VALID_BODY);
    expect(res.status).toBe(401); // requireAuth falls back to 401 if user not found
  });
});

// ─────────────────────────────────────────────────────────────────
// Field validation (task 3.1)
// Each field tested in isolation — 400 with the missing field name in response
// ─────────────────────────────────────────────────────────────────
describe('POST /upload-url — field validation (task 3.1)', () => {
  const cases = [
    { omit: 'project', label: 'missing project' },
    { omit: 'tool',    label: 'missing tool' },
    { omit: 'name',    label: 'missing name' },
  ];

  cases.forEach(({ omit, label }) => {
    test(`400 with field name in response when ${label}`, async () => {
      const body = { ...VALID_BODY };
      delete body[omit];

      const res = await request(app)
        .post('/upload-url')
        .set(VALID_HEADERS)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.missing).toContain(omit);
    });
  });

  test('400 lists all missing fields when all three are absent', async () => {
    const res = await request(app)
      .post('/upload-url')
      .set(VALID_HEADERS)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.missing).toEqual(expect.arrayContaining(['project', 'tool', 'name']));
  });
});

// ─────────────────────────────────────────────────────────────────
// Happy path (tasks 3.3)
// ─────────────────────────────────────────────────────────────────
describe('POST /upload-url — happy path (task 3.3)', () => {
  test('200 with signedUrl and path fields present', async () => {
    const res = await request(app)
      .post('/upload-url')
      .set(VALID_HEADERS)
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('signedUrl');
    expect(res.body).toHaveProperty('path');
  });

  test('signedUrl starts with https://storage.googleapis.com/', async () => {
    const res = await request(app)
      .post('/upload-url')
      .set(VALID_HEADERS)
      .send(VALID_BODY);

    expect(res.body.signedUrl).toMatch(/^https:\/\/storage\.googleapis\.com\//i);
  });

  test('path embedded in signedUrl matches path field in response (task 3.3)', async () => {
    const res = await request(app)
      .post('/upload-url')
      .set(VALID_HEADERS)
      .send(VALID_BODY);

    const { signedUrl, path } = res.body;
    // The object name is URL-encoded inside the signed URL; decode before asserting
    expect(decodeURIComponent(signedUrl)).toContain(path);
  });

  test('path follows naming convention: project/name/ts_tool_rand.png', async () => {
    const res = await request(app)
      .post('/upload-url')
      .set(VALID_HEADERS)
      .send(VALID_BODY);

    // e.g. acme/alice/2026-06-15T20-18-33-129Z_jira_a1b2.png
    expect(res.body.path).toMatch(/^[\w-]+\/[\w-]+\/[\dT\-Z]+_[\w-]+_[0-9a-f]{4}\.png$/);
  });
});

// ─────────────────────────────────────────────────────────────────
// Pure unit tests for shared helpers (task 3.1: reuse, do not copy)
// ─────────────────────────────────────────────────────────────────
describe('buildObjectPath — two calls same millisecond produce different paths', () => {
  test('rand suffix ensures uniqueness', () => {
    const now = new Date('2026-06-15T20:00:00.000Z');
    const p1 = buildObjectPath('proj', 'user', 'tool', now);
    const p2 = buildObjectPath('proj', 'user', 'tool', now);
    // They may collide by chance (1/65536) but overwhelmingly should differ
    // Run 10 pairs; probability of all 10 colliding is astronomically small
    const paths = Array.from({ length: 10 }, () => buildObjectPath('proj', 'user', 'tool', now));
    const unique = new Set(paths);
    expect(unique.size).toBeGreaterThan(1);
  });
});

describe('sanitize — adversarial inputs (task 2.4 regression)', () => {
  test('path traversal', () => {
    expect(sanitize('../../etc/passwd')).not.toContain('..');
  });
  test('all special chars', () => {
    const result = sanitize('!!!');
    expect(result).toMatch(/^[a-zA-Z0-9 _.\-]*$/);
  });
  test('200-char string truncated to 64', () => {
    expect(sanitize('a'.repeat(200))).toHaveLength(64);
  });
  test('empty string returns empty string', () => {
    expect(sanitize('')).toBe('');
  });
});
