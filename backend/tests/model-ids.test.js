/**
 * #108 — the model ids the product is allowed to name.
 *
 * Every AI call used to name `gemini-1.5-flash`, retired on Vertex since
 * 2025-09-24, in seven places. Seven places is the defect underneath the
 * defect: a model id has a shelf life measured in months, so naming one in
 * seven files guarantees the next migration misses a site. `lib/models.js`
 * is the single owner, and the last test here is what keeps it single.
 *
 * The ids below were confirmed on 2026-09-08 by live `generateContent` calls
 * against `northamerica-northeast1` on project `thehammer`, not from docs
 * alone — see docs/planning/research-vertex-model-migration-2026-09-08.md.
 * `gemini-3.6-flash`, which issue #108 originally proposed, 404s in that
 * region and is deliberately absent.
 *
 * Offline: this suite reads source files and a constants module, nothing else.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const {
  DEFAULT_LLM_MODEL,
  TTS_MODEL,
  SUPPORTED_LLM_MODELS,
  RETIRED_MODEL_IDS,
  isSupportedLlmModel,
} = require('../src/lib/models');

describe('the ids themselves', () => {
  test('the default LLM is gemini-3.5-flash', () => {
    expect(DEFAULT_LLM_MODEL).toBe('gemini-3.5-flash');
  });

  test('the default is itself on the allowlist', () => {
    expect(SUPPORTED_LLM_MODELS).toContain(DEFAULT_LLM_MODEL);
  });

  test('the TTS model is the GA one, not the Gemini API preview id', () => {
    // gemini-2.5-flash-preview-tts is an ai.google.dev id and 404s on Vertex,
    // which is why the storyboard audio path had never once succeeded.
    expect(TTS_MODEL).toBe('gemini-2.5-flash-tts');
  });

  test('every allowlisted model is one confirmed served in northamerica-northeast1', () => {
    expect([...SUPPORTED_LLM_MODELS].sort()).toEqual([
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-3.5-flash',
    ]);
  });

  test('no retired model is allowlisted', () => {
    for (const retired of RETIRED_MODEL_IDS) {
      expect(SUPPORTED_LLM_MODELS).not.toContain(retired);
    }
  });

  test('the allowlist cannot be mutated by a caller', () => {
    expect(() => { SUPPORTED_LLM_MODELS.push('gemini-1.5-flash'); }).toThrow();
  });
});

describe('isSupportedLlmModel', () => {
  test('accepts an allowlisted id', () => {
    expect(isSupportedLlmModel('gemini-3.5-flash')).toBe(true);
  });

  test('refuses a retired id', () => {
    expect(isSupportedLlmModel('gemini-1.5-flash')).toBe(false);
  });

  test('refuses a model that is real but not served in our region', () => {
    expect(isSupportedLlmModel('gemini-3.6-flash')).toBe(false);
  });

  test('refuses arbitrary strings, which is what used to be stored', () => {
    for (const junk of ['', '   ', 'not-a-model', 'gpt-4', null, undefined, 42, {}]) {
      expect(isSupportedLlmModel(junk)).toBe(false);
    }
  });

  test('does not quietly accept surrounding whitespace', () => {
    // The routes trim before validating; the predicate itself should not,
    // or a caller that forgets to trim looks correct here and stores a
    // padded id Vertex will 404 on.
    expect(isSupportedLlmModel(' gemini-3.5-flash ')).toBe(false);
  });
});

describe('lib/models.js is the only place a model id is written', () => {
  // The point of the module. Without this test the next migration reintroduces
  // exactly the spread that made this a seven-site change.
  //
  // Scoped to *string literals* on purpose. An earlier version matched bare
  // words too, so it caught comments as well as code — and a guard that makes
  // prose illegal does not get satisfied, it gets worked around: two comments
  // were reworded into inaccuracy just to pass it. A comment naming a model is
  // documentation. A string literal naming one is a second source of truth,
  // and only the second is a defect.
  //
  // The portal is not covered here: it is browser code and cannot require this
  // module. portal/tests/llm-model-options-contract.test.js holds that side to
  // the same allowlist instead.
  const SRC = path.join(__dirname, '..', 'src');
  const OWNER = path.join(SRC, 'lib', 'models.js');

  function jsFilesUnder(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return jsFilesUnder(full);
      return e.isFile() && e.name.endsWith('.js') ? [full] : [];
    });
  }

  /**
   * The file with its comments removed.
   *
   * The scoping above says a comment naming a model is documentation, and the
   * regex delivered that only for a *bare* mention. This codebase writes
   * `gemini-3.5-flash` in prose with backticks around it constantly, and a
   * backtick is indistinguishable from a template literal to a regex — so
   * lib/retry.js was flagged for a sentence in its own header explaining which
   * model returns RESOURCE_EXHAUSTED (#96).
   *
   * That is the failure this guard's own comment predicts: it does not get
   * satisfied, it gets worked around, by rewording an accurate sentence into a
   * vaguer one. Removing comments before scanning makes the stated intent true
   * for every way a comment can be written.
   */
  function codeOf(text) {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
  }

  test('no source file outside lib/models.js contains a literal model id', () => {
    const offenders = [];
    for (const file of jsFilesUnder(SRC)) {
      if (file === OWNER) continue;
      const hits = codeOf(fs.readFileSync(file, 'utf8')).match(/['"`]gemini-[0-9][^'"`]*['"`]/g);
      if (hits) offenders.push(`${path.relative(SRC, file)}: ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  test('a model named in a comment is documentation, however it is quoted', () => {
    // Both forms a comment actually takes in this codebase. The bare `//` case
    // the original regex already handled; the block-comment case is the one
    // that flagged lib/retry.js, because a backtick reads as a template
    // literal.
    const block = '/**\n * `gemini-3.5-flash` returned RESOURCE_EXHAUSTED under load.\n */';
    const line = '// Was `gemini-1.5-flash`, retired 2025-09-24.';

    expect(codeOf(block).match(/['"`]gemini-[0-9][^'"`]*['"`]/g)).toBeNull();
    expect(codeOf(line).match(/['"`]gemini-[0-9][^'"`]*['"`]/g)).toBeNull();
  });

  test('stripping comments does not blind the guard to real code', () => {
    // The other half: a guard that stopped catching anything would also pass.
    const sample = "const m = 'gemini-1.5-flash'; // see lib/models.js";
    expect(codeOf(sample).match(/['"`]gemini-[0-9][^'"`]*['"`]/g)).toEqual(["'gemini-1.5-flash'"]);
  });

  test('the guard would catch a literal reintroduced in a source file', () => {
    // A guard nobody has seen fail is a guard nobody knows works — lesson 80.
    const sample = "const m = 'gemini-1.5-flash';";
    expect(sample.match(/['"`]gemini-[0-9][^'"`]*['"`]/g)).toEqual(["'gemini-1.5-flash'"]);
  });

  test('the guard ignores a model named in a comment', () => {
    const sample = '// gemini-1.5-flash was retired on 2025-09-24.';
    expect(sample.match(/['"`]gemini-[0-9][^'"`]*['"`]/g)).toBeNull();
  });
});
