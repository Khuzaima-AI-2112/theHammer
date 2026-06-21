'use strict';

const express = require('express');
const { db } = require('../../lib/firestore');
const { requireAdmin } = require('../../middleware/requireAuth');

const router = express.Router();

router.get('/dashboard/stats', requireAdmin, async (req, res, next) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    // In a real production system, these might use aggregation queries or be pre-calculated.
    // For this implementation, we will use basic queries where possible, and aggregates for larger collections.
    
    // Active Projects (memberCount > 0)
    const activeProjectsSnap = await db.collection('projects').where('memberCount', '>', 0).count().get();
    
    // Pending Reports (status == 'queued' or 'processing')
    const pendingReportsSnap = await db.collection('reports').where('status', 'in', ['queued', 'processing']).count().get();
    
    // Captures Today
    const capturesTodaySnap = await db.collection('uploads').where('uploadedAt', '>=', startOfDay).count().get();

    // Pending Exports (assuming we'll use an exports collection later, for now hardcode to 0 as it's Sprint 22 or we don't have it yet)
    let pendingExportsCount = 0;
    try {
      const exportsSnap = await db.collection('exports').where('status', 'in', ['queued', 'processing']).count().get();
      pendingExportsCount = exportsSnap.data().count;
    } catch(err) {
      // Collection might not exist or be used yet
    }

    // Active Users Today
    const activeUsersTodaySnap = await db.collection('users').where('lastActiveAt', '>=', startOfDay).count().get();

    return res.json({
      activeProjects: activeProjectsSnap.data().count,
      activeUsersToday: activeUsersTodaySnap.data().count,
      capturesToday: capturesTodaySnap.data().count,
      pendingReports: pendingReportsSnap.data().count,
      pendingExports: pendingExportsCount,
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;
