'use strict';

const logger = require('../lib/logger');


const { Storage } = require('@google-cloud/storage');
const { GoogleGenAI } = require('@google/genai');
const { db } = require('../lib/firestore');
const { getAIClient } = require('../lib/vertex');
const collections = require('../lib/collections');
const { CONFIG_DEFAULTS } = require('../lib/defaults');
const gcs = new Storage();

// This is a simplified MVP worker logic for generating standard reports
async function generateStandardReport(reportId, projectId, reportType, dateRange) {
  const reportRef = db.collection(collections.REPORTS).doc(reportId);
  try {
    await reportRef.update({ status: 'processing', updatedAt: new Date().toISOString() });

    // Fetch the project configuration to get the llmModel
    const projectSnap = await db.collection(collections.PROJECTS).doc(projectId).get();
    const projectData = projectSnap.data() || {};
    const modelId = projectData.llmModel || 'gemini-1.5-flash';

    // Mock data aggregation logic since full implementation requires detailed queries
    const resultData = {
      projectId,
      reportType,
      generatedAt: new Date().toISOString(),
      summary: "This is an auto-generated report.",
      modelUsed: modelId
    };

    if (reportType === 'user_efficiency') {
      resultData.metrics = { capturesPerHour: 42, medianSessionLength: "12m 30s" };
    } else if (reportType === 'project_progress') {
      resultData.metrics = { totalCaptures: 1045, activeUsers: 8 };
    }

    // Call Vertex AI LLM Router to generate narrative summary based on metrics
    try {
      const prompt = `You are an executive assistant. Generate a short narrative summary (max 3 sentences) for a report of type ${reportType}. 
      The metrics are: ${JSON.stringify(resultData.metrics)}`;

      const client = getAIClient();
      const resp = await client.models.generateContent({
        model: modelId,
        contents: prompt,
        config: {
          maxOutputTokens: 2048,
          temperature: 0.2,
          topP: 0.8,
        },
      });
      
      const summaryText = resp.text;
      resultData.summary = summaryText;
    } catch (llmError) {
      logger.error(`[Reports Worker] LLM Error for ${reportId} using ${modelId}:`, llmError);
      resultData.summary = "LLM generation failed. Showing raw metrics only.";
      resultData.llmError = llmError.message;
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
