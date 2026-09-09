'use strict';

// Every CSS custom property the portal names must be one styles.css defines.
//
// Found while closing #120: the new Report viewer styled its narrative with
// `font-family: var(--font-sans)`. styles.css defines `--font-mono` and no
// `--font-sans` at all, so the declaration resolved to nothing and the prose
// inherited the panel's monospace — a summary written for a Customer rendered
// as code. Nothing failed. There is no error for naming a property that was
// never defined; the browser drops the declaration and carries on.
//
// That is the same shape as the model ids in #108 and the `[Mockup]` viewer
// this ticket removed: a value written in one file, read in another, with
// nothing between them to notice when the two stop agreeing.
//
// A `var(--x, fallback)` is still checked. The fallback makes it render, but
// naming a property that does not exist is what the next reader copies.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { stripComments } = require('./lift');

const PORTAL = path.join(__dirname, '..');

/**
 * A file with its comments removed.
 *
 * Scoped deliberately, for the reason backend/tests/model-ids.test.js records:
 * a guard that makes prose illegal gets worked around rather than satisfied.
 * The comment explaining *why* a property was renamed necessarily names the
 * old one, and flagging that would mean either deleting the explanation or
 * rewording it into something less true.
 *
 * The stripping itself moved to lift.js in #50, which needed the same thing.
 */
function read(file) {
  return stripComments(fs.readFileSync(path.join(PORTAL, file), 'utf8'));
}

/** Every `--name:` declaration in the stylesheet. */
function definedProperties() {
  return new Set([...read('styles.css').matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
}

/** Every `var(--name` reference in a file. */
function usedProperties(source) {
  return new Set([...source.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]));
}

for (const file of ['app.js', 'index.html']) {
  test(`${file} names only custom properties styles.css defines`, () => {
    const defined = definedProperties();
    const undefinedOnes = [...usedProperties(read(file))]
      .filter((name) => !defined.has(name))
      .sort();

    assert.deepStrictEqual(
      undefinedOnes, [],
      `${file} styles with custom properties that do not exist: ${undefinedOnes.join(', ')}`
    );
  });
}

test('styles.css defines the properties it references itself', () => {
  const defined = definedProperties();
  const undefinedOnes = [...usedProperties(read('styles.css'))]
    .filter((name) => !defined.has(name))
    .sort();

  assert.deepStrictEqual(undefinedOnes, [], `styles.css: ${undefinedOnes.join(', ')}`);
});
