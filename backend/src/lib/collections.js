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
  // What a Purge left behind (#115). After a Purge there is nothing else to
  // inspect, so this is the only trace it happened.
  PURGES: 'purges',
  CONFIG: 'config',
  WORKSPACES: 'workspaces',
  INVITATIONS: 'invitations',
  // An EXPORTS entry lived here and named a collection with no writers (#100,
  // lesson 69).
  ACTIVITY_EVENTS: 'activity_events' // if needed, otherwise maps to uploads/similar
};
