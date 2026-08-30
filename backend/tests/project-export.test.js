/**
 * GET /admin/projects/:id/export  —  ZIP of a Project's Captures
 *
 * Built for the Softomedia Storyboard work: one Project per Persona, Tool
 * `Softomedia`, and a folder of numbered pictures plus an index the operator
 * turns into a PDF by hand.
 *
 * The order is the point. A Capture's file name leads with a zero-padded
 * number, oldest first, because the export exists to be dropped into a
 * document in sequence. A test that only counted the entries would pass on a
 * ZIP that is useless.
 *
 * Firestore: emulator. Cloud Storage: mocked — no network.
 */
'use strict';

const request = require('supertest');

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock({
  signedUrlPrefix: 'https://storage.googleapis.com/fake-bucket/'
}));

process.env.GCS_BUCKET = 'fake-bucket';

const { db } = require('../src/lib/firestore');
const { app } = require('../src/index');
const collections = require('../src/lib/collections');
const { clearDatabase, seedUser, seedProject } = require('./helpers/fixtures');

const ADMIN = { 'x-dev-user-email': 'admin-export@test.com' };
const PLAIN = { 'x-dev-user-email': 'user-export@test.com' };

/** Read a binary response body into a Buffer; supertest will not do it for us. */
function binary(req) {
  return req.buffer().parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(Buffer.from(c)));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

async function seedUpload(id, data) {
  await db.collection(collections.UPLOADS).doc(id).set({
    projectId: 'persona-buyer',
    userId: 'admin-export-id',
    tool: 'Softomedia',
    stage: 'media-buyer',
    tabUrl: 'https://softomedia.example/campaigns',
    path: `persona-buyer/${id}.png`,
    bucket: 'fake-bucket',
    size: 1234,
    hasSemanticData: false,
    schemaVersion: 1,
    ...data
  });
}

beforeAll(async () => {
  await clearDatabase();
  await seedUser('admin-export-id', { email: 'admin-export@test.com', role: 'admin' });
  await seedUser('user-export-id', { email: 'user-export@test.com', role: 'user' });
  await seedProject('persona-buyer', { name: 'Persona — Media Buyer' });
  await seedProject('persona-foreign', { name: 'Other tenant', workspaceId: 'other-workspace' });
});

afterAll(async () => {
  await clearDatabase();
});

describe('GET /admin/projects/:id/export', () => {
  describe('with three Captures', () => {
    let body;

    beforeAll(async () => {
      // Seeded out of order on purpose: the route must sort, not trust
      // insertion order.
      await seedUpload('cap-b', { uploadedAt: '2026-08-30T09:05:00.000Z', tool: 'Softomedia' });
      await seedUpload('cap-c', { uploadedAt: '2026-08-30T09:11:30.000Z', tool: 'Softomedia' });
      await seedUpload('cap-a', { uploadedAt: '2026-08-30T09:00:00.000Z', tool: 'Softomedia' });

      const res = await binary(request(app).get('/admin/projects/persona-buyer/export').set(ADMIN));
      expect(res.status).toBe(200);
      body = res.body;
    });

    afterAll(async () => {
      for (const id of ['cap-a', 'cap-b', 'cap-c']) {
        await db.collection(collections.UPLOADS).doc(id).delete();
      }
    });

    test('answers with a ZIP, offered as a download', async () => {
      const res = await binary(request(app).get('/admin/projects/persona-buyer/export').set(ADMIN));
      expect(res.headers['content-type']).toMatch(/application\/zip/);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="persona-buyer-captures-\d{4}-\d{2}-\d{2}\.zip"$/);
      expect(res.body.slice(0, 2).toString('latin1')).toBe('PK');
    });

    test('names each picture by position, oldest first', () => {
      // ZIP stores entry names uncompressed in the local file header, so they
      // are readable in the raw bytes without unpacking the archive.
      const raw = body.toString('latin1');
      expect(raw).toContain('001_2026-08-30T09-00-00.png');
      expect(raw).toContain('002_2026-08-30T09-05-00.png');
      expect(raw).toContain('003_2026-08-30T09-11-30.png');
      expect(raw.indexOf('001_')).toBeLessThan(raw.indexOf('002_'));
      expect(raw.indexOf('002_')).toBeLessThan(raw.indexOf('003_'));
    });

    test('puts the right bytes under each name', () => {
      const raw = body.toString('latin1');
      // The double returns bytes that name their own object path.
      expect(raw).toContain('PNGBYTES:persona-buyer/cap-a.png');
      expect(raw).toContain('PNGBYTES:persona-buyer/cap-c.png');
      // Oldest Capture's bytes must precede the newest Capture's bytes.
      expect(raw.indexOf('PNGBYTES:persona-buyer/cap-a.png'))
        .toBeLessThan(raw.indexOf('PNGBYTES:persona-buyer/cap-c.png'));
    });

    test('carries an index with one row per Capture', () => {
      const raw = body.toString('latin1');
      expect(raw).toContain('index.csv');
      expect(raw).toContain('number,file,uploadedAt,tool,stage,tabUrl');
      expect(raw).toContain('001,001_2026-08-30T09-00-00.png,2026-08-30T09:00:00.000Z,Softomedia,media-buyer,https://softomedia.example/campaigns');
      expect(raw).toContain('003,003_2026-08-30T09-11-30.png');
    });
  });

  test('400 — refuses more than 50 Captures', async () => {
    const ids = [];
    for (let i = 0; i < 51; i++) {
      const id = `bulk-${String(i).padStart(3, '0')}`;
      ids.push(id);
      await seedUpload(id, { uploadedAt: `2026-08-31T10:${String(i % 60).padStart(2, '0')}:00.000Z` });
    }

    const res = await request(app).get('/admin/projects/persona-buyer/export').set(ADMIN);
    expect(res.status).toBe(400);
    expect(res.body.max).toBe(50);
    expect(res.body.error).toMatch(/50/);

    for (const id of ids) await db.collection(collections.UPLOADS).doc(id).delete();
  });

  test('404 — unknown Project', async () => {
    const res = await request(app).get('/admin/projects/no-such-project/export').set(ADMIN);
    expect(res.status).toBe(404);
  });

  test('404 — Project with no Captures says so, rather than sending an empty ZIP', async () => {
    const res = await request(app).get('/admin/projects/persona-buyer/export').set(ADMIN);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no captures/i);
  });

  test('403 — a Project in another Workspace', async () => {
    const res = await request(app).get('/admin/projects/persona-foreign/export').set(ADMIN);
    expect(res.status).toBe(403);
  });

  test('403 — a Monitored User is not an Admin', async () => {
    const res = await request(app).get('/admin/projects/persona-buyer/export').set(PLAIN);
    expect(res.status).toBe(403);
  });
});
