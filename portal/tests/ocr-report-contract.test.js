'use strict';

// #96 — the portal's half of the OCR Report contract (ADR 0017).
//
// Source-level, like the other portal tests: the portal ships as plain scripts
// with no DOM harness and none is being introduced (#112, Out of Scope). What
// is checked is the contract across the boundary — the portal offers the
// report type the backend serves, asks for a Storyboard the way the backend
// requires, and escapes everything a model produced before putting it in the
// page.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PORTAL = path.join(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(PORTAL, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(PORTAL, 'index.html'), 'utf8');
const REPORTS_ROUTES = fs.readFileSync(
  path.join(PORTAL, '..', 'backend', 'src', 'routes', 'admin', 'reports.js'), 'utf8'
);
const STORYBOARD_ROUTES = fs.readFileSync(
  path.join(PORTAL, '..', 'backend', 'src', 'routes', 'admin', 'storyboards.js'), 'utf8'
);
const { OCR_MAX_PAIRS } = require(
  path.join(PORTAL, '..', 'backend', 'src', 'lib', 'models.js')
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

/** The `value="..."` of every option inside a named <select>. */
function optionValues(selectId) {
  const select = INDEX_HTML.match(
    new RegExp(`<select[^>]*id="${selectId}"[\\s\\S]*?</select>`)
  );
  assert.ok(select, `no <select id="${selectId}"> in index.html`);
  return [...select[0].matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
}

test('the two OCR report types are offered as one', () => {
  // They were never two analyses: one pass over a pair of screenshots produces
  // both kinds of finding, so offering them separately billed twice for the
  // same reading of the same two images (ADR 0017).
  const values = optionValues('reportTypeSelect');

  assert.ok(values.includes('storyboard_changes'));
  assert.ok(!values.includes('ui_state_changes'), 'the portal still offers a retired report type');
  assert.ok(!values.includes('text_entry_tracking'), 'the portal still offers a retired report type');
});

test('the type the portal offers is the type the backend serves', () => {
  // Written twice by necessity — the portal cannot require the route file —
  // which is exactly the copy that goes stale silently.
  assert.match(REPORTS_ROUTES, /const OCR_REPORT_TYPE = 'storyboard_changes'/);
  assert.match(APP_JS, /const OCR_REPORT_TYPE = 'storyboard_changes'/);
});

test('the picker is revealed with hidden, not by clearing an inline style', () => {
  // Lesson 59, and the pattern #50 exists to remove from five other sites.
  // Adding a sixth while closing a different ticket is how that list grew.
  const body = functionSource(APP_JS, 'setHidden');
  assert.match(body, /\.hidden\s*=/);
  assert.ok(!/style\.display/.test(body), 'the picker toggles display via an inline style');

  const group = INDEX_HTML.match(/<div[^>]*id="reportStoryboardGroup"[^>]*>/);
  assert.ok(group, 'no storyboard picker group in index.html');
  assert.match(group[0], /\bhidden\b/, 'the picker must start hidden via the attribute');
});

test('an OCR request names a Storyboard and never a dateRange', () => {
  const body = functionSource(APP_JS, 'submitGenerateReport');

  assert.match(body, /storyboardId/);
  assert.ok(
    !/dateRange/.test(body.replace(/\/\/[^\n]*/g, '')),
    'the portal must not send a dateRange: the backend refuses it beside a storyboardId'
  );
  assert.match(REPORTS_ROUTES, /requires a storyboardId/);
});

test('the picker reads the route the backend serves', () => {
  const body = functionSource(APP_JS, 'loadReportStoryboards');
  assert.match(body, /\/admin\/projects\/\$\{encodeURIComponent\(projectId\)\}\/storyboards/);
  assert.match(STORYBOARD_ROUTES, /router\.get\(\s*'\/projects\/:id\/storyboards'/);
});

test('the modal states coverage before a Report is generated', () => {
  // The Analyst should learn that steps 21 onward will not be examined before
  // generating, not after reading the artifact.
  const body = functionSource(APP_JS, 'storyboardCoverageText');
  assert.match(body, /ocrMaxPairs/);
  assert.match(body, /nothing to compare/);
});

test('the cap the portal promises comes from the server, not a copy of it', () => {
  // ADR 0017 puts the number in lib/models.js. A hardcoded 20 here would keep
  // promising "the first 20" after the backend enforced something else — a
  // wrong statement about what the Report examined, which is the class of
  // defect this ticket is about. A CI test comparing two constants would catch
  // drift; taking the value from the response removes the second copy.
  assert.ok(
    !/const OCR_MAX_PAIRS\s*=\s*\d/.test(APP_JS),
    'the portal hardcodes the pair cap instead of reading it from the API'
  );
  assert.match(functionSource(APP_JS, 'loadReportStoryboards'), /data\.maxPairs/);
  assert.match(STORYBOARD_ROUTES, /maxPairs: OCR_MAX_PAIRS/);
  assert.ok(
    Number.isInteger(OCR_MAX_PAIRS) && OCR_MAX_PAIRS > 0,
    'lib/models.js must define a usable OCR_MAX_PAIRS'
  );
});

test('no dollar figure is promised in the modal', () => {
  // Coverage is a fact about this Storyboard; a price is a per-token estimate
  // that goes stale the next time Google reprices, and a stale price in a UI
  // is worse than no price (ADR 0017).
  const body = functionSource(APP_JS, 'storyboardCoverageText');
  assert.ok(!/USD|\$\d|cents/.test(body));
});

test('everything an OCR artifact renders passes through esc()', () => {
  // Findings are a model's output about a Monitored User's screen, and the
  // panel is filled with innerHTML. The allowlist below is composed HTML built
  // from already-escaped pieces; anything else interpolated raw is script the
  // portal would execute on its own origin.
  const composed = /^\$\{\s*(heading|notes|body|coverage|artifact\.comparisons\.map\(renderComparison\)\.join\(''\))\s*\}$/;

  for (const name of ['renderComparison', 'renderOcrArtifact']) {
    const src = functionSource(APP_JS, name);
    const raw = (src.match(/\$\{(?!esc\()[^}]*\}/g) || [])
      .filter((s) => !composed.test(s))
      .filter((s) => !/\.map\(|\.join\(|\.filter\(/.test(s));
    assert.deepStrictEqual(raw, [], `${name} interpolates unescaped values: ${raw.join(', ')}`);
  }
});

test('a comparison that found nothing is rendered, not dropped', () => {
  // An absent finding and a pair that was never examined must not look alike —
  // the same distinction summaryGuard draws for #119 on the other worker.
  const body = functionSource(APP_JS, 'renderComparison');
  assert.match(body, /findings\.length === 0/);
  assert.match(body, /No changes detected/);
  assert.match(body, /comparison\.error/);
});

test("the Analyst's note is shown beside the finding", () => {
  // It is deliberately kept out of the prompt (leading the witness), so the
  // only place it can do its job is next to what the model reported.
  const body = functionSource(APP_JS, 'renderComparison');
  assert.match(body, /from\.note/);
  assert.match(body, /to\.note/);
});
