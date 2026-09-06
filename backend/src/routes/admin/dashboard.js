'use strict';

const express = require('express');
const { db } = require('../../lib/firestore');
const { requireAdmin } = require('../../middleware/requireAuth');
const collections = require('../../lib/collections');

const router = express.Router();

router.get('/dashboard/stats', requireAdmin, async (req, res, next) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    // #101: requireAdmin proves the caller is an Admin, not that they are an
    // Admin *here*, and an Admin with no Workspace at all has nothing to be
    // scoped to. Refused rather than answered: an unscoped count for a caller
    // who belongs to nobody is every Customer's total, which is the disclosure
    // this route exists to stop (lesson 67).
    const workspaceId = req.hammerUser.workspaceId;
    if (!workspaceId) {
      return res.status(403).json({ error: 'Admin is not associated with a workspace' });
    }

    // Each count is an aggregation, so the rows never leave Firestore.
    //
    // Both queries below pair an equality on `workspaceId` with an inequality
    // on a second field, which needs a composite index — and needs it in a way
    // `npm run test:indexes` did not originally notice, because that audit only
    // looked at queries with an `orderBy` (extended in this change). The
    // emulator serves them without one either way, so nothing local will tell
    // you this was missed: see lesson 68.

    // Active Projects (memberCount > 0) in this Workspace
    const activeProjectsSnap = await db.collection(collections.PROJECTS)
      .where('workspaceId', '==', workspaceId)
      .where('memberCount', '>', 0)
      .count().get();

    // Pending Reports (status == 'queued' or 'processing')
    // Still unscoped: a Report carries only a projectId until #103 stamps it.
    const pendingReportsSnap = await db.collection(collections.REPORTS).where('status', 'in', ['queued', 'processing']).count().get();

    // Captures Today
    // Still unscoped: a Capture carries only a projectId until #102 stamps it.
    const capturesTodaySnap = await db.collection(collections.UPLOADS).where('uploadedAt', '>=', startOfDay).count().get();

    // #100 removed a fifth count here, over a collection nothing writes; see
    // lesson 69. If asynchronous Exports are ever built, this is a new tile
    // rather than a restored one.

    // Active Users Today in this Workspace
    const activeUsersTodaySnap = await db.collection(collections.USERS)
      .where('workspaceId', '==', workspaceId)
      .where('lastActiveAt', '>=', startOfDay)
      .count().get();

    return res.json({
      activeProjects: activeProjectsSnap.data().count,
      activeUsersToday: activeUsersTodaySnap.data().count,
      capturesToday: capturesTodaySnap.data().count,
      pendingReports: pendingReportsSnap.data().count,
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;
