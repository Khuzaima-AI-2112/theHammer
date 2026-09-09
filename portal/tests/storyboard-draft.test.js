'use strict';

// The Storyboard curation screen's wiring (#85).
//
// Source-level, like capture-export.test.js and token-freshness.test.js: the
// portal ships as plain scripts with no module system and no DOM harness, so
// what can be checked here is structural — which helper a request goes
// through, and whether the right endpoint is called.
//
// buildStoryboard and saveStoryboardDraft must go through apiFetch, not a
// raw fetch() call: apiFetch is what reads the auth token fresh per request
// (see token-freshness.test.js) rather than reusing one captured at sign-in
// (#39). A hand-rolled fetch here would quietly reintroduce that bug for
// this one screen.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/** The source of a top-level function, up to its closing brace. */
function functionBody(source, name) {
  const start = source.search(new RegExp('(async )?function ' + name + '\\('));
  assert.notStrictEqual(start, -1, name + ' not found in app.js');
  const end = source.indexOf('\n}', start);
  assert.notStrictEqual(end, -1, 'could not find the end of ' + name);
  return source.slice(start, end);
}

test('buildStoryboard calls apiFetch, not a raw fetch', () => {
  const body = functionBody(APP_JS, 'buildStoryboard');

  assert.match(body, /apiFetch\(/, 'buildStoryboard must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'buildStoryboard must not call fetch() directly');
});

test('buildStoryboard posts to the Project-scoped storyboards route', () => {
  const body = functionBody(APP_JS, 'buildStoryboard');

  assert.match(body, /\/admin\/projects\/\$\{encodeURIComponent\(projectId\)\}\/storyboards/,
    'the project id belongs in the path, encoded');
  assert.match(body, /method:\s*'POST'/, 'opening a draft is a POST — find-or-create, not a read');
});

test('saveStoryboardDraft calls apiFetch, not a raw fetch', () => {
  const body = functionBody(APP_JS, 'saveStoryboardDraft');

  assert.match(body, /apiFetch\(/, 'saveStoryboardDraft must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'saveStoryboardDraft must not call fetch() directly');
});

test('saveStoryboardDraft patches the draft by id', () => {
  const body = functionBody(APP_JS, 'saveStoryboardDraft');

  assert.match(body, /\/admin\/storyboards\/\$\{encodeURIComponent\(storyboardDraft\.id\)\}/,
    'the draft id belongs in the path, encoded');
  assert.match(body, /method:\s*'PATCH'/, 'saving edits an existing draft — PATCH, not POST');
});

test('saveStoryboardDraft sends every known Capture, not just the ones that changed', () => {
  const body = functionBody(APP_JS, 'saveStoryboardDraft');

  assert.match(body, /storyboardDraft\.captures\.map/,
    'the backend requires the full capture set on every PATCH (#85) — a partial send would be rejected');
});

test('renderStoryboardDraft escapes untrusted text before it reaches innerHTML', () => {
  const body = functionBody(APP_JS, 'renderStoryboardDraft');

  assert.match(body, /esc\(c\.captureId\)/, 'a captureId must be escaped before going into an inline handler');
  assert.match(body, /esc\(c\.note\)/, 'a note is operator-typed text and must be escaped before rendering');
});

test('the Activity view has a Build Storyboard action wired to buildStoryboard()', () => {
  assert.match(INDEX_HTML, /onclick="buildStoryboard\(\)"/,
    'the Activity toolbar must offer a way into the curation screen');
});

test('the Storyboard view exists as its own section, not a modal', () => {
  assert.match(INDEX_HTML, /id="view-storyboard"/,
    'a curation screen with thumbnails, checkboxes, reorder and notes needs a full view, not a modal');
});

// AI narrative generation (#86)

test('generateStoryboardNarrative calls apiFetch, not a raw fetch', () => {
  const body = functionBody(APP_JS, 'generateStoryboardNarrative');

  assert.match(body, /apiFetch\(/, 'generateStoryboardNarrative must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'generateStoryboardNarrative must not call fetch() directly');
});

test('generateStoryboardNarrative posts the typed prompt to the draft-scoped narrative route', () => {
  const body = functionBody(APP_JS, 'generateStoryboardNarrative');

  assert.match(body, /\/admin\/storyboards\/\$\{encodeURIComponent\(storyboardDraft\.id\)\}\/narrative/,
    'the draft id belongs in the path, encoded');
  assert.match(body, /method:\s*'POST'/, 'triggering generation is a POST');
  assert.match(body, /body:\s*JSON\.stringify\(\{\s*prompt\s*\}\)/, 'the typed prompt must be sent in the body');
});

test('startStoryboardNarrativePolling polls through apiFetch, not a raw fetch', () => {
  const body = functionBody(APP_JS, 'startStoryboardNarrativePolling');

  assert.match(body, /apiFetch\(/, 'polling must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'polling must not call fetch() directly');
  assert.match(body, /clearInterval/, 'polling must stop once the draft settles to done/error');
});

test('renderStoryboardNarrative writes generated text via a textarea value, not innerHTML', () => {
  const body = functionBody(APP_JS, 'renderStoryboardNarrative');

  assert.match(body, /textEl\.value\s*=\s*storyboardDraft\.narrativeText/,
    'AI-generated text is untrusted and must never be assigned through innerHTML');
  assert.doesNotMatch(body, /innerHTML/, 'renderStoryboardNarrative must not use innerHTML');
});

test('the Storyboard view has a prompt input and a generate action wired to generateStoryboardNarrative()', () => {
  assert.match(INDEX_HTML, /id="storyboardNarrativePrompt"/, 'an Analyst must be able to type a prompt');
  assert.match(INDEX_HTML, /onclick="generateStoryboardNarrative\(\)"/,
    'the narrative section must offer a way to trigger generation');
});

// Narrative review and edit (#87)

test('generateStoryboardNarrative confirms before regenerating over an existing narrative', () => {
  const body = functionBody(APP_JS, 'generateStoryboardNarrative');

  assert.match(body, /storyboardDraft\.narrativeText/,
    'generation must check for an existing narrative before regenerating');
  assert.match(body, /confirm\(/,
    'regenerating replaces the current narrative (including unsaved edits) and must be confirmed, not silent');
});

test('saveStoryboardNarrativeEdit calls apiFetch, not a raw fetch', () => {
  const body = functionBody(APP_JS, 'saveStoryboardNarrativeEdit');

  assert.match(body, /apiFetch\(/, 'saveStoryboardNarrativeEdit must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'saveStoryboardNarrativeEdit must not call fetch() directly');
});

test('saveStoryboardNarrativeEdit PATCHes the edited text to the draft-scoped narrative route', () => {
  const body = functionBody(APP_JS, 'saveStoryboardNarrativeEdit');

  assert.match(body, /\/admin\/storyboards\/\$\{encodeURIComponent\(storyboardDraft\.id\)\}\/narrative/,
    'the draft id belongs in the path, encoded');
  assert.match(body, /method:\s*'PATCH'/, 'editing an existing narrative is a PATCH, not a POST');
  assert.match(body, /narrativeText:\s*textEl\.value/, 'the edited text must be sent in the body');
});

test('the Storyboard view has an editable narrative textarea and a save-edit action', () => {
  assert.match(INDEX_HTML, /id="storyboardNarrativeText"[^>]*>[\s\S]{0,20}<\/textarea>/,
    'the generated narrative must be shown in an editable <textarea>, not read-only text');
  assert.match(INDEX_HTML, /onclick="saveStoryboardNarrativeEdit\(\)"/,
    'the narrative section must offer a way to save a hand edit');
});

// Recorded audio as an alternate prompt input (#88)

test('apiFetch does not force a JSON Content-Type onto a FormData body', () => {
  const body = functionBody(APP_JS, 'apiFetch');

  assert.match(body, /instanceof FormData/,
    'an audio recording is sent as FormData — apiFetch must not overwrite its multipart Content-Type');
});

test('uploadStoryboardAudio calls apiFetch, not a raw fetch', () => {
  const body = functionBody(APP_JS, 'uploadStoryboardAudio');

  assert.match(body, /apiFetch\(/, 'uploadStoryboardAudio must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'uploadStoryboardAudio must not call fetch() directly');
});

test('uploadStoryboardAudio posts the recording as FormData to the draft-scoped audio route', () => {
  const body = functionBody(APP_JS, 'uploadStoryboardAudio');

  assert.match(body, /\/admin\/storyboards\/\$\{encodeURIComponent\(storyboardDraft\.id\)\}\/narrative\/audio/,
    'the draft id belongs in the path, encoded');
  assert.match(body, /method:\s*'POST'/, 'uploading a recording for transcription is a POST');
  assert.match(body, /new FormData\(\)/, 'a recorded clip is a file upload, not a JSON body');
});

test('uploadStoryboardAudio starts polling after the upload response, the same path generation uses', () => {
  const body = functionBody(APP_JS, 'uploadStoryboardAudio');

  assert.match(body, /startStoryboardNarrativePolling\(/,
    'transcription queues generation server-side — the portal must poll for it, same as a typed prompt');
});

test('toggleStoryboardAudioRecording confirms before recording over an existing narrative', () => {
  const body = functionBody(APP_JS, 'toggleStoryboardAudioRecording');

  assert.match(body, /storyboardDraft\.narrativeText/,
    'recording a new walkthrough must check for an existing narrative before replacing it');
  assert.match(body, /confirm\(/,
    'a new recording replaces the current narrative and must be confirmed, not silent');
});

test('the Storyboard view has a record-audio action wired to toggleStoryboardAudioRecording()', () => {
  assert.match(INDEX_HTML, /id="storyboardRecordBtn"/, 'an Analyst must be able to start/stop a recording');
  assert.match(INDEX_HTML, /onclick="toggleStoryboardAudioRecording\(\)"/,
    'the narrative section must offer a way to record instead of typing');
});

// Finalize a Storyboard draft into a PDF (#89)

test('finalizeStoryboardDraft calls apiFetch, not a raw fetch', () => {
  const body = functionBody(APP_JS, 'finalizeStoryboardDraft');

  assert.match(body, /apiFetch\(/, 'finalizeStoryboardDraft must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'finalizeStoryboardDraft must not call fetch() directly');
});

test('finalizeStoryboardDraft posts to the draft-scoped finalize route', () => {
  const body = functionBody(APP_JS, 'finalizeStoryboardDraft');

  assert.match(body, /\/admin\/storyboards\/\$\{encodeURIComponent\(storyboardDraft\.id\)\}\/finalize/,
    'the draft id belongs in the path, encoded');
  assert.match(body, /method:\s*'POST'/, 'finalizing is a one-shot action, not an idempotent GET');
});

test('the Storyboard view has a finalize action wired to finalizeStoryboardDraft(), inside the completed-narrative section', () => {
  assert.match(INDEX_HTML, /id="storyboardFinalizeBtn"/, 'an Analyst must be able to finalize the draft');
  assert.match(INDEX_HTML, /onclick="finalizeStoryboardDraft\(\)"/,
    'the narrative section must offer a way to finalize into a PDF');

  // The button must live inside storyboardNarrativeTextWrap, the section
  // renderStoryboardNarrative only shows once narrativeStatus is 'done' —
  // finalizing before generation has completed isn't offered, not just
  // refused server-side.
  const wrapStart = INDEX_HTML.indexOf('id="storyboardNarrativeTextWrap"');
  const wrapEnd = INDEX_HTML.indexOf('</div>', INDEX_HTML.indexOf('</div>', wrapStart) + 1);
  const finalizeBtnIdx = INDEX_HTML.indexOf('id="storyboardFinalizeBtn"');
  assert.ok(wrapStart !== -1 && finalizeBtnIdx > wrapStart && finalizeBtnIdx < wrapEnd,
    'the finalize button must be inside the completed-narrative wrap, not always visible');
});

// Generate a narrated video from a finalized Storyboard (#90)

test('finalizeStoryboardDraft reveals the video section only after a successful finalize', () => {
  const body = functionBody(APP_JS, 'finalizeStoryboardDraft');

  // The value was `''` until #50; it is now the explicit `block` lesson 59
  // asks for. What matters here is only that the reveal happens on the success
  // path — display-reveal-contract.test.js is what pins the value.
  assert.match(body, /storyboardVideoSection['"]\)\.style\.display\s*=\s*'(?!none')[^']+'/,
    'generating a video requires a finalized PDF to already exist — the action must not be offered before one does');
});

test('revealVideoSectionIfAlreadyFinalized calls apiFetch, not a raw fetch', () => {
  const body = functionBody(APP_JS, 'revealVideoSectionIfAlreadyFinalized');

  assert.match(body, /apiFetch\(/, 'revealVideoSectionIfAlreadyFinalized must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'revealVideoSectionIfAlreadyFinalized must not call fetch() directly');
});

test('revealVideoSectionIfAlreadyFinalized checks for a done "storyboard" report tied to this draft', () => {
  const body = functionBody(APP_JS, 'revealVideoSectionIfAlreadyFinalized');

  assert.match(body, /r\.storyboardDraftId\s*===\s*draftId/, 'must match the report to this specific draft');
  assert.match(body, /r\.reportType\s*===\s*'storyboard'/, 'must be the finalized PDF, not e.g. a storyboard-video report');
  assert.match(body, /r\.status\s*===\s*'done'/, 'a queued/processing/error PDF report does not count as finalized');
});

test('buildStoryboard checks whether a reopened draft was already finalized, so the video action isn\'t only reachable within the finalizing session', () => {
  const body = functionBody(APP_JS, 'buildStoryboard');

  assert.match(body, /revealVideoSectionIfAlreadyFinalized\(/,
    'reopening an already-finalized draft must still offer "Generate video", not just a draft finalized this session');
});

test('generateStoryboardVideo calls apiFetch, not a raw fetch', () => {
  const body = functionBody(APP_JS, 'generateStoryboardVideo');

  assert.match(body, /apiFetch\(/, 'generateStoryboardVideo must go through apiFetch to get a fresh token');
  assert.doesNotMatch(body, /\bfetch\(/, 'generateStoryboardVideo must not call fetch() directly');
});

test('generateStoryboardVideo posts to the draft-scoped video route', () => {
  const body = functionBody(APP_JS, 'generateStoryboardVideo');

  assert.match(body, /\/admin\/storyboards\/\$\{encodeURIComponent\(storyboardDraft\.id\)\}\/video/,
    'the draft id belongs in the path, encoded');
  assert.match(body, /method:\s*'POST'/, 'starting a Shotstack render is a one-shot action, not an idempotent GET');
});

test('the Storyboard view has a generate-video action wired to generateStoryboardVideo(), hidden until finalizing', () => {
  assert.match(INDEX_HTML, /id="storyboardVideoBtn"/, 'an Analyst must be able to trigger video generation');
  assert.match(INDEX_HTML, /onclick="generateStoryboardVideo\(\)"/,
    'the narrative section must offer a way to generate a video');

  const sectionMatch = INDEX_HTML.match(/<div id="storyboardVideoSection"[^>]*style="display:none"/);
  assert.ok(sectionMatch,
    'video generation must not be offered until a finalized PDF exists — the section starts hidden, not the button disabled');
});
