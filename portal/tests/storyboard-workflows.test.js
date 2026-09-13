'use strict';

// Workflow dividers in the Storyboard builder (#126, ADR 0020).
//
// The builder shows the ordered frame list with the curator's dividers placed
// in it. What the builder shows must be what the PDF prints, so the numbering
// and "empty" rules here mirror backend/src/lib/workflows.js: a Workflow is
// numbered among the ones that have an included frame, and one with none is
// shown as empty rather than given a number.
//
// The list and the divider edits are pure helpers, lifted and called directly;
// the wiring is checked statically, like storyboard-draft.test.js.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { lift, functionBody } = require('./lift');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const storyboardListItems = lift(APP_JS, 'storyboardListItems');
const moveWorkflowDivider = lift(APP_JS, 'moveWorkflowDivider');
const insertWorkflowDivider = lift(APP_JS, 'insertWorkflowDivider');

const frame = (captureId, order, included = true) => ({ captureId, order, included });
const shape = (items) => items.map((it) => (it.kind === 'frame'
  ? it.capture.captureId
  : `[${it.number ?? 'empty'}:${it.workflow.name}]`));

test('a draft with no dividers lists its frames in order, and nothing else', () => {
  const items = storyboardListItems([frame('b', 2), frame('a', 1)], []);
  assert.deepStrictEqual(shape(items), ['a', 'b']);
});

test('a divider sits above the frame at its position, and a trailing one sits last', () => {
  const items = storyboardListItems([frame('a', 1), frame('b', 2)], [
    { id: 'w1', name: 'One', position: 1 },
    { id: 'w2', name: 'End', position: 2 },
  ]);
  assert.deepStrictEqual(shape(items), ['a', '[1:One]', 'b', '[empty:End]']);
});

test('a Workflow whose frames are all unticked is empty, and the next one takes its number', () => {
  const items = storyboardListItems([frame('a', 1, false), frame('b', 2)], [
    { id: 'w1', name: 'Unticked', position: 0 },
    { id: 'w2', name: 'Back to back', position: 1 },
    { id: 'w3', name: 'Brand', position: 1 },
  ]);
  assert.deepStrictEqual(shape(items), ['[empty:Unticked]', 'a', '[empty:Back to back]', '[1:Brand]', 'b']);
});

test('each item carries the divider\'s index in the workflows array, for the edit handlers', () => {
  const items = storyboardListItems([frame('a', 1)], [{ id: 'w1', name: 'One', position: 0 }]);
  assert.strictEqual(items[0].index, 0);
});

test('moving a divider down steps past one frame, and up steps back', () => {
  const start = [{ id: 'w1', name: 'One', position: 1 }];
  const down = moveWorkflowDivider(start, 0, 1, 3);
  assert.deepStrictEqual(down, [{ id: 'w1', name: 'One', position: 2 }]);
  assert.deepStrictEqual(moveWorkflowDivider(down, 0, -1, 3), start);
});

test('a divider cannot move above the top or below the last frame', () => {
  const top = [{ id: 'w1', name: 'One', position: 0 }];
  assert.deepStrictEqual(moveWorkflowDivider(top, 0, -1, 3), top);
  const bottom = [{ id: 'w1', name: 'One', position: 3 }];
  assert.deepStrictEqual(moveWorkflowDivider(bottom, 0, 1, 3), bottom);
});

test('moving past a divider in the same spot swaps the two, rather than jumping a frame', () => {
  const start = [
    { id: 'w1', name: 'One', position: 1 },
    { id: 'w2', name: 'Two', position: 1 },
  ];
  assert.deepStrictEqual(
    moveWorkflowDivider(start, 0, 1, 3).map((w) => [w.id, w.position]),
    [['w2', 1], ['w1', 1]],
  );
  assert.deepStrictEqual(
    moveWorkflowDivider(start, 1, -1, 3).map((w) => [w.id, w.position]),
    [['w2', 1], ['w1', 1]],
  );
});

test('the edits never mutate the list they were given', () => {
  const start = [{ id: 'w1', name: 'One', position: 1 }];
  const snapshot = JSON.stringify(start);
  moveWorkflowDivider(start, 0, 1, 3);
  insertWorkflowDivider(start, { id: 'w2', name: 'Two', position: 0 });
  assert.strictEqual(JSON.stringify(start), snapshot);
});

test('a new divider goes after any already sitting at the same spot, keeping list order', () => {
  const start = [
    { id: 'w1', name: 'One', position: 0 },
    { id: 'w2', name: 'Two', position: 2 },
  ];
  const added = insertWorkflowDivider(start, { id: 'w3', name: 'New', position: 2 });
  assert.deepStrictEqual(added.map((w) => w.id), ['w1', 'w2', 'w3']);
  const between = insertWorkflowDivider(start, { id: 'w4', name: 'Mid', position: 1 });
  assert.deepStrictEqual(between.map((w) => w.id), ['w1', 'w4', 'w2']);
});

// Wiring

test('saveStoryboardDraft sends the dividers with the frames, so they survive leaving the page', () => {
  const body = functionBody(APP_JS, 'saveStoryboardDraft');
  assert.match(body, /workflows/, 'the PATCH must carry the Workflow dividers (#126)');
});

test('renderStoryboardDraft lays out the list through storyboardListItems', () => {
  const body = functionBody(APP_JS, 'renderStoryboardDraft');
  assert.match(body, /storyboardListItems\(/,
    'the builder must place dividers with the same helper the numbering is tested through');
});

test('a Workflow name is escaped before it reaches innerHTML', () => {
  const body = functionBody(APP_JS, 'renderStoryboardDraft');
  assert.match(body, /esc\(it\.workflow\.name\)/, 'a Workflow name is curator-typed text');
});

test('the builder can add, rename, move and delete a divider', () => {
  for (const name of ['addStoryboardWorkflow', 'renameStoryboardWorkflow', 'moveStoryboardWorkflow', 'deleteStoryboardWorkflow']) {
    functionBody(APP_JS, name);
    assert.match(APP_JS, new RegExp(`on(click|change)="${name}\\(`), `${name} must be wired into the list`);
  }
});
