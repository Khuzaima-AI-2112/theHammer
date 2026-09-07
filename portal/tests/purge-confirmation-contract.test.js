'use strict';

// #116 — the delete confirmation states how many Captures are about to go.
//
// Source-level, like activity-row-contract.test.js: the portal ships as plain
// scripts with no DOM harness and none is being introduced (#112, Out of
// Scope). So what is checked here is the contract across the boundary — the
// modal reads a count from the response, and the route sends one — which is
// exactly the class of defect that test exists for: a column blank for every
// row while both sides' own tests passed.
//
// What this cannot assert, deliberately: that the modal renders, and that the
// typed-name gate actually disables the button. Those need a DOM harness.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PORTAL = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(PORTAL, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(PORTAL, 'index.html'), 'utf8');
const PROJECTS_JS = fs.readFileSync(
  path.join(PORTAL, '..', 'backend', 'src', 'routes', 'admin', 'projects.js'),
  'utf8'
);

const { functionBody } = require('./lift.js');

/** The delete confirmation modal's markup. */
function deleteModalHtml() {
  const start = INDEX_HTML.indexOf('id="deleteModal"');
  assert.notStrictEqual(start, -1, 'deleteModal not found in index.html');
  const end = INDEX_HTML.indexOf('<!--', start);
  return INDEX_HTML.slice(start, end === -1 ? undefined : end);
}

// ── The count crosses the boundary ───────────────────────────────

/** Just the GET /admin/projects/:id handler, not every route after it. */
function projectRouteBody() {
  const start = PROJECTS_JS.indexOf("router.get('/projects/:id'");
  assert.notStrictEqual(start, -1, 'GET /admin/projects/:id not found');
  const end = PROJECTS_JS.indexOf('\n});', start);
  assert.notStrictEqual(end, -1, 'could not find the end of the handler');
  return PROJECTS_JS.slice(start, end);
}

test('the route serving a Project sends a Capture count', () => {
  assert.match(projectRouteBody(), /captureCount/,
    'GET /admin/projects/:id must send a count for the modal to state');
});

/**
 * The code that runs when the confirmation opens: the opener plus the helper it
 * delegates the fetch to. Both, because the count crossing the boundary is the
 * property under test and it does not matter which of the two holds it — but
 * the opener must actually call the helper, or the fetch never happens.
 */
function deleteModalPath() {
  const opener = functionBody(APP_JS, 'openDeleteModal');
  const helper = 'loadDeleteCaptureCount';

  assert.match(opener, new RegExp(helper + '\\('),
    'openDeleteModal must call ' + helper + ', or no count is ever fetched');

  return opener + functionBody(APP_JS, helper);
}

test('the modal reads the count the route sends, by the name it sends it under', () => {
  assert.match(deleteModalPath(), /captureCount/,
    'the modal must read `captureCount` — the key GET /admin/projects/:id sends. ' +
    'A different spelling here is the #116 defect: both sides pass their own tests ' +
    'and the modal states nothing.');
});

test('the count reaches the modal from the Project route, not from a list row', () => {
  assert.match(deleteModalPath(), /\/admin\/projects\//,
    'the modal must fetch the Project to get a count current at the moment of the decision');
});

// ── The sentence that stopped being true ─────────────────────────

test('the modal no longer claims uploads are unaffected', () => {
  const modal = deleteModalHtml();

  assert.ok(!/not affected/i.test(modal),
    'the Purge removes the objects, so this sentence describes behaviour the ' +
    'system no longer has. git log -S traces it to a618ee8, the original portal ' +
    'sprint — it described what the code happened to do; nobody decided it.');
  assert.ok(!/GCS/.test(modal),
    'an Admin should not be told about the bucket at all');
});

test('the modal has somewhere to state the count', () => {
  const modal = deleteModalHtml();

  assert.match(modal, /id="deleteCaptureCount"/,
    'the counted statement needs an element the opener can write the number into');
});

// ── The typed-name gate ──────────────────────────────────────────
// The gate's *behaviour* is not asserted here — that needs a DOM harness. What
// is asserted is that both halves exist and refer to each other, because a
// confirm input the code never reads is the same defect in a different place.

test('the modal offers an input to type the Project name into', () => {
  const modal = deleteModalHtml();

  assert.match(modal, /id="deleteConfirmName"/,
    'the Admin types the Project name to confirm (#116)');
});

test('the confirm button starts disabled, so a misclick cannot destroy screenshots', () => {
  const modal = deleteModalHtml();
  const button = modal.slice(modal.indexOf('id="deleteConfirmBtn"'));

  assert.match(button.slice(0, button.indexOf('>')), /disabled/,
    'deleteConfirmBtn must be disabled in the markup — the gate opens it once ' +
    'the typed name matches, and a gate that starts open has already failed');
});

test('the typed name is compared against the Project name', () => {
  const opener = functionBody(APP_JS, 'openDeleteModal');
  const gate = APP_JS.slice(APP_JS.indexOf('deleteConfirmName'));

  assert.ok(/deleteConfirmName/.test(opener + gate),
    'nothing reads the confirm input');
  assert.match(gate, /deleteConfirmBtn'\)\.disabled\s*=/,
    'the gate must drive the confirm button\'s disabled state from the typed text');
});
