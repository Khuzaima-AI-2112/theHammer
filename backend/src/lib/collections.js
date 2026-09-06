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
  // There was an EXPORTS entry here. Nothing ever wrote that collection: an
  // Export is a file produced and returned by the request that asks for it, so
  // it has no record (CONTEXT.md, Export). Removed with the Dashboard tile that
  // was counting it (#100).
  ACTIVITY_EVENTS: 'activity_events' // if needed, otherwise maps to uploads/similar
};
