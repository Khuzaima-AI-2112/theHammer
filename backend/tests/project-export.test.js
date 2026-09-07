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

  // #75. The Activity view filters by Tool and the export ignored it, so a
  // filtered export handed back the whole Project. These tests state the
  // parity the two routes should have had from the start: the same filter
  // word means the same thing to the feed and to the archive.
  describe('?tool= — one section of a Project', () => {
    beforeAll(async () => {
      await seedUpload('mix-soft-1', { uploadedAt: '2026-08-31T10:00:00.000Z', tool: '01-Super_Admin_storyboard' });
      await seedUpload('mix-soft-2', { uploadedAt: '2026-08-31T10:05:00.000Z', tool: '01-Super_Admin_storyboard' });
      await seedUpload('mix-brand-1', { uploadedAt: '2026-08-31T14:00:00.000Z', tool: '02-BrandCaptures' });
      await seedUpload('mix-brand-2', { uploadedAt: '2026-08-31T14:05:00.000Z', tool: '02-BrandCaptures' });
      await seedUpload('mix-brand-3', { uploadedAt: '2026-08-31T14:10:00.000Z', tool: '02-BrandCaptures' });
    });

    afterAll(async () => {
      for (const id of ['mix-soft-1', 'mix-soft-2', 'mix-brand-1', 'mix-brand-2', 'mix-brand-3']) {
        await db.collection(collections.UPLOADS).doc(id).delete();
      }
    });

    test('exports only the filtered Tool, not the whole Project', async () => {
      const res = await binary(
        request(app).get('/admin/projects/persona-buyer/export?tool=02-BrandCaptures').set(ADMIN)
      );
      expect(res.status).toBe(200);
      const raw = res.body.toString('latin1');

      expect(raw).toContain('PNGBYTES:persona-buyer/mix-brand-1.png');
      expect(raw).toContain('PNGBYTES:persona-buyer/mix-brand-3.png');
      // The whole point of the issue: the other section must not be here.
      expect(raw).not.toContain('PNGBYTES:persona-buyer/mix-soft-1.png');
      expect(raw).not.toContain('PNGBYTES:persona-buyer/mix-soft-2.png');
    });

    test('numbers the filtered set from 001, not from its place in the Project', async () => {
      const res = await binary(
        request(app).get('/admin/projects/persona-buyer/export?tool=02-BrandCaptures').set(ADMIN)
      );
      const raw = res.body.toString('latin1');

      expect(raw).toContain('001_2026-08-31T14-00-00.png');
      expect(raw).toContain('003_2026-08-31T14-10-00.png');
      expect(raw).not.toContain('004_');
    });

    test('the index lists the filtered Captures only', async () => {
      const res = await binary(
        request(app).get('/admin/projects/persona-buyer/export?tool=02-BrandCaptures').set(ADMIN)
      );
      const raw = res.body.toString('latin1');

      expect(raw).toContain('number,file,uploadedAt,tool,stage,tabUrl');
      expect(raw).not.toContain('01-Super_Admin_storyboard');
    });

    test('names the file after the Tool, so two sections do not collide on disk', async () => {
      const res = await request(app)
        .get('/admin/projects/persona-buyer/export?tool=02-BrandCaptures')
        .set(ADMIN);
      expect(res.headers['content-disposition'])
        .toMatch(/^attachment; filename="persona-buyer-02-BrandCaptures-captures-\d{4}-\d{2}-\d{2}\.zip"$/);
    });

    test('404 — a Tool with no Captures, rather than an empty ZIP', async () => {
      const res = await request(app)
        .get('/admin/projects/persona-buyer/export?tool=no-such-tool')
        .set(ADMIN);
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/no captures/i);
    });
  });

  // #76's escape hatch, and the reason the filter must reach the query rather
  // than being applied to the rows after they are read. A Project over the
  // ceiling must still export one section at a time.
  test('the 50-Capture ceiling applies to the filtered set, not the Project', async () => {
    const ids = [];
    for (let i = 0; i < 26; i++) {
      for (const tool of ['sec-A', 'sec-B']) {
        const id = `ceil-${tool}-${String(i).padStart(3, '0')}`;
        ids.push(id);
        await seedUpload(id, {
          tool,
          uploadedAt: `2026-08-31T${String(10 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`
        });
      }
    }

    // finally, not a trailing loop: a failure here would otherwise leave 52
    // Captures behind and break every test after it with an unrelated 400.
    try {
      // 52 Captures in the Project: the unfiltered export is refused.
      const whole = await request(app).get('/admin/projects/persona-buyer/export').set(ADMIN);
      expect(whole.status).toBe(400);

      // 26 in each section: filtering is the way out, and it must work.
      const part = await binary(
        request(app).get('/admin/projects/persona-buyer/export?tool=sec-A').set(ADMIN)
      );
      expect(part.status).toBe(200);
      expect(part.body.toString('latin1')).not.toContain('PNGBYTES:persona-buyer/ceil-sec-B-000.png');
    } finally {
      for (const id of ids) await db.collection(collections.UPLOADS).doc(id).delete();
    }
  });

  // #76's actual complaint, which survived in the one branch #75 did not touch:
  // an error must not recommend an action the product does not offer. Tool is
  // the narrowest filter there is, so once a single section passes the ceiling
  // the operator has no way out — and the honest thing is to say so rather than
  // send them looking for a date range that was never built.
  test('a single Tool over the ceiling says so, without inventing a way out', async () => {
    const ids = [];
    for (let i = 0; i < 51; i++) {
      const id = `onetool-${String(i).padStart(3, '0')}`;
      ids.push(id);
      await seedUpload(id, {
        tool: 'sec-huge',
        uploadedAt: `2026-08-31T${String(10 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`
      });
    }

    try {
      const res = await request(app)
        .get('/admin/projects/persona-buyer/export?tool=sec-huge')
        .set(ADMIN);

      expect(res.status).toBe(400);
      expect(res.body.max).toBe(50);
      expect(res.body.error).toContain('sec-huge');
      // The whole point: no date range exists, so the message must not name one.
      expect(res.body.error).not.toMatch(/date range/i);
      expect(res.body.error).toMatch(/narrowest filter|cannot be exported/i);
    } finally {
      for (const id of ids) await db.collection(collections.UPLOADS).doc(id).delete();
    }
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

  // #99: unknown and foreign are one answer now. The 404 below is a different
  // thing — a Project the caller owns that simply has nothing to export.
  test('403 — unknown Project', async () => {
    const res = await request(app).get('/admin/projects/no-such-project/export').set(ADMIN);
    expect(res.status).toBe(403);
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
