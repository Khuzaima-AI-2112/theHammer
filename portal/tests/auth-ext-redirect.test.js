'use strict';

// auth-ext.html handed a Firebase ID token, refresh token and API key to
// whatever address `redirect_uri` named, unvalidated — #80. The recipient
// could mint new ID tokens indefinitely with the refresh token, and the page
// reported success even to a visitor it was redirecting nowhere useful.
//
// Two tests, per the issue: a source-level one that goes red if the validating
// branch between reading redirect_uri and assigning window.location is ever
// removed, and a unit test over the validator itself once the extension-id
// allowlist is injected.
//
// There is no DOM harness for the portal (see token-freshness.test.js), so the
// validator is lifted out of the source and exercised directly, the way
// project-id.test.js lifts normaliseProject.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { lift } = require('./lift');

const AUTH_EXT = fs.readFileSync(path.join(__dirname, '..', 'auth-ext.html'), 'utf8');

const isAllowedRedirectUri = lift(AUTH_EXT, 'isAllowedRedirectUri');

// ── Source-level: the redirect cannot skip the validating branch ───────────

test('window.location is assigned from redirect_uri only behind a validity check', () => {
  const readAt = AUTH_EXT.indexOf("urlParams.get('redirect_uri')");
  const checkedAt = AUTH_EXT.indexOf('isAllowedRedirectUri(redirectUri');
  const guardedAt = AUTH_EXT.indexOf('if (redirectUriIsValid)');
  const assignedAt = AUTH_EXT.indexOf('window.location.href = `${redirectUri}');

  assert.ok(readAt !== -1, 'redirect_uri is no longer read from the query string');
  assert.ok(checkedAt !== -1, 'isAllowedRedirectUri is no longer called on redirect_uri');
  assert.ok(guardedAt !== -1, 'the redirect is no longer gated on redirectUriIsValid');
  assert.ok(assignedAt !== -1, 'window.location is no longer assigned for the redirect flow');

  assert.ok(readAt < checkedAt && checkedAt < guardedAt && guardedAt < assignedAt,
    'redirect_uri must be read, validated, and only then used to guard the redirect — in that order');
});

test('an unrecognised redirect_uri does not fall into the plain success message', () => {
  const invalidAt = AUTH_EXT.indexOf('This sign-in link is not valid.');
  const successAt = AUTH_EXT.indexOf('Successfully signed in');

  assert.ok(invalidAt !== -1, 'the fail-closed message is gone — an invalid redirect_uri must not look like success');
  assert.ok(invalidAt < successAt,
    'the invalid-redirect branch must be checked, and return, before the no-redirect success branch runs');
});

// ── Unit: the validator ─────────────────────────────────────────────────────

const REAL_ID = 'effbpmnbheohelnnpgpjdknofinhnagc';
const OTHER_KNOWN_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ALLOWED = [REAL_ID, OTHER_KNOWN_ID];

test('a chromiumapp.org callback for a known extension id passes', () => {
  assert.strictEqual(
    isAllowedRedirectUri(`https://${REAL_ID}.chromiumapp.org/`, ALLOWED),
    true);
});

test('a well-formed callback for an unknown extension id fails', () => {
  const unknownId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.strictEqual(
    isAllowedRedirectUri(`https://${unknownId}.chromiumapp.org/`, ALLOWED),
    false);
});

test('a lookalike host fails', () => {
  assert.strictEqual(
    isAllowedRedirectUri(`https://${REAL_ID}.chromiumapp.org.evil.example/`, ALLOWED),
    false);
  assert.strictEqual(
    isAllowedRedirectUri(`https://evil.example/${REAL_ID}.chromiumapp.org/`, ALLOWED),
    false);
});

test('a non-https scheme fails, including chrome-extension itself', () => {
  assert.strictEqual(
    isAllowedRedirectUri(`http://${REAL_ID}.chromiumapp.org/`, ALLOWED),
    false);
  assert.strictEqual(
    isAllowedRedirectUri(`chrome-extension://${REAL_ID}/`, ALLOWED),
    false);
});

test('a string that is not a URL at all fails rather than throwing', () => {
  assert.strictEqual(isAllowedRedirectUri('not-a-url', ALLOWED), false);
  assert.strictEqual(isAllowedRedirectUri('', ALLOWED), false);
});

test('an empty allowlist accepts nothing', () => {
  assert.strictEqual(
    isAllowedRedirectUri(`https://${REAL_ID}.chromiumapp.org/`, []),
    false);
});
