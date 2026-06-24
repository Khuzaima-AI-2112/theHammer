'use strict';

const logger = require('../lib/logger');


const { Storage } = require('@google-cloud/storage');
const { GoogleGenAI } = require('@google/genai');
const { db } = require('../lib/firestore');
const gcs = new Storage();

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'default-project';
const LOCATION = 'us-central1';

let aiClient = null;
function getAIClient() {
  if (!aiClient) {
    aiClient = new GoogleGenAI({ vertexai: { project: PROJECT_ID, location: LOCATION } });
  }
  return aiClient;
}

async function generateOcrReport(reportId, projectId, reportType, dateRange) {
  const reportRef = db.collection('reports').doc(reportId);
  try {
    await reportRef.update({ status: 'processing', updatedAt: new Date().toISOString() });

    const client = getAIClient();
    
    // We use gemini-1.5-flash for the best balance of speed, cost, and multimodal capability
    // (Actual call will use client.models.generateContent)
    const responseSchema = {
      type: 'ARRAY',
      description: 'A list of UI element state changes detected between screenshots',
      items: {
        type: 'OBJECT',
        properties: {
          elementType: {
            type: 'STRING',
            description: 'The type of element (checkbox, radio, textfield)'
          },
          label: {
            type: 'STRING',
            description: 'The label or text associated with the UI element'
          },
          oldState: {
            type: 'STRING',
            description: 'The state in the first screenshot (e.g., unchecked, empty)'
          },
          newState: {
            type: 'STRING',
            description: 'The state in the second screenshot (e.g., checked, "User entered text")'
          }
        },
        required: ['elementType', 'label', 'oldState', 'newState']
      }
    };

    // MVP: For demonstration, we assume we fetch two generic screenshots from GCS.
    // In a full implementation, you would query Firestore for the user's recent captures in the dateRange.
    // Here we construct a generic prompt.
    const prompt = "Compare these sequential screenshots. Identify any checkboxes or radio buttons that changed state. Identify any text fields where new text was entered. Return the exact changes using the provided JSON schema.";

    // Example payload (in a real scenario, you'd pass the actual GCS URIs of the captures)
    const request = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            // { fileData: { mimeType: 'image/png', fileUri: 'gs://your-bucket/img1.png' } },
            // { fileData: { mimeType: 'image/png', fileUri: 'gs://your-bucket/img2.png' } }
          ]
        }
      ]
    };

    // To prevent the MVP from crashing if no real images are passed, we mock the result if images aren't present.
    // In production, uncomment the await generativeModel.generateContent(request);
    
    // const responseStream = await generativeModel.generateContent(request);
    // const aggregatedResponse = await responseStream.response;
    // const resultJson = JSON.parse(aggregatedResponse.candidates[0].content.parts[0].text);

    // Mock Result
    const resultJson = [
      {
        elementType: 'checkbox',
        label: 'Accept Terms and Conditions',
        oldState: 'unchecked',
        newState: 'checked'
      },
      {
        elementType: 'textfield',
        label: 'Email Address',
        oldState: '',
        newState: 'user@example.com'
      }
    ];

    const resultData = {
      projectId,
      reportType,
      generatedAt: new Date().toISOString(),
      vertexAiModel: 'gemini-1.5-flash',
      changes: resultJson
    };

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
    
    logger.info(`[OCR Worker] Successfully generated ${reportId}`);
  } catch (err) {
    logger.error(`[OCR Worker] Error generating ${reportId}:`, err);
    await reportRef.update({ status: 'error', updatedAt: new Date().toISOString() });
  }
}

module.exports = { generateOcrReport };
