// ─────────────────────────────────────────────────────────────────
// SEC-07 — pre-multer size and type validation on POST /capture
//
// A Capture upload that is too large, or is not a PNG, must be refused
// before multer buffers the request body into memory.
//
// GCS is mocked — these tests must not make real network calls.
// ─────────────────────────────────────────────────────────────────
'use strict';

const { EventEmitter } = require('events');
const request = require('supertest');

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock());

process.env.GCS_BUCKET = 'fake-bucket';

const { app, rejectOversizedUpload, isClientDisconnect } = require('../src/index');
const { CONFIG_DEFAULTS } = require('../src/lib/defaults');
const { clearDatabase, seedUser, seedProject } = require('./helpers/fixtures');

const MB = 1024 * 1024;
const MAX_BYTES = CONFIG_DEFAULTS.maxFileSizeBytes;
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
// The guard decides from headers alone. This is what makes it pre-multer:
// no request body is read to reach the verdict.
// ─────────────────────────────────────────────────────────────────
describe('SEC-07 — rejectOversizedUpload decides from headers alone', () => {
  function fakeReq(contentLength) {
    const req = new EventEmitter();
    req.headers = contentLength === null ? {} : { 'content-length': String(contentLength) };
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    return req;
  }

  function fakeRes() {
    return {
      statusCode: null,
      payload: null,
      headersSent: false,
      status(code) { this.statusCode = code; this.headersSent = true; return this; },
      json(body) { this.payload = body; return this; }
    };
  }

  test('refuses an over-limit Content-Length without reading the body', () => {
    const req = fakeReq(12 * MB);
    const res = fakeRes();
    let nextCalled = false;

    rejectOversizedUpload(req, res, () => { nextCalled = true; });

    // The verdict is reached before any byte arrives: no 'data' has been emitted.
    expect(nextCalled).toBe(false);
    req.emit('end');
    expect(res.statusCode).toBe(413);
    expect(res.payload.error).toMatch(/too large/i);
  });

  test('passes a within-limit Content-Length through to multer', () => {
    const req = fakeReq(1 * MB);
    const res = fakeRes();
    let nextCalled = false;

    rejectOversizedUpload(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  test('passes a request with no Content-Length through to multer', () => {
    const req = fakeReq(null);
    const res = fakeRes();
    let nextCalled = false;

    rejectOversizedUpload(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
  });

  test('stops draining a body that claims an implausible size', () => {
    const req = fakeReq(5 * 1024 * MB); // 5GB
    const res = fakeRes();

    rejectOversizedUpload(req, res, () => {});

    // Feed it well past the drain budget; the guard must cut the request off
    // rather than read an attacker-chosen number of bytes.
    for (let i = 0; i < 64 && !req.destroyed; i += 1) {
      req.emit('data', Buffer.alloc(1 * MB));
    }

    expect(req.destroyed).toBe(true);
    expect(res.statusCode).toBe(413);
  });
});

// ─────────────────────────────────────────────────────────────────
describe('SEC-07 — POST /capture size and type rejection', () => {
  test('413 — an oversized upload is refused by the pre-multer guard', async () => {
    const res = await request(app)
      .post('/capture')
      .set(H)
      .field('projectId', 'capture-project')
      .attach('file', Buffer.alloc(MAX_BYTES + 2 * MB, 1), { filename: 'huge.png', contentType: 'image/png' });

    expect(res.status).toBe(413);
    // Distinct wording proves the pre-multer guard fired, not multer's limit.
    expect(res.body.error).toMatch(/request exceeds/i);
  });

  test('413 — multer’s own limit still backstops a body that slips past the guard', async () => {
    // Just over multer's file limit but inside the guard's envelope allowance,
    // so the guard passes it and multer must catch it.
    const res = await request(app)
      .post('/capture')
      .set(H)
      .field('projectId', 'capture-project')
      .attach('file', Buffer.alloc(MAX_BYTES + 1024, 1), { filename: 'big.png', contentType: 'image/png' });

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

// ─────────────────────────────────────────────────────────────────
// The upload route reads multer's error contract directly: it branches on
// `instanceof multer.MulterError` and on the LIMIT_FILE_SIZE code. Both are
// checked above; this pins the remaining arm, so a future major version that
// renames or reclassifies an error is caught here rather than in production.
// ─────────────────────────────────────────────────────────────────
describe('multer error contract', () => {
  test('400 — a file sent under an unexpected field name is refused', async () => {
    const res = await request(app)
      .post('/capture')
      .set(H)
      .field('projectId', 'capture-project')
      .attach('wrongField', TINY_PNG, { filename: 'shot.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unexpected field/i);
  });
});

// ─────────────────────────────────────────────────────────────────
// multer 2.x listens for request 'error', 'aborted' and 'close' and surfaces
// them to the route; 1.x did not. Untreated they become a 500 and an
// ERROR-severity log for what is an ordinary dropped upload, so the route
// classifies them. These cases pin that classification: the abort path cannot
// be provoked through supertest, but the decision it turns on can be.
// ─────────────────────────────────────────────────────────────────
describe('SEC-07 — client disconnects are not server errors', () => {
  test.each([
    ['Request closed'],
    ['Request aborted'],
    ['Request error']
  ])('recognises %s as a client disconnect', (message) => {
    expect(isClientDisconnect(new Error(message))).toBe(true);
  });

  test('does not swallow a genuine server fault', () => {
    expect(isClientDisconnect(new Error('Firestore unavailable'))).toBe(false);
    expect(isClientDisconnect(null)).toBe(false);
    expect(isClientDisconnect(undefined)).toBe(false);
  });
});
