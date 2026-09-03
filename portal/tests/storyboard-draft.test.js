'use strict';

// The Storyboard curation screen's wiring (#85).
//
// Source-level, like capture-export.test.js and token-freshness.test.js: the
// portal ships as plain scripts with no module system and no DOM harness, so
// what can be checked here is structural — which helper a request goes
// through, and whether the right endpoint is called.
//
// buildStoryboard and saveStoryboardDraft must go through apiFetch, not a
// raw fetch() call: apiFetch is what reads the auth token fresh per request
// (see token-freshness.test.js) rather than reusing one captured at sign-in
// (#39). A hand-rolled fetch here would quietly reintroduce that bug for
// this one screen.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/** The source of a top-level function, up to its closing brace. */
function functionBody(source, name) {
  const start = source.search(new RegExp('(async )?function ' + name + '\\('));
  assert.notStrictEqual(start, -1, name + ' not found in app.js');
  const end = source.indexOf('\n}', start);
  assert.notStrictEqual(end, -1, 'could not find the end of ' + name);
  return source.slice(start, end);
}

test('buildStoryboard calls apiFetch, not a raw fetch', () => {
  const body = functionBody(APP_JS, 'buildStoryboard');

  assert.match(body, /apiFetch\(/, 'buildStoryboard must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'buildStoryboard must not call fetch() directly');
});

test('buildStoryboard posts to the Project-scoped storyboards route', () => {
  const body = functionBody(APP_JS, 'buildStoryboard');

  assert.match(body, /\/admin\/projects\/\$\{encodeURIComponent\(projectId\)\}\/storyboards/,
    'the project id belongs in the path, encoded');
  assert.match(body, /method:\s*'POST'/, 'opening a draft is a POST — find-or-create, not a read');
});

test('saveStoryboardDraft calls apiFetch, not a raw fetch', () => {
  const body = functionBody(APP_JS, 'saveStoryboardDraft');

  assert.match(body, /apiFetch\(/, 'saveStoryboardDraft must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'saveStoryboardDraft must not call fetch() directly');
});

test('saveStoryboardDraft patches the draft by id', () => {
  const body = functionBody(APP_JS, 'saveStoryboardDraft');

  assert.match(body, /\/admin\/storyboards\/\$\{encodeURIComponent\(storyboardDraft\.id\)\}/,
    'the draft id belongs in the path, encoded');
  assert.match(body, /method:\s*'PATCH'/, 'saving edits an existing draft — PATCH, not POST');
});

test('saveStoryboardDraft sends every known Capture, not just the ones that changed', () => {
  const body = functionBody(APP_JS, 'saveStoryboardDraft');

  assert.match(body, /storyboardDraft\.captures\.map/,
    'the backend requires the full capture set on every PATCH (#85) — a partial send would be rejected');
});

test('renderStoryboardDraft escapes untrusted text before it reaches innerHTML', () => {
  const body = functionBody(APP_JS, 'renderStoryboardDraft');

  assert.match(body, /esc\(c\.captureId\)/, 'a captureId must be escaped before going into an inline handler');
  assert.match(body, /esc\(c\.note\)/, 'a note is operator-typed text and must be escaped before rendering');
});

test('the Activity view has a Build Storyboard action wired to buildStoryboard()', () => {
  assert.match(INDEX_HTML, /onclick="buildStoryboard\(\)"/,
    'the Activity toolbar must offer a way into the curation screen');
});

test('the Storyboard view exists as its own section, not a modal', () => {
  assert.match(INDEX_HTML, /id="view-storyboard"/,
    'a curation screen with thumbnails, checkboxes, reorder and notes needs a full view, not a modal');
});

// AI narrative generation (#86)

test('generateStoryboardNarrative calls apiFetch, not a raw fetch', () => {
  const body = functionBody(APP_JS, 'generateStoryboardNarrative');

  assert.match(body, /apiFetch\(/, 'generateStoryboardNarrative must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'generateStoryboardNarrative must not call fetch() directly');
});

test('generateStoryboardNarrative posts the typed prompt to the draft-scoped narrative route', () => {
  const body = functionBody(APP_JS, 'generateStoryboardNarrative');

  assert.match(body, /\/admin\/storyboards\/\$\{encodeURIComponent\(storyboardDraft\.id\)\}\/narrative/,
    'the draft id belongs in the path, encoded');
  assert.match(body, /method:\s*'POST'/, 'triggering generation is a POST');
  assert.match(body, /body:\s*JSON\.stringify\(\{\s*prompt\s*\}\)/, 'the typed prompt must be sent in the body');
});

test('startStoryboardNarrativePolling polls through apiFetch, not a raw fetch', () => {
  const body = functionBody(APP_JS, 'startStoryboardNarrativePolling');

  assert.match(body, /apiFetch\(/, 'polling must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'polling must not call fetch() directly');
  assert.match(body, /clearInterval/, 'polling must stop once the draft settles to done/error');
});

test('renderStoryboardNarrative writes generated text via a textarea value, not innerHTML', () => {
  const body = functionBody(APP_JS, 'renderStoryboardNarrative');

  assert.match(body, /textEl\.value\s*=\s*storyboardDraft\.narrativeText/,
    'AI-generated text is untrusted and must never be assigned through innerHTML');
  assert.doesNotMatch(body, /innerHTML/, 'renderStoryboardNarrative must not use innerHTML');
});

test('the Storyboard view has a prompt input and a generate action wired to generateStoryboardNarrative()', () => {
  assert.match(INDEX_HTML, /id="storyboardNarrativePrompt"/, 'an Analyst must be able to type a prompt');
  assert.match(INDEX_HTML, /onclick="generateStoryboardNarrative\(\)"/,
    'the narrative section must offer a way to trigger generation');
});

// Narrative review and edit (#87)

test('generateStoryboardNarrative confirms before regenerating over an existing narrative', () => {
  const body = functionBody(APP_JS, 'generateStoryboardNarrative');

  assert.match(body, /storyboardDraft\.narrativeText/,
    'generation must check for an existing narrative before regenerating');
  assert.match(body, /confirm\(/,
    'regenerating replaces the current narrative (including unsaved edits) and must be confirmed, not silent');
});

test('saveStoryboardNarrativeEdit calls apiFetch, not a raw fetch', () => {
  const body = functionBody(APP_JS, 'saveStoryboardNarrativeEdit');

  assert.match(body, /apiFetch\(/, 'saveStoryboardNarrativeEdit must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'saveStoryboardNarrativeEdit must not call fetch() directly');
});

test('saveStoryboardNarrativeEdit PATCHes the edited text to the draft-scoped narrative route', () => {
  const body = functionBody(APP_JS, 'saveStoryboardNarrativeEdit');

  assert.match(body, /\/admin\/storyboards\/\$\{encodeURIComponent\(storyboardDraft\.id\)\}\/narrative/,
    'the draft id belongs in the path, encoded');
  assert.match(body, /method:\s*'PATCH'/, 'editing an existing narrative is a PATCH, not a POST');
  assert.match(body, /narrativeText:\s*textEl\.value/, 'the edited text must be sent in the body');
});

test('the Storyboard view has an editable narrative textarea and a save-edit action', () => {
  assert.match(INDEX_HTML, /id="storyboardNarrativeText"[^>]*>[\s\S]{0,20}<\/textarea>/,
    'the generated narrative must be shown in an editable <textarea>, not read-only text');
  assert.match(INDEX_HTML, /onclick="saveStoryboardNarrativeEdit\(\)"/,
    'the narrative section must offer a way to save a hand edit');
});
