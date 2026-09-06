'use strict';

module.exports = {
  USERS: 'users',
  PROJECTS: 'projects',
  MEMBERSHIPS: 'project_memberships',
  UPLOADS: 'uploads',
  SESSION_EVENTS: 'session_events',
  INACTIVITY_EVENTS: 'inactivity_events',
  REPORTS: 'reports',
  STORYBOARD_DRAFTS: 'storyboard_drafts',
  CONFIG: 'config',
  WORKSPACES: 'workspaces',
  INVITATIONS: 'invitations',
  // An EXPORTS entry lived here and named a collection with no writers (#100,
  // lesson 69).
  ACTIVITY_EVENTS: 'activity_events' // if needed, otherwise maps to uploads/similar
};
