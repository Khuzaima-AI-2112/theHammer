/**
 * Loading the app does not construct a Cloud Storage client (#19)
 *
 * `new Storage()` begins resolving Application Default Credentials, which on a
 * machine with no GCE metadata server leaves an outbound connection pending
 * and holds Jest open after the run. It used to happen at module scope in
 * index.js and in seven modules index.js loads, so every suite that required the
 * app paid for credential resolution whether it touched a bucket or not, and
 * tests/setup/env.js had to set METADATA_SERVER_DETECTION=none to contain it.
 *
 * Every caller now goes through lib/storage.js, which constructs the client on
 * first use and keeps it.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

jest.mock('@google-cloud/storage', () => require('./helpers/gcsMock').createStorageMock());

/** A fresh module registry, so neither test depends on what the other loaded. */
function freshlyLoaded() {
  let loaded;
  jest.isolateModules(() => {
    loaded = {
      Storage: require('@google-cloud/storage').Storage,
      getStorage: require('../src/lib/storage').getStorage,
    };
    require('../src/index');
  });
  return loaded;
}

describe('the Cloud Storage client', () => {
  test('is not constructed by requiring the app', () => {
    const { Storage } = freshlyLoaded();

    expect(Storage).not.toHaveBeenCalled();
  });

  test('is constructed on first use, once, and reused', () => {
    const { Storage, getStorage } = freshlyLoaded();

    const first = getStorage();
    const second = getStorage();

    expect(Storage).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });
});

// The two tests above hold for lib/storage.js. What makes the app share that
// one client is that nothing else constructs its own, so that is checked over
// the whole source tree: a module-scope `new Storage()` added anywhere would
// bring back the side effect, and a function-scope one would be a second
// client. Comments are stripped first so this file's own explanation, and any
// docblock that names the call, does not count (lesson 83).
describe('src/', () => {
  const SRC = path.join(__dirname, '..', 'src');

  function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  }

  function constructsStorage(source) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return /\bnew\s+Storage\s*\(/.test(code);
  }

  test('constructs a Storage client only in lib/storage.js', () => {
    const constructing = sourceFiles(SRC)
      .filter((file) => constructsStorage(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'));

    expect(constructing).toEqual(['lib/storage.js']);
  });

  test('the scan sees a construction, and ignores one in a comment', () => {
    expect(constructsStorage('const gcs = new Storage();\n')).toBe(true);
    expect(constructsStorage('// const gcs = new Storage();\n')).toBe(false);
    expect(constructsStorage('/**\n * was `new Storage()` at module scope\n */\n')).toBe(false);
  });
});
