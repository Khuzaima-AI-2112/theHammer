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

    // In a real production system, these might use aggregation queries or be pre-calculated.
    // For this implementation, we will use basic queries where possible, and aggregates for larger collections.
    
    // Active Projects (memberCount > 0)
    const activeProjectsSnap = await db.collection(collections.PROJECTS).where('memberCount', '>', 0).count().get();
    
    // Pending Reports (status == 'queued' or 'processing')
    const pendingReportsSnap = await db.collection(collections.REPORTS).where('status', 'in', ['queued', 'processing']).count().get();
    
    // Captures Today
    const capturesTodaySnap = await db.collection(collections.UPLOADS).where('uploadedAt', '>=', startOfDay).count().get();

    // #100: there was a fifth tile here, counting `exports` for a pending
    // Export. Nothing has ever written that collection — an Export is produced
    // and returned by the request that asks for it, so it has no record and no
    // status to be pending in (CONTEXT.md, Export). The count was therefore
    // always 0, and the try/catch around it meant an Admin was told their export
    // queue was empty by a system that has no export queue. If asynchronous
    // exports are ever built, this is a new tile, not a restored one.

    // Active Users Today
    const activeUsersTodaySnap = await db.collection(collections.USERS).where('lastActiveAt', '>=', startOfDay).count().get();

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
