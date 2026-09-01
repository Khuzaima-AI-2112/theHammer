'use strict';

// The Activity view's "Export ZIP" button.
//
// Source-level, like token-freshness.test.js: the portal ships as plain scripts
// with no module system and the tests have no DOM harness, so what can be
// checked here is structural — which helper the download goes through, and
// whether the button is actually wired to it.
//
// The structure is the defect risk. apiFetch sets Content-Type: application/json
// and calls res.json() on every reply; routed through it, a ZIP would arrive as
// a parse error rather than a file. And #39 was a token captured once at sign-in
// and reused until it expired, which is a mistake a new fetch path can repeat.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/** The source of a top-level async function, up to its closing brace. */
function functionBody(source, name) {
  const start = source.indexOf('async function ' + name + '(');
  assert.notStrictEqual(start, -1, name + ' not found in app.js');
  const end = source.indexOf('\n}', start);
  assert.notStrictEqual(end, -1, 'could not find the end of ' + name);
  return source.slice(start, end);
}

test('the export does not go through apiFetch', () => {
  const body = functionBody(APP_JS, 'exportProjectCaptures');

  assert.doesNotMatch(body, /apiFetch\(/,
    'apiFetch parses every response as JSON; a ZIP must be read with fetch and res.blob()');
  assert.match(body, /res\.blob\(\)/,
    'the archive must be read as a blob');
});

test('the export reads the token when it sends, not once at sign-in', () => {
  const body = functionBody(APP_JS, 'exportProjectCaptures');

  assert.match(body, /getIdToken\(\)/,
    'a token captured at sign-in is stale within the hour (#39)');

  const readAt = body.search(/getIdToken\(\)/);
  const usedAt = body.search(/Authorization/);
  assert.ok(readAt < usedAt,
    'the token must be read before it is attached, not the other way round');
});

test('the export calls the Project export route', () => {
  const body = functionBody(APP_JS, 'exportProjectCaptures');

  assert.match(body, /\/admin\/projects\/\$\{encodeURIComponent\(projectId\)\}\/export/,
    'the project id belongs in the path, encoded');
});

// #75. loadActivity() sends ?tool= and the export did not, so the table and
// the archive disagreed about what the filter meant. The screen said the
// filter had worked; only the ZIP's contents said otherwise.
test('the export carries the Tool filter, as the activity feed does', () => {
  const body = functionBody(APP_JS, 'exportProjectCaptures');

  assert.match(body, /activityToolFilter/,
    'the export must read the same filter control the Activity table reads');
  assert.match(body, /encodeURIComponent\(toolFilter\)/,
    'a Tool is free text and can hold characters that are not URL-safe');
  assert.match(body, /\?tool=/,
    'the route takes the filter as a tool query parameter');
});

test('the export names the download after the filter', () => {
  const body = functionBody(APP_JS, 'exportProjectCaptures');

  // Two sections of one Project both downloading as <projectId>-captures.zip
  // means the second silently becomes a (1) copy, and the operator building
  // the Storyboard cannot tell them apart.
  const download = body.match(/a\.download\s*=\s*([^;]+);/);
  assert.ok(download, 'the export must set a download file name');
  assert.match(download[1], /toolFilter/,
    'the file name must distinguish one Tool section from another');
});

test('the export refuses to run with no Project selected', () => {
  const body = functionBody(APP_JS, 'exportProjectCaptures');

  const guardAt = body.search(/if \(!projectId\)/);
  const fetchAt = body.search(/await fetch\(/);
  assert.ok(guardAt !== -1 && guardAt < fetchAt,
    'a missing project id would request /admin/projects//export, which is a 404 with no explanation');
});

test('the button exists and is wired to the export', () => {
  assert.match(INDEX_HTML, /id="activityExportBtn"/,
    'exportProjectCaptures enables and disables the button by this id');
  assert.match(INDEX_HTML, /onclick="exportProjectCaptures\(\)"/,
    'the button must call the export');
});
