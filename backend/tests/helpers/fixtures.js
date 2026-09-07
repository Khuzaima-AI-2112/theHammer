const http = require('http');
const { db } = require('../../src/lib/firestore');
const { USER_PREFERENCES } = require('../../src/lib/defaults');
const collections = require('../../src/lib/collections');

const HEADERS = {
  admin: { 'x-dev-user-email': 'admin-fixture@test.com', 'content-type': 'application/json' },
  user:  { 'x-dev-user-email': 'user-fixture@test.com', 'content-type': 'application/json' },
  analyst: { 'x-dev-user-email': 'analyst-fixture@test.com', 'content-type': 'application/json' }
};

// The emulator's address is whatever tests/setup/env.js resolved, so the wipe
// and the app under test always talk to the same emulator. Hardcoding 8080 here
// meant an unrelated process on that port was silently addressed instead.
const [EMULATOR_HOST, EMULATOR_PORT] =
  (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085').split(':');

// Likewise the project id: env.js lets GCLOUD_PROJECT be overridden, and a wipe
// hardcoded to demo-hammer would then clear a namespace the app is not using.
const EMULATOR_PROJECT = process.env.GCLOUD_PROJECT || 'demo-hammer';

function clearDatabase() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: EMULATOR_HOST,
      port: Number(EMULATOR_PORT),
      path: `/emulator/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents`,
      method: 'DELETE'
    }, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end();
  });
}

async function seedUser(id, data = {}) {
  const defaultUser = {
    email: `${id}@test.com`.toLowerCase(),
    displayName: `Test User ${id}`,
    role: 'user',
    workspaceId: 'test-workspace',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    inactivityPromptEnabled: USER_PREFERENCES.inactivityPromptEnabled,
    inactivityTimerSeconds: USER_PREFERENCES.inactivityTimerSeconds,
    allowPreUploadBlur: USER_PREFERENCES.allowPreUploadBlur,
    instantClipboardLinks: USER_PREFERENCES.instantClipboardLinks,
    schemaVersion: 1
  };
  const docRef = db.collection(collections.USERS).doc(id);
  await docRef.set({ ...defaultUser, ...data });
  return docRef;
}

async function seedProject(id, data = {}) {
  const defaultProject = {
    name: `Test Project ${id}`,
    adminId: 'test-admin',
    memberCount: 0,
    workspaceId: 'test-workspace',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    schemaVersion: 1
  };
  const docRef = db.collection(collections.PROJECTS).doc(id);
  await docRef.set({ ...defaultProject, ...data });
  return docRef;
}

async function seedMembership(projectId, userId, data = {}) {
  const defaultMembership = {
    projectId,
    userId,
    role: 'user',
    joinedAt: new Date().toISOString(),
    schemaVersion: 1
  };
  const docId = `${projectId}_${userId}`;
  const docRef = db.collection(collections.MEMBERSHIPS).doc(docId);
  await docRef.set({ ...defaultMembership, ...data });
  return docRef;
}

/**
 * A Capture, as `firestoreWrite` in src/index.js writes one (#102).
 *
 * Both upload paths write through that one function, so the defaults here are
 * its field list rather than a subset chosen per suite — Capture rows used to
 * be hand-rolled in each file, which is how `workspaceId` could be added to the
 * writer and missed by every fixture.
 *
 * `workspaceId` defaults to the same Workspace as `seedProject`, so a suite
 * that seeds a Capture without thinking about tenancy gets a consistent one.
 * A suite testing the unstamped legacy rows passes `workspaceId: null`
 * explicitly.
 */
async function seedCapture(id, data = {}) {
  const merged = {
    bucket: 'test-bucket',
    size: 1024,
    projectId: 'test-project',
    userId: 'test-user',
    tool: '',
    stage: '',
    tabUrl: '',
    uploadedAt: new Date().toISOString(),
    hasSemanticData: false,
    workspaceId: 'test-workspace',
    schemaVersion: 1,
    ...data
  };
  // The production doc id is the object path percent-encoded; the path is
  // derived so a seeded row still looks like one the backend wrote.
  merged.path = merged.path || `${merged.projectId}/${merged.userId}/${id}.png`;

  const docRef = db.collection(collections.UPLOADS).doc(id);
  await docRef.set(merged);
  return docRef;
}

module.exports = {
  HEADERS,
  clearDatabase,
  seedUser,
  seedProject,
  seedMembership,
  seedCapture
};
