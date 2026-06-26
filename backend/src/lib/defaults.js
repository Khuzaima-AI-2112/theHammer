'use strict';

const USER_PREFERENCES = {
  inactivityPromptEnabled: false,
  inactivityTimerSeconds: 45,
  allowPreUploadBlur: false,
  instantClipboardLinks: false
};

const CONFIG_DEFAULTS = {
  retentionDays: 365,
  maxFileSizeBytes: 10 * 1024 * 1024, // 10 MB
  defaultCaptureQuality: 'png',
  backendUrl: 'https://app.thehammer.io/api',
  schemaVersion: 1
};

module.exports = {
  USER_PREFERENCES,
  CONFIG_DEFAULTS
};
