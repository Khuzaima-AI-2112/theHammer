'use strict';

// Loads extension/service-worker.js into a sandbox with a stub `chrome`, so the
// real Session code can be exercised in Node without a browser.
//
// The service worker only touches Chrome at the top level to register
// listeners, so the stub needs to be no more than an object of the right shape;
// everything else it needs — storage, fetch, the action badge — is recorded
// here for tests to assert against.

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
  'sessionIndicate'
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
    async set(items) {
      Object.assign(store, structuredClone(items));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete store[k];
    },
    _peek: () => structuredClone(store)
  };
}

const listenerStub = () => ({ addListener() {}, removeListener() {} });

/**
 * @param {object}   [opts]
 * @param {object}   [opts.local]   seed for chrome.storage.local
 * @param {function} [opts.fetch]   fetch implementation; defaults to 200 OK
 */
function loadServiceWorker(opts = {}) {
  const local = storageArea(opts.local ?? {});
  const session = storageArea({});

  const requests = [];
  const defaultFetch = async (url, init = {}) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  const fetchImpl = opts.fetch
    ? (url, init = {}) => {
        requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
        return opts.fetch(url, init);
      }
    : defaultFetch;

  const badge = { text: null, title: null, colour: null, calls: [] };
  const logs = { log: [], warn: [], error: [] };

  const chrome = {
    storage: { local, session },
    runtime: {
      onSuspend: listenerStub(),
      onInstalled: listenerStub(),
      onStartup: listenerStub(),
      onConnect: listenerStub(),
      onMessage: listenerStub()
    },
    windows: { onRemoved: listenerStub(), getAll: async () => [] },
    contextMenus: { onClicked: listenerStub(), create() {}, removeAll() {} },
    commands: { onCommand: listenerStub() },
    alarms: { onAlarm: listenerStub(), create() {}, clear() {} },
    notifications: { onButtonClicked: listenerStub(), create() {} },
    action: {
      async setBadgeText({ text }) { badge.text = text; badge.calls.push(['badge', text]); },
      async setBadgeBackgroundColor({ color }) { badge.colour = color; },
      async setTitle({ title }) { badge.title = title; badge.calls.push(['title', title]); }
    }
  };

  const sandbox = {
    chrome,
    fetch: fetchImpl,
    crypto: globalThis.crypto,
    structuredClone,
    setTimeout,
    clearTimeout,
    URL,
    Blob,
    console: {
      log: (...a) => logs.log.push(a.join(' ')),
      warn: (...a) => logs.warn.push(a.join(' ')),
      error: (...a) => logs.error.push(a.join(' '))
    }
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const source = fs.readFileSync(SW_PATH, 'utf8');
  const exportLine = `\n;globalThis.__hammer = { ${EXPORTS.join(', ')} };\n`;
  vm.runInContext(source + exportLine, context, { filename: SW_PATH });

  return { ...sandbox.__hammer, chrome, local, session, requests, badge, logs };
}

/** The session_events writes only, in the order they were attempted. */
function sessionEvents(requests) {
  return requests.filter((r) => String(r.url).endsWith('/session-events')).map((r) => r.body);
}

module.exports = { loadServiceWorker, sessionEvents };
