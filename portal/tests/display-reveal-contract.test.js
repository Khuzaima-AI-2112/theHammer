'use strict';

// The portal reveals an element by assigning the display value it means, never
// by clearing the inline style.
//
// #50, and lesson 59 before it. `el.style.display = ''` removes the inline
// declaration rather than setting a value, so the element falls back to the
// cascade. In #48 that meant the extension's History tab could never open:
// `#history-panel` carried `display: none` in the stylesheet, so there was
// nothing for the cascade to fall back *to*. Its sibling panel worked, from the
// same line, purely because no rule happened to hide it.
//
// Every one of the twelve portal sites was in that second category — correct by
// accident. This guard is what stops a stylesheet edit turning one of them into
// the first, silently and with no JavaScript change to point at.
//
// The values are checked too, not just the absence of `''`: substituting
// `block` for a `<table>` or a `.storyboard-grid` would satisfy the grep and
// still be wrong. Lesson 59's own third bullet is that a stub DOM cannot tell
// `''` from the right answer, so the assertion has to name it.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { functionBody, stripComments } = require('./lift');

const APP = stripComments(
  fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8')
);

/** A literal string, made safe to embed in a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch);
}

/** Every `style.display = ''` in code, as `line: text`. */
function clearedDisplays(source) {
  return source
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => /style\.display\s*=\s*(''|""|``)/.test(text))
    .map(({ line, text }) => `${line}: ${text.trim()}`);
}

test('app.js never reveals an element by clearing its inline display', () => {
  assert.deepStrictEqual(
    clearedDisplays(APP), [],
    'assign the display value the element needs — see lesson 59'
  );
});

// Both directions, because a comment-stripping guard can go blind and nothing
// would say so (lesson 83). The prose case is not hypothetical: this file and
// app.js both have to be able to write the forbidden line down in order to
// explain why it is forbidden.
test('the guard reads code, not prose', () => {
  const prose = "// never write table.style.display = '' to reveal a table\n";
  assert.deepStrictEqual(clearedDisplays(stripComments(prose)), []);

  const code = "  table.style.display = '';\n";
  assert.strictEqual(clearedDisplays(stripComments(code)).length, 1);
});

/**
 * What each reveal means, verified against index.html and styles.css rather
 * than assumed:
 *
 * - The four tables are `<table>` elements and styles.css sets no `display` on
 *   `table` at all, so the value they were falling back to was the user agent's
 *   `table`.
 * - `#storyboardGrid` carries `.storyboard-grid`, which is `display: grid`.
 * - The three narrative and video elements are plain `<div>`s with no `display`
 *   in any rule that matches them: `.form-error` sets none,
 *   `.storyboard-narrative-text-wrap` sets none, and `#storyboardVideoSection`
 *   has no class at all.
 *
 * Naming the value here duplicates what the stylesheet says for the grid, which
 * is the trade lesson 59 asks for: a toggle that has to know what the
 * stylesheet says in order to be correct breaks the next time it changes.
 *
 * The receiver is named because the empty-state sibling in most of these
 * functions is revealed with `flex` in the other branch, and it was always
 * explicit — it is not what this ticket is about, and a check that just read
 * "every non-none value in the function" could not tell the two apart.
 */
const REVEALS = [
  ['renderSkeleton', 'table', 'table'],
  ['renderProjects', 'table', 'table'],
  ['loadUsers', 'table', 'table'],
  ['renderUsers', 'table', 'table'],
  ['loadActivity', 'table', 'table'],
  ['renderActivity', 'table', 'table'],
  ['loadReports', 'table', 'table'],
  ['renderStoryboardDraft', 'grid', 'grid'],
  ['renderStoryboardNarrative', 'errorEl', 'block'],
  ['renderStoryboardNarrative', 'textWrap', 'block'],
  ['finalizeStoryboardDraft', "getElementById('storyboardVideoSection')", 'block'],
  ['revealVideoSectionIfAlreadyFinalized', "getElementById('storyboardVideoSection')", 'block'],
];

for (const [name, receiver, expected] of REVEALS) {
  test(`${name} reveals ${receiver} with display: ${expected}`, () => {
    const body = functionBody(APP, name);
    const pattern = new RegExp(
      escapeRegExp(receiver) + String.raw`\.style\.display\s*=\s*'([^']*)'`,
      'g'
    );
    const values = [...body.matchAll(pattern)]
      .map((m) => m[1])
      .filter((value) => value !== 'none');

    assert.notStrictEqual(values.length, 0, `${name} no longer reveals ${receiver}`);
    for (const value of values) {
      assert.strictEqual(value, expected, `${name} revealed ${receiver} with '${value}'`);
    }
  });
}
