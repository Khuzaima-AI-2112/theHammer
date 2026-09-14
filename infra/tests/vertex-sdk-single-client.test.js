'use strict';

// One Vertex AI SDK, so a reader can tell which one is live (#10).
//
// Every model call goes through getAIClient() in backend/src/lib/vertex.js,
// which is built on @google/genai. The deprecated @google-cloud/vertexai
// package stayed declared in the root package.json long after the module that
// imported it was deleted, so the repo still advertised two SDKs.
// docs/architecture.md ("SDK") records why the old one was dropped.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { repoFiles } = require('./repo-files');

const REPO = path.join(__dirname, '..', '..');
const DEPRECATED = '@google-cloud/vertexai';

/**
 * Whether source code loads the named package, or a path inside it.
 *
 * Read a line at a time, skipping lines that open or continue a comment,
 * rather than stripping comments from the whole file: a `/*` inside a string
 * (extension/service-worker.js has `'http://*\/*'`) would otherwise swallow the
 * real code after it. Every import form this repo uses fits on one line.
 */
function imports(source, pkg) {
  const name = pkg.replace(/[/.]/g, '\\$&');
  const specifier = `['"\`]${name}(?:/[^'"\`]*)?['"\`]`;
  const load = new RegExp(
    `(?:require(?:\\.resolve)?\\s*\\(\\s*|from\\s+|import\\s*\\(\\s*|^\\s*import\\s+)${specifier}`
  );
  return source.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return false;
    return load.test(line);
  });
}

for (const manifest of ['package.json', 'backend/package.json']) {
  test(`${manifest} does not declare ${DEPRECATED}`, () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, manifest), 'utf8'));
    const declared = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
      .filter((field) => pkg[field] && DEPRECATED in pkg[field]);

    assert.deepStrictEqual(declared, [], `${manifest} still declares ${DEPRECATED} in ${declared.join(', ')}`);
  });
}

test(`no source file imports ${DEPRECATED}`, () => {
  const importing = repoFiles()
    .filter((file) => /\.(c|m)?js$/.test(file))
    .filter((file) => imports(fs.readFileSync(path.join(REPO, file), 'utf8'), DEPRECATED));

  assert.deepStrictEqual(importing, []);
});

// The scan is the whole guard, so it is tested against what it must catch and
// what it must ignore, including this file's own mentions (lesson 83).
test('the import scan sees every load form, and ignores comments and other packages', () => {
  const sees = (code) => assert.strictEqual(imports(code, DEPRECATED), true, code);
  const ignores = (code) => assert.strictEqual(imports(code, DEPRECATED), false, code);

  sees(`const { VertexAI } = require('${DEPRECATED}');`);
  sees(`const helpers = require("${DEPRECATED}/build/src/util");`);
  sees(`import { VertexAI } from '${DEPRECATED}';`);
  sees(`import '${DEPRECATED}';`);
  sees(`const mod = await import('${DEPRECATED}');`);
  sees(`const where = require.resolve('${DEPRECATED}');`);
  sees(`const hosts = ['http://*/*'];\nconst { VertexAI } = require('${DEPRECATED}');`);

  ignores(`// require('${DEPRECATED}')`);
  ignores(`/* was require('${DEPRECATED}') */`);
  ignores(` * it used to require('${DEPRECATED}')`);
  ignores(`const { GoogleGenAI } = require('@google/genai');`);
  ignores(`const other = require('${DEPRECATED}-fork');`);
});
