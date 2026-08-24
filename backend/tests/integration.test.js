'use strict';


const request = require('supertest');
const { clearDatabase, seedUser } = require('./helpers/fixtures');

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

  test('GET /admin/dashboard/stats — returns dashboard metrics', async () => {
    const res = await request(app).get('/admin/dashboard/stats').set(H_ADMIN);
    expect(res.status).toBe(200);
    expect(typeof res.body.activeProjects).toBe('number');
    expect(typeof res.body.activeUsersToday).toBe('number');
    expect(typeof res.body.capturesToday).toBe('number');
    expect(typeof res.body.pendingReports).toBe('number');
    expect(typeof res.body.pendingExports).toBe('number');
  });

  // Note: testing rate limiting with supertest and express-rate-limit 
  // requires hitting the limit in a loop.
  // The global limit is 60 req / min. The report generate limit for analysts is 10/hr.
  // We will just verify that the route returns 400 for bad input (meaning rate limiting didn't block first request), 
  // then we might hit rate limit if we loop. But to keep tests fast, we just verify auth works.
  test('POST /admin/reports/generate — Analyst can access, User cannot', async () => {
    // Promote explicitly. This used to rely on the api_keys sync test above
    // having already set the role, which made the two tests order-dependent.
    await db.collection('users').doc(userId).update({ role: 'analyst' });

    const resAnalyst = await request(app).post('/admin/reports/generate').set(H_USER)
      .send({ projectId: 'missing', reportType: 'executive_summary' });
    // Expect 404 or 400 because project doesn't exist, but NOT 403.
    expect(resAnalyst.status).not.toBe(403);

    // Revert to user
    await db.collection('users').doc(userId).update({ role: 'user' });

    const resUser = await request(app).post('/admin/reports/generate').set(H_USER)
      .send({ projectId: 'missing', reportType: 'executive_summary' });
    expect(resUser.status).toBe(403);
  });

});
