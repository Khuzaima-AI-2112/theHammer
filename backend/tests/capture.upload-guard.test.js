// ─────────────────────────────────────────────────────────────────
// SEC-07 — pre-multer size and type validation on POST /capture
//
// A Capture upload that is too large, or is not a PNG, must be refused
// before multer buffers the request body into memory.
//
// GCS is mocked — these tests must not make real network calls.
// ─────────────────────────────────────────────────────────────────
'use strict';

const request = require('supertest');

jest.mock('@google-cloud/storage', () => {
  const mockFile = jest.fn().mockImplementation(function (name) {
    this.name = name;
    this.save = jest.fn().mockResolvedValue();
    this.getSignedUrl = jest.fn().mockResolvedValue(['https://example.test/read-url']);
  });

  return {
    Storage: jest.fn().mockImplementation(() => ({
      bucket: () => ({ file: (name) => new mockFile(name) })
    }))
  };
});

process.env.GCS_BUCKET = 'fake-bucket';

const { app, rejectOversizedUpload } = require('../src/index');
const { clearDatabase, seedUser, seedProject } = require('./helpers/fixtures');

const MB = 1024 * 1024;
const H = { 'x-dev-user-email': 'capture-user@test.com' };

// A real, if tiny, PNG. Only the declared part type is inspected, but using a
// genuine image keeps the valid case honest.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

beforeAll(async () => {
  await clearDatabase();
  await seedUser('capture-user-id', { email: 'capture-user@test.com', role: 'user' });
  await seedProject('capture-project', { name: 'Capture Project' });
});

afterAll(async () => {
  await clearDatabase();
});

// ─────────────────────────────────────────────────────────────────
// The guard decides from headers alone. This is the part that makes it
// "pre-multer": no request body is read to reach the verdict.
// ─────────────────────────────────────────────────────────────────
describe('SEC-07 — rejectOversizedUpload decides from headers alone', () => {
  function fakeRes() {
    return {
      statusCode: null,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.payload = body; return this; }
    };
  }

  test('refuses an over-limit Content-Length without touching the body', () => {
    const req = { headers: { 'content-length': String(12 * MB) } };
    const res = fakeRes();
    let nextCalled = false;

    rejectOversizedUpload(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(413);
    expect(res.payload.error).toMatch(/too large/i);
  });

  test('passes a within-limit Content-Length through to multer', () => {
    const req = { headers: { 'content-length': String(1 * MB) } };
    const res = fakeRes();
    let nextCalled = false;

    rejectOversizedUpload(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  test('passes a request with no Content-Length through to multer', () => {
    const req = { headers: {} };
    const res = fakeRes();
    let nextCalled = false;

    rejectOversizedUpload(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
describe('SEC-07 — POST /capture size and type rejection', () => {
  test('413 — an oversized upload is refused by the pre-multer guard', async () => {
    const res = await request(app)
      .post('/capture')
      .set(H)
      .field('projectId', 'capture-project')
      .attach('file', Buffer.alloc(12 * MB, 1), { filename: 'huge.png', contentType: 'image/png' });

    expect(res.status).toBe(413);
    // Distinct wording proves the pre-multer guard fired, not multer's limit.
    expect(res.body.error).toMatch(/request exceeds/i);
  });

  test('413 — multer’s own limit still backstops a body that slips past the guard', async () => {
    // Just over multer's 10MB file limit but inside the guard's envelope
    // allowance, so the guard passes it and multer must catch it.
    const res = await request(app)
      .post('/capture')
      .set(H)
      .field('projectId', 'capture-project')
      .attach('file', Buffer.alloc(10 * MB + 1024, 1), { filename: 'big.png', contentType: 'image/png' });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/File exceeds/i);
  });

  test('400 — a part declaring a non-PNG type is refused', async () => {
    const res = await request(app)
      .post('/capture')
      .set(H)
      .field('projectId', 'capture-project')
      .attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
        filename: 'evil.svg',
        contentType: 'image/svg+xml'
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image\/png/i);
  });

  test('a valid PNG Capture is unaffected and still stores', async () => {
    const res = await request(app)
      .post('/capture')
      .set(H)
      .field('projectId', 'capture-project')
      .attach('file', TINY_PNG, { filename: 'shot.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.path).toMatch(/\.png$/);
  });
});
