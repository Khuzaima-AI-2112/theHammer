'use strict';

// An Analyst corrects a Caption on its builder card (#129).
//
// The decisions are in #129's 2026-09-13 comment. The helpers that decide what
// a card shows are pure, lifted and called directly, like
// storyboard-workflows.test.js; the wiring is checked statically, like
// storyboard-draft.test.js.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { lift, functionBody } = require('./lift');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const captionWordCount = lift(APP_JS, 'captionWordCount');
const editedCaptionCount = lift(APP_JS, 'editedCaptionCount');
const editedCaptionsWarning = lift(APP_JS, 'editedCaptionsWarning');
const captionBoxState = lift(APP_JS, 'captionBoxState');

test('a Caption\'s words are counted however they are spaced', () => {
  assert.strictEqual(captionWordCount('The Screens tile is missing.'), 5);
  assert.strictEqual(captionWordCount('  two\n\n  words  '), 2);
});

test('the Caption budget matches the one the server enforces', () => {
  const { STORYBOARD_CAPTION_MAX_WORDS } = require(path.join(__dirname, '..', '..', 'backend', 'src', 'lib', 'models.js'));
  const portal = APP_JS.match(/^const STORYBOARD_CAPTION_MAX_WORDS = (\d+);$/m);
  assert.ok(portal, 'app.js should declare STORYBOARD_CAPTION_MAX_WORDS');
  assert.strictEqual(Number(portal[1]), STORYBOARD_CAPTION_MAX_WORDS);
});

test('every edited Caption is counted, including one on an excluded slide', () => {
  const draft = {
    captures: [{ captureId: 'a', included: true }, { captureId: 'b', included: false }, { captureId: 'c', included: true }],
    narrativeCaptions: [
      { captureId: 'a', caption: 'Fixed.', edited: true },
      { captureId: 'b', caption: 'Fixed while ticked.', edited: true },
      { captureId: 'c', caption: 'As generated.' },
    ],
  };
  assert.strictEqual(editedCaptionCount(draft), 2);
});

test('a draft with no Captions has none edited', () => {
  assert.strictEqual(editedCaptionCount({ captures: [], narrativeCaptions: null }), 0);
});

test('the warning names how many corrected Captions will be lost, and says nothing when none will', () => {
  assert.strictEqual(editedCaptionsWarning(0), '');
  assert.strictEqual(editedCaptionsWarning(1), ' 1 caption you edited by hand will be replaced.');
  assert.strictEqual(editedCaptionsWarning(3), ' 3 captions you edited by hand will be replaced.');
});

test('an included slide\'s Caption is editable once the narrative is done', () => {
  assert.strictEqual(captionBoxState({ narrativeStatus: 'done' }, { included: true }), 'editable');
});

test('it is read-only while the narrative is queued or generating, since the words are about to be replaced', () => {
  assert.strictEqual(captionBoxState({ narrativeStatus: 'queued' }, { included: true }), 'readonly');
  assert.strictEqual(captionBoxState({ narrativeStatus: 'generating' }, { included: true }), 'readonly');
});

test('it is hidden after a failed run, whose stored Captions are the previous run\'s leftovers', () => {
  assert.strictEqual(captionBoxState({ narrativeStatus: 'error' }, { included: true }), 'hidden');
});

test('it is hidden before any narrative exists', () => {
  assert.strictEqual(captionBoxState({ narrativeStatus: null }, { included: true }), 'hidden');
});

test('it is hidden on an excluded slide, which is neither printed nor narrated', () => {
  assert.strictEqual(captionBoxState({ narrativeStatus: 'done' }, { included: false }), 'hidden');
  assert.strictEqual(captionBoxState({ narrativeStatus: 'generating' }, { included: false }), 'hidden');
});

test('a blank Caption has no words', () => {
  assert.strictEqual(captionWordCount(''), 0);
  assert.strictEqual(captionWordCount('   \n '), 0);
});

// ── Wiring ─────────────────────────────────────────────────────────

test('saveStoryboardCaption PATCHes the one Caption to the draft-scoped captions route through apiFetch', () => {
  const body = functionBody(APP_JS, 'saveStoryboardCaption');

  assert.match(body, /apiFetch\(/, 'must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'must not call fetch() directly');
  assert.match(body, /\/admin\/storyboards\/\$\{encodeURIComponent\(storyboardDraft\.id\)\}\/captions/,
    'the draft id belongs in the path, encoded');
  assert.match(body, /method:\s*'PATCH'/);
  assert.match(body, /JSON\.stringify\(\{\s*captureId,\s*caption\s*\}\)/,
    'the captureId travels in the body: it is already a percent-encoded object path');
});

test('saveStoryboardCaption keeps the page\'s unsaved curation, taking only the Captions from the response', () => {
  const body = functionBody(APP_JS, 'saveStoryboardCaption');

  // A caption saves on leaving its box, while Notes, ticks and slide numbers
  // wait for the Save button. Replacing the whole draft would drop those.
  assert.doesNotMatch(body, /storyboardDraft\s*=\s*await/,
    'the response must not replace the local draft wholesale');
  assert.match(body, /storyboardDraft\.narrativeCaptions\s*=/);
});

test('saveStoryboardCaption refuses a blank or over-budget Caption before asking the server', () => {
  const body = functionBody(APP_JS, 'saveStoryboardCaption');
  const request = body.indexOf('apiFetch(');

  const blank = body.search(/if \(caption === ''\) \{/);
  assert.ok(blank !== -1 && blank < request, 'a blank Caption must be refused before the request');
  const blankBranch = body.slice(blank, body.indexOf('return;', blank));
  assert.match(blankBranch, /textEl\.value = stored\?\.caption \?\? ''/,
    'a blanked box goes back to the stored Caption');
  assert.match(blankBranch, /showToast\(/, 'and says why');

  const overBudget = body.search(/captionWordCount\(caption\) > STORYBOARD_CAPTION_MAX_WORDS/);
  assert.ok(overBudget !== -1 && overBudget < request, 'an over-budget Caption must be refused before the request');
});

test('each builder card shows its Caption box by captionBoxState, escaped and saving on change', () => {
  assert.match(functionBody(APP_JS, 'renderStoryboardDraft'), /\$\{storyboardCaptionBox\(c\)\}/,
    'every frame card must carry its Caption box');

  const body = functionBody(APP_JS, 'storyboardCaptionBox');
  assert.match(body, /captionBoxState\(storyboardDraft,\s*c\)/);
  assert.match(body, /esc\(caption/, 'a Caption is model- or operator-written text and must be escaped');
  assert.match(body, /esc\(c\.captureId\)/, 'a captureId must be escaped before going into an inline handler');
  assert.match(body, /onchange="saveStoryboardCaption\(/);
});

test('both ways of replacing the narrative warn with the count of corrected Captions', () => {
  for (const name of ['generateStoryboardNarrative', 'toggleStoryboardAudioRecording']) {
    assert.match(functionBody(APP_JS, name), /editedCaptionsWarning\(editedCaptionCount\(storyboardDraft\)\)/,
      `${name} must not discard a corrected Caption silently`);
  }
});

test('both ask even when there is no synthesis, if there are corrected Captions to lose', () => {
  // A failed run blanks narrativeText and leaves the Captions, edited ones
  // included, so asking only when there is a synthesis would skip the warning.
  for (const name of ['generateStoryboardNarrative', 'toggleStoryboardAudioRecording']) {
    assert.match(functionBody(APP_JS, name),
      /if \(storyboardDraft\.narrativeText \|\| editedCaptionCount\(storyboardDraft\) > 0\) \{/,
      `${name} must confirm when edited Captions exist without a synthesis`);
  }
});

test('ticking or unticking a slide redraws the builder, so its Caption box appears or goes', () => {
  const body = functionBody(APP_JS, 'toggleStoryboardCapture');
  assert.match(body, /^\s*renderStoryboardDraft\(\);$/m, 'the redraw must not depend on the draft having dividers');
});

test('the builder cards are redrawn when the narrative status changes, so Caption boxes appear, lock and unlock', () => {
  assert.match(functionBody(APP_JS, 'startStoryboardNarrativePolling'), /renderStoryboardDraft\(\)/,
    'a poll that settles to done must bring the Caption boxes in');
  for (const name of ['generateStoryboardNarrative', 'uploadStoryboardAudio']) {
    assert.match(functionBody(APP_JS, name), /renderStoryboardDraft\(\)/,
      `${name} must lock the Caption boxes as generation is queued`);
  }
});
