'use strict';

// The Project id the portal reads — issue #45.
//
// The backend serialises a Project with `id` (the repo-wide convention: every
// serialiser in backend/src/routes/admin/ exposes a document's own identity as
// `id`). The portal read `p.projectId` in sixteen places, so that property was
// undefined on every Project it had ever loaded.
//
// It did not fail loudly. `opt.value = undefined` is coerced by the DOM, so
// `select.value` reads back as the *string* "undefined", which is truthy and
// walks straight past `if (!projectId) return;`. The Activity tab then requested
// /admin/projects/undefined/activity and got a correct 404.
//
// Six sites had been patched with `p.id || p.projectId`. Those worked; the other
// ten did not. #45 settles the shape once at the decode boundary instead, in the
// same style as unwrapList (#41), and removes the fallbacks — a seventh one
// would only hide the next occurrence of this.
//
// There is no DOM harness for the portal, so normaliseProject is lifted out of
// the source and exercised directly; the call sites are checked statically, the
// way list-envelopes.test.js checks unwrapList's.
//
// Run with: npm run test:portal

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const { lift } = require('./lift');

const normaliseProject = lift(APP_JS, 'normaliseProject');

// ── The shape ────────────────────────────────────────────────────

test('the backend id becomes the projectId the portal reads', () => {
  const decoded = normaliseProject({ id: 'qB3Km18va9H9QEsjuW1M', name: 'Test' });

  assert.strictEqual(decoded.projectId, 'qB3Km18va9H9QEsjuW1M');
});

test('the decoded Project has exactly one id field, and it is populated', () => {
  // The third `Done when`: a rename on either side must fail a test rather than
  // render "undefined". Two id fields would let one of them rot unnoticed.
  const decoded = normaliseProject({ id: 'abc123', name: 'Test' });

  const idFields = Object.keys(decoded).filter(k => /^(id|projectId)$/.test(k));

  assert.deepStrictEqual(idFields, ['projectId'],
    'expected only projectId; got ' + JSON.stringify(idFields));
  assert.ok(decoded.projectId, 'the one id field must be populated');
});

test('every other field survives the normalisation', () => {
  const decoded = normaliseProject({
    id: 'abc123',
    name: 'Test',
    adminId: 'u1',
    memberCount: 3,
    webhookUrl: 'https://example.test/hook',
    llmModel: 'gemini-3.5-flash',
    createdAt: '2026-08-28T07:34:00.000Z',
    schemaVersion: 1,
  });

  assert.strictEqual(decoded.name, 'Test');
  assert.strictEqual(decoded.adminId, 'u1');
  assert.strictEqual(decoded.memberCount, 3);
  assert.strictEqual(decoded.webhookUrl, 'https://example.test/hook');
  assert.strictEqual(decoded.llmModel, 'gemini-3.5-flash');
  assert.strictEqual(decoded.createdAt, '2026-08-28T07:34:00.000Z');
  assert.strictEqual(decoded.schemaVersion, 1);
});

test('a record carrying only projectId is refused, because id is the contract', () => {
  // Deliberately strict. Accepting either name at the boundary is the same
  // tolerance that let #45 live undetected: /admin/projects serialises `id`, so
  // a record without one is a backend change the portal must not absorb quietly,
  // and the extension's own p?.projectId ?? p?.id is the shape of that mistake.
  assert.throws(() => normaliseProject({ projectId: 'abc123', name: 'Test' }), /id/);
});

// ── Refusing the shape that caused the bug ───────────────────────

test('a Project with no usable id is refused rather than rendered as "undefined"', () => {
  // This is the whole ticket. Silently producing undefined here is what sent
  // /admin/projects/undefined/activity to the backend.
  for (const junk of [{ name: 'Test' }, { id: '', name: 'Test' }, { id: null }, {}]) {
    assert.throws(
      () => normaliseProject(junk),
      (e) => /id/.test(e.message),
      'should have refused: ' + JSON.stringify(junk)
    );
  }
});

test('a missing id is marked as a decode failure, not blamed on the network', () => {
  try {
    normaliseProject({ name: 'Test' });
    assert.fail('a Project with no id should have thrown');
  } catch (err) {
    assert.strictEqual(err.isDecodeFailure, true,
      'without this flag the reader is told to check API connectivity on a 200');
  }
});

test('a non-string id is refused, since the DOM would coerce it', () => {
  // The defect was coercion. A number or an object id would round-trip through
  // option.value as a string and reintroduce exactly this class of bug.
  for (const junk of [{ id: 42 }, { id: {} }, { id: [] }, { id: true }]) {
    assert.throws(() => normaliseProject(junk), /id/,
      'should have refused: ' + JSON.stringify(junk));
  }
});

// ── The call sites ───────────────────────────────────────────────
// The helper is only worth having if every Project entering allProjects goes
// through it. There are two doors, not one: the list load and the create POST.

test('the /admin/projects list is normalised as it is decoded', () => {
  const assignment = APP_JS.split('\n').find(
    (l) => l.includes('allProjects') && l.includes('apiFetch')
  );

  assert.ok(assignment, 'no apiFetch assignment found for allProjects');
  assert.match(assignment, /normaliseProject/,
    'allProjects takes the raw response shape: ' + assignment.trim());
});

test('a newly created Project is normalised before it joins allProjects', () => {
  // submitCreate unshifted the raw POST response. The ticket does not list this
  // site, but it is the same bug: the new row rendered undefined until refresh.
  const unshift = APP_JS.split('\n').find((l) => l.includes('allProjects.unshift'));

  assert.ok(unshift, 'no allProjects.unshift found');
  assert.match(unshift, /normaliseProject/,
    'the created Project skips normalisation: ' + unshift.trim());
});

// ── The fallbacks are gone ───────────────────────────────────────

test('no p.id || p.projectId style fallback remains in app.js', () => {
  // The fourth `Done when`. Six of these existed; leaving any would hide the
  // next occurrence of this exact bug.
  const code = APP_JS.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  assert.doesNotMatch(code, /\.id\s*\|\|\s*\w+\.projectId/,
    'a p.id || p.projectId fallback survives');
  assert.doesNotMatch(code, /\.projectId\s*\|\|\s*\w+\.id/,
    'a p.projectId || p.id fallback survives');
  assert.doesNotMatch(code, /\.id\s*===\s*\w+\s*\|\|\s*\w+\.projectId\s*===/,
    'a dual-field identity comparison survives');
});

test('no Project record is read through a bare .id any more', () => {
  // allProjects entries are the normalised shape; reading .id off one is now a
  // bug that would silently return undefined again.
  const code = APP_JS.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));

  // Scoped to Project reads on purpose. An earlier draft banned `.id` on any
  // variable named x anywhere in the file, which is not this test's business.
  const offenders = code.filter(l =>
    /allProjects\b[^\n]*\bp\.id\b/.test(l) ||
    /allProjects\.find\([^)]*\bx\.id\b/.test(l));

  assert.deepStrictEqual(offenders, [],
    'these read .id off a normalised Project: ' + offenders.join(' | '));
});
