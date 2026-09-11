'use strict';

// The sign-in gate — issue #35, and the evening of 11 September 2026.
//
// Chris signed in with Google, was told "Access denied — the server returned an
// unexpected error (HTTP 403)", and reasonably concluded his account had been
// refused. It had not. He was authenticated and simply had no users record, and
// the instructions we had sent told him to "enter the invitation code" against
// a screen that had never had a field for one. Three separate faults met there:
//
//   1. The gate branched on `body.provisioned`, which a 403 never carries —
//      requireAuth answers before /me runs. The friendly "not provisioned"
//      screen was unreachable code.
//   2. The only box that redeemed an invitation lived in Workspace Settings,
//      behind the gate, so it could only be reached by someone who no longer
//      needed it.
//   3. FirebaseUI offered email/password beside Google, for accounts that are
//      Google-only, so that path could only ever offer a password reset.
//
// Source-level, like token-freshness.test.js: there is no DOM harness for the
// portal, and all three defects are structural — which branch is reachable,
// which path is fetched, which provider is listed.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { functionBody, stripComments } = require('./lift');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const CODE = stripComments(APP_JS);
const CSS = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

// ── 1. The unreachable screen ──────────────────────────────────────

test('the gate tells "not provisioned" apart by reason, not by a flag a 403 never carries', () => {
  const guard = functionBody(APP_JS, 'runAuthGuard');

  assert.match(guard, /body\.error === 'not provisioned'/,
    'the gate must branch on the reason the API gave; `provisioned` is absent on the 403 path');
});

test('the not-provisioned branch is checked before the generic error', () => {
  const guard = stripComments(functionBody(APP_JS, 'runAuthGuard'));

  const byReason = guard.search(/not provisioned/);
  const generic = guard.search(/unexpected error/);

  assert.ok(byReason !== -1 && generic !== -1, 'both branches exist');
  assert.ok(byReason < generic,
    'the generic "unexpected error" catch-all must come last, or it swallows the 403 it was meant to explain');
});

test('an unprovisioned account is offered the invite field, not a dead end', () => {
  const guard = functionBody(APP_JS, 'runAuthGuard');

  assert.match(guard, /showInviteRedemption\(/,
    'the not-provisioned branch must lead somewhere the person can act');
});

// ── 2. The box that could not be reached ───────────────────────────

test('the gate renders an invitation-code input', () => {
  assert.match(CODE, /id="gateInviteToken"/,
    'the sign-in screen must carry a field for the code the instructions tell people to enter');
});

test('redeeming from the gate goes to the join route', () => {
  const redeem = functionBody(APP_JS, 'redeemInvitation');

  assert.match(redeem, /\/admin\/workspaces\/join/,
    'redemption must POST to the route that creates the users record');
  assert.match(redeem, /method: 'POST'/, 'join is a POST');
});

test('the gate and Workspace Settings share one redemption path', () => {
  const joinSites = CODE.match(/\/admin\/workspaces\/join/g) || [];

  assert.strictEqual(joinSites.length, 1,
    'both callers must go through redeemInvitation; a second hardcoded path is where the two screens drift');

  assert.match(functionBody(APP_JS, 'joinWorkspace'), /redeemInvitation\(/,
    'the Settings box must use the shared helper too');
});

test('a refused code shows the API\'s own words rather than a flattened "invalid"', () => {
  const guard = functionBody(APP_JS, 'runAuthGuard');

  assert.match(guard, /err\.message/,
    'the API distinguishes an expired code from one raised for another address; both are actionable');
});

// ── 3. The provider that could not work ────────────────────────────

test('sign-in offers Google only', () => {
  assert.ok(!/EmailAuthProvider/.test(CODE),
    'email/password cannot work for Google-only accounts — it can only offer a password reset, which reads as "your email is already taken"');
  assert.match(CODE, /GoogleAuthProvider\.PROVIDER_ID/,
    'Google must still be offered');
});

// ── The styling the gate form depends on ───────────────────────────

test('the gate form has styles, and they use a colour token that exists', () => {
  assert.match(CSS, /\.gate-join\s*\{/, 'the input row needs a rule or it stacks unstyled');

  const tokens = CSS.match(/var\(--color-[a-z-]+\)/g) || [];
  const defined = new Set((CSS.match(/--color-[a-z-]+:/g) || []).map((d) => d.slice(0, -1)));

  const missing = [...new Set(tokens)]
    .map((t) => t.slice(4, -1))
    .filter((name) => !defined.has(name));

  assert.deepStrictEqual(missing, [],
    'every --color-* the stylesheet reads must be defined; an undefined one fails silently and renders as inherited text');
});
