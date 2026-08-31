'use strict';

// The Activity table renders what the API actually sends — issue: every row's
// PATH and SIZE column showed an em dash, for every Capture, always.
//
// Source-level, like capture-export.test.js: the portal ships as plain scripts
// with no DOM harness, so what can be checked here is structural.
//
// The defect this catches is a mismatch across a boundary, so the test has to
// read both sides. `renderActivity` reads `u.path` and `u.size`; the backend's
// serializeUpload sends `gcsPath` and `fileSizeBytes`. Both files are correct on
// their own and no single-file test can see the gap between them — which is why
// backend/tests and portal/tests both passed while the column was always blank.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const ACTIVITY_JS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'backend', 'src', 'routes', 'admin', 'activity.js'),
  'utf8'
);

/** The source of a top-level function, up to its closing brace. */
function functionBody(source, name) {
  const start = source.search(new RegExp('(async )?function ' + name + '\\('));
  assert.notStrictEqual(start, -1, name + ' not found');
  const end = source.indexOf('\n}', start);
  assert.notStrictEqual(end, -1, 'could not find the end of ' + name);
  return source.slice(start, end);
}

/**
 * The keys one upload object carries out of GET /admin/projects/:id/activity:
 * serializeUpload's own keys, plus the three the route spreads on afterwards.
 */
function keysTheApiSends() {
  const body = functionBody(ACTIVITY_JS, 'serializeUpload');
  const keys = [...body.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
  assert.ok(keys.length > 5, 'failed to parse serializeUpload; the regex needs updating');
  return new Set([...keys, 'userDisplayName', 'userEmail', 'signedUrl', 'hasGap', 'gapMs']);
}

/** Every `u.<key>` the Activity table reads off a row. */
function keysTheTableReads() {
  const body = functionBody(APP_JS, 'renderActivity') +
               functionBody(APP_JS, 'updateActivityStats');
  return new Set([...body.matchAll(/\bu\.(\w+)/g)].map((m) => m[1]));
}

test('every field the Activity table reads is a field the API sends', () => {
  const sent = keysTheApiSends();
  const read = keysTheTableReads();
  const missing = [...read].filter((k) => !sent.has(k));

  assert.deepStrictEqual(missing, [],
    'the Activity table reads ' + JSON.stringify(missing) +
    ', which GET /admin/projects/:id/activity does not send. ' +
    'A field the API does not send is undefined at render time, so the column ' +
    'is blank for every row and no test on either side of the boundary sees it. ' +
    'The API sends: ' + JSON.stringify([...sent].sort()));
});
