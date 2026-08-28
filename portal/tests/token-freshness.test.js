'use strict';

// The portal's ID token — issue #39.
//
// A Firebase ID token is valid for one hour. app.js captured one inside
// onAuthStateChanged and reused that string for the life of the page, so every
// request an hour after sign-in carried an expired JWT and the backend answered
// 401 "unauthenticated: invalid token". It surfaced on the New Project dialog,
// which failed with no hint that a reload would have fixed it.
//
// These are source-level, like deploy-assets.test.js: there is no DOM harness
// for the portal, and the defect is structural — where the token is read, not
// what it contains.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

/** The source of a top-level async function, up to its closing brace. */
function functionBody(source, name) {
  const start = source.indexOf('async function ' + name + '(');
  assert.notStrictEqual(start, -1, name + ' not found in app.js');
  const end = source.indexOf('\n}', start);
  assert.notStrictEqual(end, -1, 'could not find the end of ' + name);
  return source.slice(start, end);
}

test('apiFetch reads the token when it sends, not once at sign-in', () => {
  const body = functionBody(APP_JS, 'apiFetch');

  assert.match(body, /getIdToken\(\)/,
    'apiFetch must ask the SDK for the token per request; a cached string goes stale in an hour');
});

test('apiFetch attaches the token it just read', () => {
  const body = functionBody(APP_JS, 'apiFetch');

  const readAt = body.search(/getIdToken\(\)/);
  const usedAt = body.search(/Authorization/);

  assert.ok(readAt !== -1 && usedAt !== -1, 'apiFetch both reads and sends a token');
  assert.ok(readAt < usedAt,
    'the token must be refreshed before the Authorization header is built, not after');
});

test('the token is read in more than one place, so the gate is not the only source', () => {
  const sites = APP_JS.match(/getIdToken\(\)/g) || [];

  assert.ok(sites.length >= 2,
    'expected the sign-in gate and apiFetch to each read the token; found ' + sites.length);
});
