/**
 * #108 — the backfill that moves existing Projects off the retired model.
 *
 * Changing the defaults in code is not enough: `llmModel` is persisted on
 * every Project document, so a Project created before this ticket keeps
 * asking for `gemini-1.5-flash` no matter what the routes now default to.
 * The repair ships with the change, the same way #102's and #62's did.
 *
 * The discipline is the one the Workspace backfill next door established: a
 * value that is unambiguously dead is replaced, and anything else is reported
 * and left alone. An unrecognised id might be a model this code has not heard
 * of yet; overwriting it would be a guess, and a guess is how a Project
 * silently changes model behind its owner's back.
 *
 * Firestore: emulator.
 */
'use strict';

const { db } = require('../src/lib/firestore');
const collections = require('../src/lib/collections');
const { clearDatabase, seedProject } = require('./helpers/fixtures');
const { backfillLlmModel } = require('../scripts/llm-model-backfill');
const { DEFAULT_LLM_MODEL } = require('../src/lib/models');

async function modelOf(projectId) {
  const snap = await db.collection(collections.PROJECTS).doc(projectId).get();
  return snap.data().llmModel;
}

beforeEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await clearDatabase();
});

test('a dry run writes nothing, and that is the default', async () => {
  await seedProject('dry', { llmModel: 'gemini-1.5-flash' });

  const report = await backfillLlmModel({ db });

  expect(report.wouldStamp).toBe(1);
  expect(report.stamped).toBe(0);
  expect(await modelOf('dry')).toBe('gemini-1.5-flash');
});

test('--apply replaces a retired id with the supported default', async () => {
  await seedProject('retired', { llmModel: 'gemini-1.5-flash' });

  const report = await backfillLlmModel({ db, apply: true });

  expect(report.stamped).toBe(1);
  expect(await modelOf('retired')).toBe(DEFAULT_LLM_MODEL);
});

test('a Project with no llmModel at all is repaired too', async () => {
  // It would resolve to the default at read time anyway, but leaving the field
  // absent means the next person to read Firestore directly cannot tell which
  // model produced a Report.
  await seedProject('absent', {});
  await db.collection(collections.PROJECTS).doc('absent').update({
    llmModel: require('firebase-admin/firestore').FieldValue.delete(),
  });

  const report = await backfillLlmModel({ db, apply: true });

  expect(report.stamped).toBe(1);
  expect(await modelOf('absent')).toBe(DEFAULT_LLM_MODEL);
});

test('a Project already on a supported model is left exactly as it is', async () => {
  await seedProject('fine', { llmModel: 'gemini-2.5-pro' });

  const report = await backfillLlmModel({ db, apply: true });

  expect(report.skipped).toBe(1);
  expect(report.stamped).toBe(0);
  expect(await modelOf('fine')).toBe('gemini-2.5-pro');
});

test('an unrecognised id is reported and left alone, never guessed at', async () => {
  await seedProject('unknown', { llmModel: 'gemini-9.9-turbo' });

  const report = await backfillLlmModel({ db, apply: true });

  expect(report.needsHuman).toBe(1);
  expect(report.stamped).toBe(0);
  expect(await modelOf('unknown')).toBe('gemini-9.9-turbo');
});

test('re-running after an apply is a no-op', async () => {
  await seedProject('twice', { llmModel: 'gemini-1.5-flash' });

  await backfillLlmModel({ db, apply: true });
  const second = await backfillLlmModel({ db, apply: true });

  expect(second.stamped).toBe(0);
  expect(second.skipped).toBe(1);
});

test('the report names each Project it changed', async () => {
  await seedProject('named', { llmModel: 'gemini-1.5-flash' });

  const report = await backfillLlmModel({ db, apply: true });

  expect(report.rows).toEqual([
    { id: 'named', from: 'gemini-1.5-flash', to: DEFAULT_LLM_MODEL },
  ]);
});
