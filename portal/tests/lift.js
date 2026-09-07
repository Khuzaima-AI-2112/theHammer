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

module.exports = { lift, functionBody };
