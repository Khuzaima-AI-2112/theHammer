'use strict';

// Paginated list responses in the portal — issue #41.
//
// /admin/users answers { users, total, nextCursor } and app.js assigned the
// whole body to `allUsers`, which updateUserStats then called .filter() on. The
// TypeError landed in loadUsers' own catch, so a 200 was reported to the user as
// "Failed to load users. Check API connectivity."
//
// There is no DOM harness for the portal, so unwrapList is lifted out of the
// source and exercised directly; the call sites are checked statically, the way
// deploy-assets.test.js checks the image.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

/** Lift a top-level function out of app.js and make it callable here. */
function lift(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notStrictEqual(start, -1, name + ' not found in app.js');
  const end = source.indexOf('\n}', start);
  assert.notStrictEqual(end, -1, 'could not find the end of ' + name);
  return new Function('return (' + source.slice(start, end + 2) + ')')();
}

const unwrapList = lift(APP_JS, 'unwrapList');

test('unwrapList takes the array out of a paginated envelope', () => {
  const body = { users: [{ email: 'a@test' }, { email: 'b@test' }], total: 2, nextCursor: null };

  assert.deepStrictEqual(unwrapList(body, 'users').map(u => u.email), ['a@test', 'b@test']);
});

test('unwrapList reads the key it is given, not a fixed one', () => {
  assert.strictEqual(unwrapList({ uploads: [1, 2, 3], total: 3 }, 'uploads').length, 3);
  assert.strictEqual(unwrapList({ projects: [1], total: 1 }, 'projects').length, 1);
});

test('an empty page is an empty list, not an error', () => {
  assert.deepStrictEqual(unwrapList({ users: [], total: 0, nextCursor: null }, 'users'), []);
});

test('a bare array still works, so an unpaginated route is not broken', () => {
  const arr = [{ email: 'a@test' }];

  assert.strictEqual(unwrapList(arr, 'users'), arr);
});

test('a body in neither shape is refused rather than shown as an empty table', () => {
  for (const junk of [null, undefined, {}, { users: null }, { total: 0 }, 42, 'nope']) {
    assert.throws(
      () => unwrapList(junk, 'users'),
      (e) => e.message.includes('unexpected'),
      'should have refused: ' + JSON.stringify(junk)
    );
  }
});

// ── The call sites ───────────────────────────────────────────────
// The helper is only worth having if every list assignment goes through it.

for (const [variable, key] of [['allProjects', 'projects'], ['allUsers', 'users'], ['activityFeed', 'uploads']]) {
  test(variable + ' is unwrapped with the ' + key + ' key', () => {
    const assignment = APP_JS.split('\n').find(
      (l) => l.includes(variable) && l.includes('apiFetch')
    );

    assert.ok(assignment, 'no apiFetch assignment found for ' + variable);
    assert.match(assignment, /unwrapList\(/,
      variable + ' assigns a raw response body: ' + assignment.trim());
    assert.ok(assignment.includes("'" + key + "'"),
      variable + ' must be unwrapped with the ' + key + ' key: ' + assignment.trim());
  });
}
