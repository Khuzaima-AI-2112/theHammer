'use strict';

/**
 * OCR Reports: what changed between consecutive Captures of a Storyboard.
 *
 * This worker used to build a Gemini request with both image parts commented
 * out, never send it, and return two hardcoded findings — "Accept Terms and
 * Conditions" unchecked→checked, "Email Address" →user@example.com — for every
 * report, every Project, every time, stamped with a model that had not
 * produced them (#96, lesson 66). It now reads real Captures.
 *
 * The unit is a Storyboard rather than a Project, and the reasoning — with the
 * alternatives it closes off — is ADR 0017. Selection lives in lib/ocrPairs.js.
 *
 * What this file is responsible for is the honesty of what comes back:
 *
 *  - The prompt asks only for what is visible in **both** screenshots, and says
 *    an empty list is a valid answer. A model asked to find changes will find
 *    some.
 *  - The Analyst's note on a Capture is **never** sent. A note is their claim
 *    about what a step does; handing "Slide 8: user accepts the terms" to a
 *    model asked what changed between 7 and 8 is leading the witness. Notes go
 *    in the artifact beside each comparison so a reader can see whether the
 *    note and the finding agree.
 *  - Every finding is anchored to the two Capture ids it came from. Unlike
 *    #119's prose this claim has ground truth — two images and a click — so the
 *    move is checkability rather than detection.
 *  - A comparison that found nothing is recorded as a comparison with no
 *    findings. An absent finding and an unexamined pair must not look alike.
 */

const logger = require('../lib/logger');

const { Storage } = require('@google-cloud/storage');
const { db } = require('../lib/firestore');
const { getAIClient } = require('../lib/vertex');
const collections = require('../lib/collections');
const { DEFAULT_LLM_MODEL, REPORT_MAX_OUTPUT_TOKENS } = require('../lib/models');
const { selectComparablePairs, TooFewCapturesError } = require('../lib/ocrPairs');
const { withRateLimitRetry } = require('../lib/retry');

const gcs = new Storage();

/**
 * The findings one comparison may report.
 *
 * Kept from the original scaffolding, which was the one part of this file that
 * was right: it spans the two report types the portal used to offer separately,
 * which is why they collapse into one (ADR 0017) — a single pass over a pair
 * produces both, and billing twice for the same reading of the same two images
 * bought nothing.
 */
const FINDINGS_SCHEMA = {
  type: 'ARRAY',
  description: 'UI element state changes observed between two screenshots',
  items: {
    type: 'OBJECT',
    properties: {
      elementType: { type: 'STRING', description: 'checkbox, radio, or textfield' },
      label:       { type: 'STRING', description: 'The label or text identifying the element' },
      oldState:    { type: 'STRING', description: 'Its state in the first screenshot' },
      newState:    { type: 'STRING', description: 'Its state in the second screenshot' },
    },
    required: ['elementType', 'label', 'oldState', 'newState'],
  },
};

/**
 * The rule about visibility is the delicate one.
 *
 * It first read "report only elements you can see in **both** screenshots",
 * which was meant to keep findings grounded and instead made the Report blind
 * to the commonest change in a workflow. Verified against real Softomedia
 * Captures: between two steps an "Add New Retailer" modal opens carrying three
 * text fields, one of them already filled — and the comparison reported
 * nothing, because those fields appear in only one of the two screenshots. The
 * model was reading them; the prompt was discarding them.
 *
 * The grounding that matters is that the element is *visible somewhere*, not
 * that it is visible twice. Appearing and disappearing are states, and saying
 * so explicitly is what keeps "not present" from being dressed up as a value
 * the model invented.
 */
const COMPARISON_PROMPT = [
  'These are two consecutive screenshots of the same workflow.',
  '',
  'List the checkboxes, radio buttons and text fields that differ between them.',
  '',
  'Rules:',
  '- Report only elements you can actually see in at least one of the two screenshots.',
  '- Quote the label exactly as it appears on screen. Do not infer a label you cannot read.',
  '- If an element appears in only one screenshot, report it, and write exactly',
  '  "not present" for the screenshot it is missing from.',
  '- Report no element whose state is the same in both.',
  '- If nothing differs, return an empty list. An empty list is a correct answer.',
  '- Do not describe what the user was trying to do, or what happens next.',
].join('\n');

/** The Project's own model, as reportsWorker does — never a hardcoded id. */
async function resolveModelId(projectId) {
  const snap = await db.collection(collections.PROJECTS).doc(projectId).get();
  return snap.data()?.llmModel || DEFAULT_LLM_MODEL;
}

/** One pair, compared. Rate-limit retry lives here so one pair's burst does not fail the Report. */
async function compareOnePair(client, modelId, comparison, options = {}) {
  const request = {
    model: modelId,
    contents: [{
      role: 'user',
      parts: [
        { text: COMPARISON_PROMPT },
        { fileData: { mimeType: 'image/png', fileUri: comparison.from.gcsUri } },
        { fileData: { mimeType: 'image/png', fileUri: comparison.to.gcsUri } },
      ],
    }],
    config: {
      // Shared with the model's own reasoning tokens on a thinking model — see
      // REPORT_MAX_OUTPUT_TOKENS in lib/models.js for why it is not smaller.
      maxOutputTokens: REPORT_MAX_OUTPUT_TOKENS,
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: FINDINGS_SCHEMA,
    },
  };

  const resp = await withRateLimitRetry(
    () => client.models.generateContent(request),
    { label: `pair ${comparison.from.order}→${comparison.to.order}`, sleep: options.sleep }
  );

  const parsed = JSON.parse(resp.text);
  if (!Array.isArray(parsed)) throw new Error('model did not return a list of findings');
  return parsed;
}

/**
 * @param {string} storyboardId the Storyboard whose curated order is walked.
 */
async function generateOcrReport(reportId, projectId, reportType, storyboardId, options = {}) {
  const reportRef = db.collection(collections.REPORTS).doc(reportId);
  try {
    await reportRef.update({ status: 'processing', updatedAt: new Date().toISOString() });

    const draftSnap = await db.collection(collections.STORYBOARD_DRAFTS).doc(storyboardId ?? '_').get();
    if (!draftSnap.exists) throw new Error(`Storyboard ${storyboardId} not found`);
    const draft = draftSnap.data();

    // The route checked this before filing the row; checked again because the
    // worker is reachable by an Admin presenting the internal secret (#104),
    // and a Storyboard from another Project would mean reading Captures this
    // Report has no claim on.
    if (draft.projectId !== projectId) {
      throw new Error(`Storyboard ${storyboardId} does not belong to project ${projectId}`);
    }

    const modelId = await resolveModelId(projectId);
    const { comparisons, coverage } = await selectComparablePairs(draft, options);

    const client = getAIClient();
    const results = [];
    // Sequential, deliberately: see lib/retry.js. Twenty multimodal calls at
    // once is the burst the backoff exists to survive.
    for (const comparison of comparisons) {
      const record = {
        from: { captureId: comparison.from.captureId, order: comparison.from.order, note: comparison.from.note },
        to:   { captureId: comparison.to.captureId,   order: comparison.to.order,   note: comparison.to.note },
      };
      try {
        record.findings = await compareOnePair(client, modelId, comparison, options);
      } catch (err) {
        // One pair failing is not the Report failing, but it must not read as
        // "nothing changed here" either.
        logger.error(`[OCR Worker] comparison failed for ${reportId}:`, { error: err.message });
        record.findings = [];
        record.error = err.message;
      }
      results.push(record);
    }

    const resultData = {
      projectId,
      storyboardId,
      reportType,
      generatedAt: new Date().toISOString(),
      modelUsed: modelId,
      coverage,
      comparisons: results,
    };

    const bucketName = process.env.GCS_BUCKET || `hammer-reports-${projectId}`;
    const gcsPath = `${projectId}/reports/${reportId}.json`;
    await gcs.bucket(bucketName).file(gcsPath).save(JSON.stringify(resultData, null, 2), {
      metadata: { contentType: 'application/json' },
    });

    await reportRef.update({
      status: 'done',
      gcsPath: `gs://${bucketName}/${gcsPath}`,
      updatedAt: new Date().toISOString(),
    });

    logger.info(
      `[OCR Worker] Successfully generated ${reportId}: `
      + `${coverage.comparedPairs}/${coverage.availablePairs} pairs compared`
    );
  } catch (err) {
    logger.error(`[OCR Worker] Error generating ${reportId}:`, { error: err.message });
    // The reason is stored, not only logged: a Report that failed with an
    // empty panel and no explanation is what #120 existed to stop, and
    // "fewer than two included Captures" is something the Analyst can fix.
    await reportRef.update({
      status: 'error',
      error: err instanceof TooFewCapturesError ? err.message : 'Report generation failed.',
      updatedAt: new Date().toISOString(),
    }).catch((updateErr) => {
      logger.error(`[OCR Worker] could not record failure for ${reportId}:`, { error: updateErr.message });
    });
  }
}

module.exports = { generateOcrReport, COMPARISON_PROMPT, FINDINGS_SCHEMA };
