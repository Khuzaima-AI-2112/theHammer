'use strict';

const { Storage } = require('@google-cloud/storage');
const { db } = require('../lib/firestore');
const gcs = new Storage();

// This is a simplified MVP worker logic for generating standard reports
async function generateStandardReport(reportId, projectId, reportType, dateRange) {
  const reportRef = db.collection('reports').doc(reportId);
  try {
    await reportRef.update({ status: 'processing', updatedAt: new Date().toISOString() });

    // Mock data aggregation logic since full implementation requires detailed queries
    const resultData = {
      projectId,
      reportType,
      generatedAt: new Date().toISOString(),
      summary: "This is an auto-generated report."
    };

    if (reportType === 'user_efficiency') {
      resultData.metrics = { capturesPerHour: 42, medianSessionLength: "12m 30s" };
    } else if (reportType === 'project_progress') {
      resultData.metrics = { totalCaptures: 1045, activeUsers: 8 };
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
    
    console.log(`[Reports Worker] Successfully generated ${reportId}`);
  } catch (err) {
    console.error(`[Reports Worker] Error generating ${reportId}:`, err);
    await reportRef.update({ status: 'error', updatedAt: new Date().toISOString() });
  }
}

module.exports = { generateStandardReport };
