// ─────────────────────────────────────────────────────────────────
// #20 — a client disconnect on POST /capture, end to end
//
// capture.upload-guard.test.js pins isClientDisconnect() against message
// strings, and the pre-multer guard against a fake request. Neither reaches a
// real socket, which is how #3's 500-on-abort regression stayed green: the only
// thing under test was a function that was already correct.
//
// supertest cannot drop a connection mid-body, so these tests do not use it.
// They start the app on an ephemeral port, write a multipart body over raw
// node:http, and either destroy the socket themselves or let the server do it.
//
// Only the first test turns on isClientDisconnect(). The drain guard answers
// before multer runs, so the classifier is never consulted on that path; the
// second test goes red instead if the guard stops cutting the request off.
//
// GCS is mocked — these tests must not make real network calls.
// ─────────────────────────────────────────────────────────────────
'use strict';

const http = require('http');

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock());

process.env.GCS_BUCKET = 'fake-bucket';

const { app, DRAIN_BUDGET_BYTES } = require('../src/index');
const logger = require('../src/lib/logger');
const { clearDatabase, seedUser, seedProject } = require('./helpers/fixtures');

const KB = 1024;
const H = { 'x-dev-user-email': 'disconnect-user@test.com' };
const BOUNDARY = 'hammer-disconnect-boundary';

let server;
let port;
const seen = [];

beforeAll(async () => {
  await clearDatabase();
  await seedUser('disconnect-user-id', { email: 'disconnect-user@test.com', role: 'user' });
  await seedProject('disconnect-project', { name: 'Disconnect Project' });

  server = http.createServer(app);
  // Recorded, never read from: a 'data' listener here would start the body
  // flowing before the route's own middleware asks for it.
  server.on('request', (req, res) => seen.push({ req, res }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await clearDatabase();
});

let infoSpy;
let errorSpy;

beforeEach(() => {
  seen.length = 0;
  infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
  errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function waitFor(predicate, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function openCaptureUpload(contentLength) {
  const client = http.request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/capture',
    agent: false,
    headers: {
      ...H,
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      'content-length': String(contentLength)
    }
  });
  // The reset is the point of both tests, not a failure of either.
  client.on('error', () => {});
  return client;
}

// The start of a real Capture: the projectId field, then the file part's
// header and the first bytes of its contents. The closing boundary never comes.
function partialCaptureBody(fileBytes) {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\n` +
      'Content-Disposition: form-data; name="projectId"\r\n\r\n' +
      'disconnect-project\r\n' +
      `--${BOUNDARY}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="shot.png"\r\n' +
      'Content-Type: image/png\r\n\r\n'
    ),
    Buffer.alloc(fileBytes, 1)
  ]);
}

// ─────────────────────────────────────────────────────────────────
describe('#20 — POST /capture with a real client disconnect', () => {
  test('a Capture dropped mid-upload is logged at info, never at ERROR, and is not a 500', async () => {
    const body = partialCaptureBody(64 * KB);
    // Declare more than is sent, so the body is genuinely incomplete when the
    // socket goes, and stay inside the guard's limit so multer is what reads it.
    const client = openCaptureUpload(body.length + 512 * KB);
    client.write(body);

    await waitFor(() => seen.length === 1, 'the server to receive the request');
    const { req: serverReq, res: serverRes } = seen[0];

    // Destroying before multer is reading would test auth, not the upload. The
    // request stream starts flowing only when multer pipes it into busboy.
    await waitFor(() => serverReq.readableFlowing === true, 'multer to start reading the body');
    client.destroy();

    const endedEarly = () =>
      infoSpy.mock.calls.some(([message]) => /capture upload ended early/.test(message));
    await waitFor(
      () => endedEarly() || errorSpy.mock.calls.length > 0,
      'the route to classify the disconnect'
    );
    // Let a synchronous next(err) reach errorHandler before judging the outcome.
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).not.toHaveBeenCalled();
    expect(serverRes.statusCode).not.toBe(500);
    expect(endedEarly()).toBe(true);
  });

  test('an oversized upload is cut off at the drain budget, not read to completion', async () => {
    // Several budgets' worth, so that socket buffering on either side cannot
    // make a cut-off connection look like a completed one.
    const declared = 3 * DRAIN_BUDGET_BYTES;
    const client = openCaptureUpload(declared);

    let closed = false;
    client.on('close', () => { closed = true; });

    const chunk = Buffer.alloc(256 * KB, 1);
    let written = 0;
    while (!closed && written < declared) {
      const accepted = client.write(chunk);
      written += chunk.length;
      if (!accepted) {
        await new Promise((resolve) => {
          const done = () => {
            client.off('drain', done);
            client.off('close', done);
            resolve();
          };
          client.on('drain', done);
          client.on('close', done);
        });
      }
    }
    if (!closed) client.end();

    await waitFor(() => closed, 'the connection to close');

    expect(seen).toHaveLength(1);
    expect(seen[0].req.destroyed).toBe(true);
    // The byte counts carry the proof; a request read to its end is also marked
    // destroyed. They count what the client handed to write(), not what the
    // server read, which is why the body is several budgets long. Cut off, but
    // not before the budget: a server that dropped the connection at once would
    // bring back lesson 42's ECONNRESET.
    expect(written).toBeGreaterThanOrEqual(DRAIN_BUDGET_BYTES);
    expect(written).toBeLessThan(declared);
  });
});
