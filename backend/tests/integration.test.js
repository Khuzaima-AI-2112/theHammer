'use strict';


const request = require('supertest');
const { clearDatabase, seedUser, seedProject } = require('./helpers/fixtures');

let app, db;
let adminId = 'test-integration-admin';
let userId = 'test-integration-user';

beforeAll(async () => {
  app = require('../src/index').app;
  db  = require('../src/lib/firestore').db;

  await clearDatabase();
  await seedUser(adminId, {
    email: 'admin@integration.test',
    displayName: 'Test Admin',
    role: 'admin'
  });

  await seedUser(userId, {
    email: 'user@integration.test',
    displayName: 'Test User',
    role: 'user'
  });
});

afterAll(async () => {
  await clearDatabase();
});

const H_ADMIN = { 'x-dev-user-email': 'admin@integration.test', 'content-type': 'application/json' };
const H_USER = { 'x-dev-user-email': 'user@integration.test', 'content-type': 'application/json' };

describe('Sprint 9 Integration Tests', () => {

  // #100: the key set is asserted exactly, not key by key. A per-key `typeof`
  // check passes whether or not a sixth key is present, which is how
  // `pendingExports` survived — it named a collection with no writers and could
  // only ever be 0 (lesson 69). Listing the keys is what makes reintroducing one
  // fail here rather than pass.
  test('GET /admin/dashboard/stats — returns exactly these stat keys', async () => {
    const res = await request(app).get('/admin/dashboard/stats').set(H_ADMIN);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'activeProjects',
      'activeUsersToday',
      'capturesToday',
      'pendingReports'
    ]);
    for (const key of Object.keys(res.body)) {
      expect(typeof res.body[key]).toBe('number');
    }
  });

  // Note: testing rate limiting with supertest and express-rate-limit 
  // requires hitting the limit in a loop.
  // The global limit is 60 req / min. The report generate limit for analysts is 10/hr.
  // We will just verify that the route returns 400 for bad input (meaning rate limiting didn't block first request), 
  // then we might hit rate limit if we loop. But to keep tests fast, we just verify auth works.
  // #99: this case used to name a Project that does not exist and assert the
  // Analyst's answer was "not 403", using the status code to tell "the role gate
  // let me through" apart from "no such Project". Those are one code now, so the
  // proxy no longer works — and it was always a weak one, since it passed for
  // any non-403 including a 500. It now names a Project the caller really owns
  // and asserts the request is accepted, which is what "an Analyst can access
  // this route" was always supposed to mean.
  test('POST /admin/reports/generate — Analyst can access, User cannot', async () => {
    await seedProject('integration-report-project', { name: 'Reportable' });

    // Promote explicitly. This used to rely on the api_keys sync test above
    // having already set the role, which made the two tests order-dependent.
    await db.collection('users').doc(userId).update({ role: 'analyst' });

    const resAnalyst = await request(app).post('/admin/reports/generate').set(H_USER)
      .send({ projectId: 'integration-report-project', reportType: 'executive_summary' });
    expect(resAnalyst.status).toBe(202);
    expect(resAnalyst.body.reportId).toBeTruthy();

    // Revert to user
    await db.collection('users').doc(userId).update({ role: 'user' });

    const resUser = await request(app).post('/admin/reports/generate').set(H_USER)
      .send({ projectId: 'integration-report-project', reportType: 'executive_summary' });
    expect(resUser.status).toBe(403);
  });

});
