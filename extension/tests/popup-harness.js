'use strict';

// Loads extension/popup.js into a sandbox with a stub `chrome` and a stub DOM,
// so the real popup-open path can be exercised in Node without a browser.
//
// popup.js grabs every element it needs with document.getElementById at the top
// level and then registers a DOMContentLoaded handler, so the stub DOM only has
// to hand back a node for any id and record what gets written to it. That is
// enough to drive loadConfig/loadProjects for real and read back what the
// project dropdown ends up showing the user.
//
// Mirrors sw-harness.js: sandbox + vm, named functions lifted out through an
// appended export line, because popup.js has no module.exports.
//
// Note: values the popup returns are built inside the vm context, so they carry
// the sandbox's prototypes, not the test's. assert.deepStrictEqual rejects them
// on identity even when the structure matches, and instanceof is false against
// the test realm's constructors — including for a thrown Error. Map into the
// test realm first (out.map(...)), assert on length, or check e.message rather
// than e instanceof Error. See lessons_learned.md #53.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const POPUP_PATH = path.join(__dirname, '..', 'popup.js');
const AUTH_PATH  = path.join(__dirname, '..', 'auth.js');

// The top-level names the tests reach in for. Anything declared inside the
// DOMContentLoaded handler (triggerSignIn, for one) is not in scope here and is
// driven through fireDOMContentLoaded() instead.
const EXPORTS = [
  'normaliseApiBase',
  'apiBase',
  'normaliseProjects',
  'authedFetch',
  'refreshFirebaseToken',
  'loadConfig',
  'loadProjects',
  'populateProjectSelect',
  'setProjectSelectPlaceholder',
  // #48: the tab toggle and the list it reveals.
  'switchTab',
  'refreshHistory'
];

function storageArea(initial = {}) {
  let store = structuredClone(initial);
  return {
    async get(keys) {
      if (keys == null) return structuredClone(store);
      if (typeof keys === 'string') {
        return keys in store ? { [keys]: structuredClone(store[keys]) } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in store) out[k] = structuredClone(store[k]);
        return out;
      }
      const out = structuredClone(keys);
      for (const k of Object.keys(keys)) if (k in store) out[k] = structuredClone(store[k]);
      return out;
    },
    async set(items) { Object.assign(store, structuredClone(items)); },
    async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
    _peek: () => structuredClone(store)
  };
}

/**
 * A DOM node with just enough behaviour for popup.js.
 *
 * innerHTML and appendChild are kept mutually exclusive on purpose: the popup
 * either writes a placeholder string or appends <option> children, never both,
 * so whichever happened last is what the user is looking at.
 */
function makeElement(id, tagName = 'div') {
  return {
    id,
    tagName: String(tagName).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    _innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    listeners: {},
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = String(v); this.children = []; },
    get firstChild() { return this.children[0] ?? null; },
    appendChild(child) { this._innerHTML = ''; this.children.push(child); return child; },
    insertBefore(child, ref) {
      this._innerHTML = '';
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i === -1) this.children.push(child); else this.children.splice(i, 0, child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i !== -1) this.children.splice(i, 1);
      return child;
    },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    click() { for (const fn of this.listeners.click ?? []) fn({ preventDefault() {} }); },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector: () => null,
    querySelectorAll: () => []
  };
}

/**
 * What the project dropdown is showing, as the user would read it.
 * Appended <option> children win; otherwise the placeholder string is parsed.
 */
function optionLabels(select) {
  if (select.children.length) return select.children.map((c) => String(c.textContent));
  return [...String(select.innerHTML).matchAll(/<option[^>]*>([\s\S]*?)<\/option>/g)]
    .map((m) => m[1]);
}

/** The values behind those options — what actually gets saved on the Session. */
function optionValues(select) {
  if (select.children.length) return select.children.map((c) => c.value);
  return [...String(select.innerHTML).matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
}

/**
 * @param {object}   [opts]
 * @param {object}   [opts.local]  seed for chrome.storage.local
 * @param {function} [opts.fetch]  (url, init) => Response-ish; defaults to 404
 */
function loadPopup(opts = {}) {
  const local = storageArea(opts.local ?? {});

  const nodes = new Map();
  const docListeners = {};
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, makeElement(id));
      return nodes.get(id);
    },
    createElement(tag) { return makeElement(null, tag); },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    removeEventListener() {},
    body: makeElement('body')
  };

  const requests = [];
  const notFound = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return (opts.fetch ?? notFound)(String(url), init);
  };

  const logs = { log: [], warn: [], error: [] };

  const chrome = {
    storage: { local },
    runtime: {
      lastError: undefined,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: (msg, cb) => {
        if (typeof cb === 'function') { cb({ ok: true }); return undefined; }
        return Promise.resolve({ ok: true });
      }
    },
    identity: {
      getRedirectURL: () => 'https://extension-id.chromiumapp.org/',
      launchWebAuthFlow: async () => { throw new Error('launchWebAuthFlow not stubbed'); }
    }
  };

  const sandbox = {
    chrome,
    document,
    fetch: fetchImpl,
    AbortController,
    URL,
    structuredClone,
    setTimeout: (fn, ms, ...args) => {
      const t = setTimeout(fn, ms, ...args);
      if (t.unref) t.unref();
      return t;
    },
    clearTimeout,
    setInterval: () => 0,
    clearInterval,
    console: {
      log: (...a) => logs.log.push(a.map(String).join(' ')),
      warn: (...a) => logs.warn.push(a.map(String).join(' ')),
      error: (...a) => logs.error.push(a.map(String).join(' '))
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);

  // popup.html loads auth.js before popup.js (#39), and popup.js calls
  // authedFetch at the top level of loadConfig/loadProjects, so the order
  // matters here for the same reason it does in the browser.
  vm.runInContext(fs.readFileSync(AUTH_PATH, 'utf8'), context, { filename: AUTH_PATH });

  const source = fs.readFileSync(POPUP_PATH, 'utf8');
  const exportLine = `\n;globalThis.__hammer = { ${EXPORTS.join(', ')} };\n`;
  vm.runInContext(source + exportLine, context, { filename: POPUP_PATH });

  const el = (id) => document.getElementById(id);

  return {
    ...sandbox.__hammer,
    chrome,
    local,
    requests,
    logs,
    el,
    /** Shorthand for the element under test in these cases. */
    projectSelect: el('project-select'),
    projectOptions: () => optionLabels(el('project-select')),
    projectValues: () => optionValues(el('project-select')),
    /** Drive the real popup-open path the way Chrome does. */
    fireDOMContentLoaded: async () => {
      for (const fn of docListeners.DOMContentLoaded ?? []) await fn();
    },
    settle: async (ticks = 20) => {
      for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
    }
  };
}

module.exports = { loadPopup, optionLabels, optionValues };
