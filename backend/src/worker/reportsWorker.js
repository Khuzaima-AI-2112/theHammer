'use strict';

const logger = require('../lib/logger');


const { Storage } = require('@google-cloud/storage');
const { GoogleGenAI } = require('@google/genai');
const { db } = require('../lib/firestore');
const { getAIClient } = require('../lib/vertex');
const collections = require('../lib/collections');
const { computeReportMetrics } = require('../lib/reportMetrics');
const { CONFIG_DEFAULTS } = require('../lib/defaults');
const { DEFAULT_LLM_MODEL, REPORT_MAX_OUTPUT_TOKENS } = require('../lib/models');
const { buildReportNarrativePrompt, guardNarrative } = require('../lib/narrativeGuard');
const gcs = new Storage();

// This is a simplified MVP worker logic for generating standard reports
async function generateStandardReport(reportId, projectId, reportType, dateRange) {
  const reportRef = db.collection(collections.REPORTS).doc(reportId);
  try {
    await reportRef.update({ status: 'processing', updatedAt: new Date().toISOString() });

    // Fetch the project configuration to get the llmModel
    const projectSnap = await db.collection(collections.PROJECTS).doc(projectId).get();
    const projectData = projectSnap.data() || {};
    const modelId = projectData.llmModel || DEFAULT_LLM_MODEL;

    // #8: every figure below is queried from this Project's own Captures and
    // Sessions. It used to be four hardcoded numbers with a narrative written
    // about them, which read as measurement and was not.
    const { metrics, captureCount } = await computeReportMetrics(projectId, reportType);

    const resultData = {
      projectId,
      reportType,
      generatedAt: new Date().toISOString(),
      summary: "This is an auto-generated report.",
      modelUsed: modelId
    };

    if (metrics) resultData.metrics = metrics;

    // Two cases have nothing to narrate, and asking the model anyway is
    // exactly how invented activity gets back in: a Project that has recorded
    // no Captures at all, and a report type no metric is defined for. Say so
    // plainly instead.
    if (captureCount === 0) {
      resultData.summary = 'No Captures have been recorded for this Project, so there is nothing to report on yet.';
    } else if (!metrics) {
      resultData.summary = `No metrics are defined for a report of type ${reportType}.`;
    } else {
      // Call Vertex AI LLM Router to generate narrative summary based on metrics
      try {
        // #119: the prompt asks for a description, not for an executive
        // assistant's voice — that register is what produced a Report
        // committing the Customer to "onboarding additional team members".
        const prompt = buildReportNarrativePrompt(reportType, resultData.metrics);

        const client = getAIClient();
        const resp = await client.models.generateContent({
          model: modelId,
          contents: prompt,
          config: {
            // Shared with the model's own reasoning tokens — see
            // REPORT_MAX_OUTPUT_TOKENS in lib/models.js for why it is not smaller.
            maxOutputTokens: REPORT_MAX_OUTPUT_TOKENS,
            temperature: 0.2,
            topP: 0.8,
          },
        });

        // A prompt constraint cannot be observed to have worked, so what came
        // back is checked before it is published (ADR 0016).
        const { summary, guard } = guardNarrative(resp.text, resultData.metrics);
        resultData.summary = summary;
        resultData.summaryGuard = guard;
        if (guard.status === 'rejected') {
          logger.warn(
            `[Reports Worker] Narrative rejected for ${reportId} (${guard.markers.join(', ')})`
          );
        }
      } catch (llmError) {
        logger.error(`[Reports Worker] LLM Error for ${reportId} using ${modelId}:`, llmError);
        resultData.summary = "LLM generation failed. Showing raw metrics only.";
        resultData.llmError = llmError.message;
      }
    }

    // Write to GCS
    const bucketName = process.env.GCS_BUCKET || `hammer-reports-${projectId}`;
    const gcsPath = `${projectId}/reports/${reportId}.json`;
    const bucket = gcs.bucket(bucketName);
    const file = bucket.file(gcsPath);

    await file.save(JSON.stringify(resultData, null, 2), {
      metadata: { contentType: 'application/json' }
    });

    // Update Firestore
    await reportRef.update({
      status: 'done',
      gcsPath: `gs://${bucketName}/${gcsPath}`,
      updatedAt: new Date().toISOString()
    });
    
    logger.info(`[Reports Worker] Successfully generated ${reportId}`);
  } catch (err) {
    logger.error(`[Reports Worker] Error generating ${reportId}:`, err);
    await reportRef.update({ status: 'error', updatedAt: new Date().toISOString() });
  }
}

module.exports = { generateStandardReport };
