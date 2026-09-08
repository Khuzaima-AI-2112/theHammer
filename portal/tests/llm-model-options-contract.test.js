'use strict';

// #108 — the portal may only offer models the API will accept.
//
// Source-level, like purge-confirmation-contract.test.js: the portal ships as
// plain scripts with no DOM harness and none is being introduced (#112, Out of
// Scope). What is checked here is the contract across the boundary — the
// dropdown offers model ids, and POST/PATCH /admin/projects now refuses any id
// not on backend/src/lib/models.js's allowlist.
//
// This test exists because the backend's own guard (backend/tests/
// model-ids.test.js) stops at `src/`. The portal cannot require that module at
// runtime — it is browser code — so the id is necessarily written twice, and
// the second copy is exactly the kind that goes stale silently. Before #108
// the dropdown had been offering `gemini-1.5-pro` and a Claude model that was
// never wired to anything, for months, with nothing to say so.
//
// lib/models.js has no dependencies of its own, so requiring it here costs
// nothing and keeps one side of the contract honest by construction.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PORTAL = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(PORTAL, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(PORTAL, 'index.html'), 'utf8');

const {
  DEFAULT_LLM_MODEL, SUPPORTED_LLM_MODELS, RETIRED_MODEL_IDS,
} = require(path.join(PORTAL, '..', 'backend', 'src', 'lib', 'models.js'));

/** The value="..." of every option inside the model <select>. */
function dropdownOptionValues() {
  const select = INDEX_HTML.match(
    /<select[^>]*id="projectLlmModelSelect"[\s\S]*?<\/select>/
  );
  assert.ok(select, 'the projectLlmModelSelect dropdown should still exist');
  return [...select[0].matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
}

test('every model the dropdown offers is one the API will accept', () => {
  for (const value of dropdownOptionValues()) {
    assert.ok(
      SUPPORTED_LLM_MODELS.includes(value),
      `the dropdown offers "${value}", which POST /admin/projects would refuse with 400`
    );
  }
});

test('the dropdown offers every supported model, so none is unreachable', () => {
  const offered = dropdownOptionValues();
  for (const supported of SUPPORTED_LLM_MODELS) {
    assert.ok(
      offered.includes(supported),
      `"${supported}" is allowlisted but cannot be chosen in the portal`
    );
  }
});

test('the dropdown offers no retired model', () => {
  const offered = dropdownOptionValues();
  for (const retired of RETIRED_MODEL_IDS) {
    assert.ok(
      !offered.includes(retired),
      `the dropdown still offers the retired "${retired}"`
    );
  }
});

test("the portal's default matches the backend's default", () => {
  // Written twice by necessity; this is the line that notices when they part.
  const declared = APP_JS.match(/const DEFAULT_LLM_MODEL = '([^']+)';/);
  assert.ok(declared, 'portal/app.js should declare DEFAULT_LLM_MODEL once');
  assert.strictEqual(declared[1], DEFAULT_LLM_MODEL);
});

test('the portal names no model id outside that one declaration', () => {
  // The portal's equivalent of the backend's single-owner guard: app.js may
  // write the id once, and nowhere else may write one at all.
  const literals = [...APP_JS.matchAll(/'(gemini-[0-9][^']*)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(
    literals,
    [DEFAULT_LLM_MODEL],
    'app.js should name a model id exactly once, in the DEFAULT_LLM_MODEL declaration'
  );
});
