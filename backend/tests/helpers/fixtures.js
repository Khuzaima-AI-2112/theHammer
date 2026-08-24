const http = require('http');
const { db } = require('../../src/lib/firestore');
const { USER_PREFERENCES } = require('../../src/lib/defaults');
const collections = require('../../src/lib/collections');

const HEADERS = {
  admin: { 'x-dev-user-email': 'admin-fixture@test.com', 'content-type': 'application/json' },
  user:  { 'x-dev-user-email': 'user-fixture@test.com', 'content-type': 'application/json' },
  analyst: { 'x-dev-user-email': 'analyst-fixture@test.com', 'content-type': 'application/json' }
};

function clearDatabase() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8080,
      path: '/emulator/v1/projects/demo-hammer/databases/(default)/documents',
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

module.exports = {
  HEADERS,
  clearDatabase,
  seedUser,
  seedProject,
  seedMembership
};
