'use strict';

// #120 — the portal's Report viewer must actually view a Report.
//
// Source-level, like llm-model-options-contract.test.js: the portal ships as
// plain scripts with no DOM harness and none is being introduced (#112, Out of
// Scope). What is checked here is the contract across the boundary — the
// portal asks for a route the backend actually serves, and it surfaces the
// fields the backend actually sends.
//
// The defect this closes was not subtle and still lived for months: viewReport
// wrote `[Mockup] Viewing Report ...` into the panel while the View button was
// enabled for every finished Report. Nothing failed, nothing logged, and three
// completed pieces of work were invisible in the product (lesson 66).
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PORTAL = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(PORTAL, 'app.js'), 'utf8');
const REPORTS_ROUTES = fs.readFileSync(
  path.join(PORTAL, '..', 'backend', 'src', 'routes', 'admin', 'reports.js'), 'utf8'
);

/** The body of one top-level function declaration, brace-matched. */
function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name} is not declared in app.js`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${name} has unbalanced braces`);
}

/**
 * app.js with its comments removed.
 *
 * The check below is on what the portal *does*, not on what it says about
 * itself. Scoped deliberately, for the reason backend/tests/model-ids.test.js
 * records: an earlier version of that guard matched comments too, and a guard
 * that makes prose illegal gets worked around rather than satisfied — it had
 * already produced two reworded, inaccurate comments before that was caught.
 * The history of this defect belongs in a comment next to the fix.
 */
const APP_CODE = APP_JS
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');

test('the viewer is not a mockup any more', () => {
  assert.ok(
    !APP_CODE.includes('[Mockup]'),
    'app.js still writes a [Mockup] placeholder into a panel a user can open'
  );
});

test('viewReport asks for the artifact route the backend serves', () => {
  const body = functionSource(APP_JS, 'viewReport');

  assert.match(
    body, /\/admin\/reports\/\$\{encodeURIComponent\(reportId\)\}\/artifact/,
    'viewReport must fetch the report artifact route, with the id encoded'
  );

  // The other half of the contract: the backend registers exactly that path.
  // The portal cannot require the route file, so the two are necessarily
  // written twice, and the second copy is the kind that goes stale silently.
  assert.match(
    REPORTS_ROUTES, /router\.get\(\s*'\/reports\/:id\/artifact'/,
    'backend/src/routes/admin/reports.js must serve GET /reports/:id/artifact'
  );
});

test('the View button no longer hands the storage path to an onclick attribute', () => {
  assert.ok(
    !APP_JS.includes("viewReport('${r.id}', '${r.gcsPath || ''}')"),
    'the report row must call viewReport with the id alone'
  );
  assert.match(APP_JS, /onclick="viewReport\('\$\{r\.id\}'\)"/);
});

test('a rejected narrative is surfaced rather than silently replaced', () => {
  // #119 keeps the rejected text on the artifact precisely so a reader can see
  // that a substitution happened. A viewer that dropped it would undo that.
  const body = functionSource(APP_JS, 'renderReportArtifact');
  assert.match(body, /summaryGuard/);
  assert.match(body, /rejected/);
  assert.match(body, /rejectedSummary/);
});

test('a binary artifact is offered as a link, not rendered as text', () => {
  const body = functionSource(APP_JS, 'renderReportDownload');
  assert.match(body, /<a href=/);
  assert.match(body, /rel="noopener noreferrer"/);
});

test('every value the viewer renders passes through esc()', () => {
  // The panel is filled with innerHTML, and an artifact's contents come from a
  // model's output and a Monitored User's page. Anything interpolated raw
  // would be script the portal executes on its own origin.
  for (const name of ['renderReportArtifact', 'renderReportMetrics', 'renderReportDownload']) {
    const body = functionSource(APP_JS, name);
    const interpolations = body.match(/\$\{(?!esc\()[^}]*\}/g) || [];
    const unescaped = interpolations.filter((s) => !/^\$\{\s*(rows|parts)\s*\}$/.test(s));
    assert.deepStrictEqual(
      unescaped, [],
      `${name} interpolates unescaped values: ${unescaped.join(', ')}`
    );
  }
});

test('the viewer says what happened when there is nothing to show', () => {
  const body = functionSource(APP_JS, 'viewReport');
  assert.match(body, /catch/, 'viewReport must handle a refused or unready report');
  assert.match(
    body, /err\.message/,
    "the backend's explanation (queued, errored, artifact gone) must reach the panel"
  );
});
