'use strict';

// Lift a top-level function out of a source file and make it callable in a test.
//
// The portal ships as plain scripts loaded by index.html — no module system, no
// exports, and no DOM harness in the tests — so the only way to exercise one of
// its helpers directly is to slice it out of the text and evaluate it. The call
// sites are then checked statically, in the same file.
//
// Shared rather than copied: #45 added a second test file that needed this, and
// two byte-identical copies is the point at which they start to drift.
//
// Assumes the function's closing brace is the first `}` at column 0 after its
// declaration, which holds for every top-level function in portal/app.js.

const assert = require('node:assert');

function lift(source, name) {
  return new Function('return (' + functionBody(source, name) + ')')();
}

/**
 * The *text* of a top-level function, for the contract tests that read a
 * function rather than call one — what keys it reads, what path it fetches.
 *
 * Shared for the reason `lift` is: this was written a third time in #116's
 * confirmation contract test, having already been copied into
 * activity-row-contract.test.js. Same brace assumption as `lift`.
 */
function functionBody(source, name) {
  const start = source.search(new RegExp('(async )?function ' + name + '\\('));
  assert.notStrictEqual(start, -1, name + ' not found in source');
  const end = source.indexOf('\n}', start);
  assert.notStrictEqual(end, -1, 'could not find the end of ' + name);
  return source.slice(start, end + 2);
}

/**
 * A file's source with its comments removed, for the guards that scan text for
 * a forbidden pattern.
 *
 * Lesson 83: "scan the file" and "scan the code" look like the same task and
 * are not. Four guards in one session flagged the comment explaining the very
 * defect they exist to prevent, and the tempting fix — rewording the comment —
 * trades a true sentence for a passing test. Narrowing the pattern is a guess
 * about quoting; the distinction actually wanted is about where in the file the
 * match sits.
 *
 * Whole-line `//` only: a trailing comment after real code is left alone, since
 * the code before it is exactly what a guard wants to see.
 *
 * Shared rather than copied for the reason `lift` is — this is its second
 * caller, which is where two byte-identical copies start to drift.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')   // CSS and JS block comments
    .replace(/<!--[\s\S]*?-->/g, '')    // HTML comments
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

module.exports = { lift, functionBody, stripComments };
