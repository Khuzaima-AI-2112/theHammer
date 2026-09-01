'use strict';

// #73 — the Tool a Capture uses must be the Tool on screen.
//
// The popup's form and the stored Session were two different things. The form
// was read only when Save was clicked, and every Capture — from the popup, the
// context menu or the keyboard shortcut — reads the stored Session. So a Tool
// typed and not Saved was silently dropped: the box still showed the text, the
// Capture still succeeded, and it was recorded with `tool: ""`.
//
// That is what produced the blank TOOL column on 2026-08-31, and it cost a full
// diagnosis: three layers were tested and cleared before the stored value
// turned out to have been empty all along.
//
// Two things kept it invisible. A Chrome popup discards unsaved typing the
// moment it loses focus — opening DevTools does exactly that. And the restore
// only ran for a *truthy* tool, so once "" was stored the box rendered empty on
// every reopen and the typed text appeared to have simply vanished.
//
// Ahmed's decision, 2026-09-01: the form auto-saves. Storage stays the single
// source of truth that every trigger reads; it just can no longer disagree with
// what is on the screen. Save remains, as an explicit confirmation.
//
// Run with: npm run test:extension

const test = require('node:test');
const assert = require('node:assert');
const { loadPopup } = require('./popup-harness.js');

const SIGNED_IN = {
  settings: { cloudRunUrl: 'https://api.test/api', firebaseToken: 'test-token' },
  session:  { projectId: 'proj-a', stage: 'beginning', tool: 'Softomedia' }
};

/** A popup opened on a signed-in profile, with its listeners registered. */
async function openPopup(local = SIGNED_IN) {
  const popup = loadPopup({
    local,
    fetch: async (url) => {
      if (url.endsWith('/me/projects')) {
        return { ok: true, status: 200, json: async () => ({ projects: [
          { projectId: 'proj-a', name: 'Persona — Media Buyer' },
          { projectId: 'proj-b', name: 'Persona — Retailer' }
        ] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });
  await popup.fireDOMContentLoaded();
  await popup.settle();
  return popup;
}

const storedSession = (popup) => popup.local._peek().session;

test('a Tool typed and never Saved still reaches storage', async () => {
  const popup = await openPopup();

  popup.el('tool-input').value = '02-BrandCaptures';
  await popup.fire('tool-input', 'input');
  await popup.settle();

  assert.strictEqual(storedSession(popup).tool, '02-BrandCaptures',
    'this is the bug: the box said 02-BrandCaptures and the Capture used ""');
});

test('the Stage follows the form too', async () => {
  const popup = await openPopup();

  popup.el('stage-select').value = 'during';
  await popup.fire('stage-select', 'change');
  await popup.settle();

  assert.strictEqual(storedSession(popup).stage, 'during');
});

test('the Project follows the form too', async () => {
  const popup = await openPopup();

  popup.el('project-select').value = 'proj-b';
  await popup.fire('project-select', 'change');
  await popup.settle();

  assert.strictEqual(storedSession(popup).projectId, 'proj-b');
});

test('the Tool is trimmed, as Save has always trimmed it', async () => {
  const popup = await openPopup();

  // Deliberately not the seeded value, so this cannot pass by doing nothing.
  popup.el('tool-input').value = '  05-TechOpWorkflowCaptures  ';
  await popup.fire('tool-input', 'input');
  await popup.settle();

  assert.strictEqual(storedSession(popup).tool, '05-TechOpWorkflowCaptures');
});

test('clearing the Tool box clears it in storage', async () => {
  // The stored Session must be able to disagree with nothing at all. If an
  // emptied box left the old value behind, a Capture would carry a Tool the
  // operator had deliberately removed.
  const popup = await openPopup();

  popup.el('tool-input').value = '';
  await popup.fire('tool-input', 'input');
  await popup.settle();

  assert.strictEqual(storedSession(popup).tool, '');
});

test('an empty stored Tool is restored as an empty box, not skipped', async () => {
  // popup.js:95 restored only a truthy tool, so an empty stored value left
  // whatever was already in the box. A fresh popup starts empty, which is why
  // this never showed — so the box is dirtied first, to make the skip visible.
  const popup = loadPopup({
    local: { ...SIGNED_IN, session: { projectId: 'proj-a', stage: 'beginning', tool: '' } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ projects: [] }) })
  });
  popup.el('tool-input').value = 'left over from somewhere else';

  await popup.fireDOMContentLoaded();
  await popup.settle();

  assert.strictEqual(popup.el('tool-input').value, '',
    'the box must show what is stored, including nothing');
});

test('a stored Tool is still shown when the popup reopens', async () => {
  const popup = await openPopup();
  assert.strictEqual(popup.el('tool-input').value, 'Softomedia');
});

test('Save still works, and still says so', async () => {
  // Auto-save makes Save redundant, not unwelcome: it is the affordance that
  // tells someone their setting was kept.
  const popup = await openPopup();

  popup.el('tool-input').value = '03b-ThebrandWizardCaptures';
  popup.el('save-btn').click();
  await popup.settle();

  assert.strictEqual(storedSession(popup).tool, '03b-ThebrandWizardCaptures');
  assert.match(String(popup.el('status').textContent ?? ''), /saved/i);
});

test('editing the Tool does not wipe a Project the dropdown cannot show', async () => {
  // The select can hold no value even after loading — the stored Project may
  // have been deleted, or belong to a Workspace this account no longer sees.
  // A write that trusted the form blindly would then store projectId: '' and
  // the next Capture would be refused with "set Project & save first", trading
  // one silent data loss for another. The stored Project is kept instead, so
  // the operator can see the dropdown is unset and choose deliberately.
  const popup = loadPopup({
    local: SIGNED_IN,   // session.projectId = 'proj-a'
    fetch: async (url) => {
      if (url.endsWith('/me/projects')) {
        // proj-a is gone.
        return { ok: true, status: 200, json: async () => ({ projects: [
          { projectId: 'proj-z', name: 'Some other Project' }
        ] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });
  await popup.fireDOMContentLoaded();
  await popup.settle();

  popup.el('project-select').value = '';
  popup.el('tool-input').value = '02-AdminCaptures';
  await popup.fire('tool-input', 'input');
  await popup.settle();

  const s = storedSession(popup);
  assert.strictEqual(s.tool, '02-AdminCaptures', 'the Tool must be kept');
  assert.strictEqual(s.projectId, 'proj-a',
    'an unset dropdown must not silently delete the stored Project');
});

test('the whole Session is written, never a partial one', async () => {
  // A per-field write would drop the other two, and a Capture reads all three.
  const popup = await openPopup();

  popup.el('tool-input').value = '04-Retailer_workflow_captures';
  await popup.fire('tool-input', 'input');
  await popup.settle();

  const s = storedSession(popup);
  assert.strictEqual(s.projectId, 'proj-a', 'the Project must survive a Tool edit');
  assert.strictEqual(s.stage, 'beginning', 'the Stage must survive a Tool edit');
});
