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

// ── #41 follow-up: the message has to name the right cause ──────────────
//
// Unwrapping alone did not finish the ticket. `unexpected users response shape`
// still landed in the same catch as a fetch failure, and the table still said
// "Check API connectivity" — the exact framing the third `Done when` forbids,
// and the one lessons_learned.md 55 rule 3 was written about.

const listFailureMessage = lift(APP_JS, 'listFailureMessage');

test('a decode failure is marked so the caller can tell it from a dead network', () => {
  try {
    unwrapList({ nope: true }, 'users');
    assert.fail('a bad shape should have thrown');
  } catch (err) {
    assert.strictEqual(err.isDecodeFailure, true,
      'without this flag every failure shares one message');
    assert.match(err.message, /unexpected users response shape/);
  }
});

test('a decode failure is not reported as a connection problem', () => {
  const err = Object.assign(new Error('unexpected users response shape'), { isDecodeFailure: true });
  const msg = listFailureMessage(err, 'users');

  assert.doesNotMatch(msg, /connectivity|connection/i,
    'blaming the network for a 200 is the whole defect in #41');
  assert.match(msg, /unexpected shape|bug/i);
});

test('a genuine transport failure still tells the reader to check the connection', () => {
  const msg = listFailureMessage(new TypeError('Failed to fetch'), 'users');

  assert.match(msg, /Check API connectivity/);
});

test('the message names the list that failed', () => {
  assert.match(listFailureMessage(new Error('x'), 'activity'), /activity/);
  assert.match(listFailureMessage(new Error('x'), 'projects'), /projects/);
});

test('no error row hardcodes the connectivity message any more', () => {
  // Prose in the comments may quote the old string; code must not.
  const code = APP_JS.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const hits = code.split('Check API connectivity').length - 1;

  assert.strictEqual(hits, 1,
    'the sentence should survive in exactly one place: listFailureMessage');
});

test('every list error row routes through listFailureMessage', () => {
  for (const what of ['users', 'activity', 'projects']) {
    assert.ok(APP_JS.includes(`listFailureMessage(err, '${what}')`),
      `the ${what} error row should ask listFailureMessage for its text`);
  }
});
