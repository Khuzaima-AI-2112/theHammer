'use strict';

const { GoogleGenAI } = require('@google/genai');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'thehammer';
const LOCATION = process.env.VERTEX_LOCATION || 'northamerica-northeast1';

let aiClient = null;
function getAIClient() {
  if (!aiClient) {
    aiClient = new GoogleGenAI({ vertexai: { project: PROJECT_ID, location: LOCATION } });
  }
  return aiClient;
}

module.exports = {
  getAIClient,
  PROJECT_ID,
  LOCATION
};
