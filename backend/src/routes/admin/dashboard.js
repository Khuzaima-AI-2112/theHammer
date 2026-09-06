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

    // #100 removed a fifth count here, over a collection nothing writes; see
    // lesson 69. If asynchronous Exports are ever built, this is a new tile
    // rather than a restored one.

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
