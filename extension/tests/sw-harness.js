'use strict';

// Loads extension/service-worker.js into a sandbox with a stub `chrome`, so the
// real Session code can be exercised in Node without a browser.
//
// The service worker only touches Chrome at the top level to register
// listeners, so the stub needs to be no more than an object of the right shape;
// everything else it needs — storage, fetch, tabs, the action badge — is
// recorded here for tests to assert against.
//
// Listeners are kept rather than discarded (#11), so a test can invoke the
// registered chrome.runtime.onMessage handler directly and drive a capture the
// way the popup does.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SW_PATH = path.join(__dirname, '..', 'service-worker.js');

// The names the tests reach in for. Anything else in the worker stays private.
const EXPORTS = [
  'sessionGet',
  'sessionSet',
  'sessionClear',
  'sessionOnCapture',
  'sessionFlush',
  'sessionIndicate',
  // #39: the retry/notice pair. auth.js runs in this same context via the
  // importScripts shim below, so its declarations are in scope here too.
  'withRetry',
  'isAuthExpired',
  'uploadFailureNotice'
];

// captureVisibleTab has to return something capture()'s own sanity check
// accepts: a PNG data URL of at least 10,000 characters.
const FAKE_PNG = 'data:image/png;base64,' + 'A'.repeat(12000);

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
    async set(items) {
      Object.assign(store, structuredClone(items));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete store[k];
    },
    _peek: () => structuredClone(store)
  };
}

// Keeps what it is given, so tests can invoke the real handlers.
const listenerStub = () => {
  const listeners = [];
  return {
    listeners,
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    }
  };
};

/**
 * Send a message to the worker the way chrome does, and wait for the response.
 *
 * Resolves with whatever the handler passes to sendResponse; resolves with
 * undefined if it declines the message (returns anything but true).
 */
function sendMessageTo(onMessage, msg, sender = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sendResponse = (res) => { settled = true; resolve(res); };
    let async = false;
    for (const fn of onMessage.listeners) {
      if (fn(msg, sender, sendResponse) === true) async = true;
    }
    if (!async && !settled) resolve(undefined);
    // A handler that claims to be async and then never answers is a bug worth
    // failing on rather than hanging the suite.
    if (async && !settled) {
      const t = setTimeout(() => reject(new Error(`no response to ${msg.type}`)), 5000);
      if (t.unref) t.unref();
    }
  });
}

/**
 * @param {object}   [opts]
 * @param {object}   [opts.local]      seed for chrome.storage.local
 * @param {function} [opts.fetch]      fetch implementation; defaults to 200 OK
 * @param {object[]} [opts.tabs]       what chrome.tabs.query returns
 * @param {function} [opts.tabMessage] (tabId, msg) => response, or
 *                                     { __lastError: 'message' } to simulate a
 *                                     tab with no content script listening
 */
function loadServiceWorker(opts = {}) {
  const local = storageArea(opts.local ?? {});
  const session = storageArea({});

  const requests = [];
  const jsonBody = (init) => {
    if (!init || !init.body || typeof init.body !== 'string') return null;
    try { return JSON.parse(init.body); } catch { return null; }
  };
  // The signed URL /upload-url hands back. The PUT to it goes to Cloud Storage,
  // not to the backend, so it is answered here rather than by the API stubs.
  const SIGNED_PUT = 'https://gcs.test/signed-put';

  const defaultFetch = async (url, init = {}) => {
    // capture() turns its data URL into a Blob by fetching it. opts.blobFails
    // simulates that conversion producing something capture()'s own sanity
    // check rejects (#72's "Could not convert screenshot to PNG blob").
    if (String(url).startsWith('data:')) {
      return opts.blobFails
        ? { ok: true, status: 200, blob: async () => new Blob([], { type: 'text/plain' }) }
        : { ok: true, status: 200, blob: async () => new Blob(['png'], { type: 'image/png' }) };
    }
    requests.push({ url, init, body: jsonBody(init) });
    if (String(url) === SIGNED_PUT) {
      return opts.putFails
        ? { ok: false, status: 403, text: async () => 'CORS: origin not allowed' }
        : { ok: true, status: 200, text: async () => '' };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success:   true,
        signedUrl: 'https://gcs.test/signed-put',
        readUrl:   'https://gcs.test/read',
        path:      'uploads/test.png'
      })
    };
  };
  const fetchImpl = opts.fetch
    ? (url, init = {}) => {
        if (String(url).startsWith('data:')) return defaultFetch(url, init);
        requests.push({ url, init, body: jsonBody(init) });
        return opts.fetch(url, init);
      }
    : defaultFetch;

  const badge = { text: null, title: null, colour: null, calls: [] };
  const logs = { log: [], warn: [], error: [] };
  const notifications = [];

  // Everything the tabs stub saw or was asked to do.
  const tabs = {
    list: opts.tabs ?? [{ id: 1, windowId: 10, url: 'https://example.test/page', title: 'Example' }],
    messages: [],   // { tabId, msg }
    captures: []    // windowId per captureVisibleTab call
  };
  const tabMessage = opts.tabMessage ?? (() => undefined);

  const runtime = {
    onSuspend: listenerStub(),
    onInstalled: listenerStub(),
    onStartup: listenerStub(),
    onConnect: listenerStub(),
    onMessage: listenerStub(),
    lastError: undefined
  };

  // Messages the worker sends to itself / the offscreen document.
  const internalMessages = [];
  runtime.sendMessage = (msg, cb) => {
    internalMessages.push(msg);
    let res;
    if (msg.type === 'CROP_IMAGE') res = { ok: true, dataUrl: FAKE_PNG };
    else if (msg.type === 'WRITE_CLIPBOARD') res = { ok: true };
    else res = { ok: true };
    if (typeof cb === 'function') { cb(res); return undefined; }
    return Promise.resolve(res);
  };

  const chrome = {
    storage: { local, session },
    runtime,
    tabs: {
      query(_info, cb) {
        const found = tabs.list;
        if (typeof cb === 'function') { cb(found); return undefined; }
        return Promise.resolve(found);
      },
      sendMessage(tabId, msg, cb) {
        tabs.messages.push({ tabId, msg });
        const res = tabMessage(tabId, msg);
        const deliver = () => {
          if (res && res.__lastError) {
            runtime.lastError = { message: res.__lastError };
            if (typeof cb === 'function') cb(undefined);
            runtime.lastError = undefined;
          } else if (typeof cb === 'function') {
            cb(res);
          }
        };
        if (typeof cb === 'function') { deliver(); return undefined; }
        return Promise.resolve(res);
      },
      async captureVisibleTab(windowId) {
        tabs.captures.push(windowId);
        // opts.captureVisibleTabResult lets a test simulate Chrome handing back
        // something capture()'s own sanity check rejects (#72's "Screenshot
        // data looks invalid").
        return opts.captureVisibleTabResult ?? FAKE_PNG;
      }
    },
    offscreen: {
      async hasDocument() { return true; },
      async createDocument() {}
    },
    windows: { onRemoved: listenerStub(), getAll: async () => [] },
    contextMenus: { onClicked: listenerStub(), create() {}, removeAll() {} },
    commands: { onCommand: listenerStub() },
    alarms: { onAlarm: listenerStub(), create() {}, clear() {} },
    notifications: {
      onButtonClicked: listenerStub(),
      create(id, options, cb) {
        notifications.push(options);
        if (typeof cb === 'function') cb(id || 'notification');
      },
      clear() {}
    },
    action: {
      async setBadgeText({ text }) { badge.text = text; badge.calls.push(['badge', text]); },
      async setBadgeBackgroundColor({ color }) { badge.colour = color; },
      async setTitle({ title }) { badge.title = title; badge.calls.push(['title', title]); }
    }
  };

  // #70: this sandbox used to define `XMLHttpRequest: FakeXHR`, and that is
  // exactly why the bug it hid survived. A Manifest V3 service worker has no
  // XMLHttpRequest — the worker global scope offers fetch and nothing else —
  // so a harness that supplies one is more capable than the runtime it stands
  // for, and every test of the signed-URL PUT passed against code that could
  // never run. The PUT is a fetch now, served by fetchImpl below, and this
  // sandbox deliberately does NOT define XMLHttpRequest.
  //
  // `opts.putFails` still makes the PUT fail. That is not a hypothetical: the
  // PUT goes from the extension straight to Cloud Storage, so it is refused
  // whenever the bucket CORS policy does not name the extension origin, and
  // it is the one case that sends a single Capture down both upload paths.

  // Node has Blob but not FileReader. Real MV3 service workers do have it —
  // File API's FileReader is Worker-scope, unlike XMLHttpRequest (#70) — so its
  // absence here was never testing a real constraint, only blocking
  // blobToBase64 (the offline-queue path) with an unrelated ReferenceError
  // before it ever ran. Just enough of the interface for that one call site.
  class HarnessFileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer()
        .then((buf) => {
          this.result = `data:${blob.type || 'application/octet-stream'};base64,` +
            Buffer.from(buf).toString('base64');
          this.onloadend?.();
        })
        .catch((err) => this.onerror?.(err));
    }
  }

  const sandbox = {
    chrome,
    fetch: fetchImpl,
    crypto: globalThis.crypto,
    structuredClone,
    FileReader: HarnessFileReader,
    // Unreffed so a pending timeout inside the worker — the 2s semantic-data
    // guard, for one — cannot hold the test process open.
    setTimeout: (fn, ms, ...args) => {
      const t = setTimeout(fn, ms, ...args);
      if (t.unref) t.unref();
      return t;
    },
    clearTimeout,
    URL,
    Blob,
    atob,
    btoa,
    FormData: globalThis.FormData,
    AbortController,
    console: {
      log: (...a) => logs.log.push(a.join(' ')),
      warn: (...a) => logs.warn.push(a.join(' ')),
      error: (...a) => logs.error.push(a.join(' '))
    }
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);

  // The worker calls importScripts('auth.js') at the top level (#39). Run the
  // named file in this same context so its globals land where the worker looks
  // for them — assigning after createContext still reaches the contextified
  // global.
  sandbox.importScripts = (...files) => {
    for (const f of files) {
      const full = path.join(__dirname, '..', f);
      vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename: full });
    }
  };
  const source = fs.readFileSync(SW_PATH, 'utf8');
  const exportLine = `\n;globalThis.__hammer = { ${EXPORTS.join(', ')} };\n`;
  vm.runInContext(source + exportLine, context, { filename: SW_PATH });

  return {
    ...sandbox.__hammer,
    /** #70: lets a test assert the sandbox matches MV3, which has no XHR. */
    hasXMLHttpRequest: 'XMLHttpRequest' in sandbox,
    chrome,
    local,
    session,
    requests,
    badge,
    logs,
    tabs,
    notifications,
    internalMessages,
    FAKE_PNG,
    /** Drive chrome.runtime.onMessage the way the popup does. */
    send: (msg, sender) => sendMessageTo(runtime.onMessage, msg, sender),
    /**
     * Let work the worker started on its own finish — the offline-queue drain
     * runs at load, so a test that cares about the queue has to wait for it.
     */
    settle: async (ticks = 50) => {
      for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
    }
  };
}

/** The session_events writes only, in the order they were attempted. */
function sessionEvents(requests) {
  return requests.filter((r) => String(r.url).endsWith('/session-events')).map((r) => r.body);
}

module.exports = { loadServiceWorker, sessionEvents, FAKE_PNG };
