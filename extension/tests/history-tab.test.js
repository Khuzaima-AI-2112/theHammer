'use strict';

// Issue #48 — the History tab never displayed anything.
//
// switchTab revealed a panel by assigning '' to style.display. That removes the
// inline declaration rather than meaning "visible", so the element falls back to
// the stylesheet, and popup.html carries `#history-panel { display: none }`.
// Clicking History therefore hid the capture controls and showed nothing at all,
// not even refreshHistory's "No uploads yet." empty state.
//
// The stub DOM here has no stylesheet, so '' and 'block' look identical unless
// the assertion names the value. That is the whole point of these tests: they
// pin the explicit value, because the cascade is what bit us.
//
// Run with: npm run test:extension

const test = require('node:test');
const assert = require('node:assert');
const { loadPopup } = require('./popup-harness.js');

const SETTINGS = { settings: { cloudRunUrl: 'https://backend.test', firebaseToken: 'tok' } };

const boot = (local = SETTINGS) => loadPopup({ local });

test('switching to History makes the history panel explicitly visible', () => {
  const popup = boot();

  popup.switchTab('history');

  assert.strictEqual(popup.el('history-panel').style.display, 'block',
    "'' would defer to the stylesheet, which hides this panel");
  assert.strictEqual(popup.el('capture-panel').style.display, 'none');
});

test('switching back to Capture reverses it', () => {
  const popup = boot();

  popup.switchTab('history');
  popup.switchTab('capture');

  assert.strictEqual(popup.el('capture-panel').style.display, 'block');
  assert.strictEqual(popup.el('history-panel').style.display, 'none');
});

test('neither panel is ever left deferring to the stylesheet', () => {
  const popup = boot();

  for (const tab of ['capture', 'history', 'capture', 'history']) {
    popup.switchTab(tab);
    for (const id of ['capture-panel', 'history-panel']) {
      const display = popup.el(id).style.display;
      assert.notStrictEqual(display, '',
        `${id} was left with no inline display after switchTab('${tab}'); ` +
        'the stylesheet then decides, which is how #48 happened');
      assert.ok(display === 'block' || display === 'none',
        `${id} should be explicitly shown or hidden, got ${JSON.stringify(display)}`);
    }
  }
});

test('exactly one panel is visible at a time', () => {
  const popup = boot();

  for (const tab of ['capture', 'history']) {
    popup.switchTab(tab);
    const visible = ['capture-panel', 'history-panel']
      .filter((id) => popup.el(id).style.display !== 'none');
    assert.strictEqual(visible.length, 1, `expected one visible panel on '${tab}', got ${visible.length}`);
  }
});

test('an empty history renders the empty state rather than nothing', async () => {
  const popup = boot();

  await popup.refreshHistory();

  const list = popup.el('history-list');
  assert.strictEqual(list.children.length, 1);
  assert.match(list.children[0].textContent, /no uploads yet/i);
});

test('recorded captures are listed newest-first with their size', async () => {
  const popup = boot({
    ...SETTINGS,
    history: [
      { path: 'proj/user/2026-08-28T13-47-33-772Z_5921.png', size: 71776, ts: 1756388853772 },
      { path: 'proj/user/2026-08-28T12-00-00-000Z_1111.png', size: 2048,  ts: 1756382400000 }
    ]
  });

  await popup.refreshHistory();

  const list = popup.el('history-list');
  assert.strictEqual(list.children.length, 2, 'both captures should be listed');
  assert.match(list.children[0].innerHTML, /5921\.png/, 'the newest capture should be first');
  assert.match(list.children[0].innerHTML, /70\.1 KB/, 'the size should be shown in KB');
});
