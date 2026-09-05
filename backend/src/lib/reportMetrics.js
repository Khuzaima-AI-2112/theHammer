'use strict';

/**
 * Report aggregation (#8).
 *
 * Every figure a report carries is computed here, from the Project's own
 * Captures and Sessions. Before this existed the worker hardcoded them —
 * 42 captures/hour, 1045 total Captures — and asked the model to write a
 * narrative about numbers nobody had measured.
 *
 * Workspace isolation is structural rather than checked: a Project belongs to
 * exactly one Workspace, and every query below is filtered to a single
 * projectId, so no aggregate can span two Customers. There is no query here
 * that reads a collection unfiltered.
 */

const { db } = require('./firestore');
const collections = require('./collections');

const MS_PER_HOUR = 3600000;

/**
 * Milliseconds as a human duration: "45s", "12m 30s", "1h 30m".
 * Seconds are dropped past the hour mark, where they are noise.
 */
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours   = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0)   return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

async function countCaptures(projectId) {
  const snap = await db.collection(collections.UPLOADS)
    .where('projectId', '==', projectId)
    .count()
    .get();
  return snap.data().count;
}

/**
 * Monitored Users who actually took a Capture in this Project — not its
 * membership count, which says who *may* capture rather than who did.
 *
 * There is no aggregation query for a distinct count, so this reads one
 * document per Capture. `select()` keeps that to a single field rather than
 * the whole row, but the read count still grows with the Project. A Project
 * far past the sizes seen so far would want a denormalised counter instead;
 * that is a separate change, not this ticket's.
 */
async function countDistinctCapturers(projectId) {
  const snap = await db.collection(collections.UPLOADS)
    .where('projectId', '==', projectId)
    .select('userId')
    .get();

  const userIds = new Set();
  snap.forEach((doc) => {
    const { userId } = doc.data();
    if (userId) userIds.add(userId);
  });
  return userIds.size;
}

/**
 * Every Session in the Project, reduced to the two durations a report needs.
 *
 * `wallMs` is the Session as the clock saw it, start to end. `activeMs` is
 * what /session-events already worked out after subtracting recorded
 * inactivity; where that was never computed (unparseable timestamps on an old
 * row) it falls back to wall time, which overstates activity rather than
 * silently dropping the Session from the denominator.
 */
async function readSessionDurations(projectId) {
  const snap = await db.collection(collections.SESSION_EVENTS)
    .where('projectId', '==', projectId)
    .select('sessionStart', 'sessionEnd', 'trueActiveMs')
    .get();

  const durations = [];
  snap.forEach((doc) => {
    const data = doc.data();
    const startMs = Date.parse(data.sessionStart);
    const endMs   = Date.parse(data.sessionEnd);
    const wallMs  = Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(0, endMs - startMs)
      : null;

    const activeMs = typeof data.trueActiveMs === 'number' && data.trueActiveMs >= 0
      ? data.trueActiveMs
      : wallMs;

    durations.push({ wallMs, activeMs });
  });
  return durations;
}

/**
 * How much work exists in the Project: how many Captures, and how many
 * Monitored Users made them. Skips the per-Capture read entirely when there
 * are no Captures to attribute.
 */
async function progressMetrics(projectId, captureCount) {
  return {
    totalCaptures: captureCount,
    activeUsers: captureCount === 0 ? 0 : await countDistinctCapturers(projectId)
  };
}

/**
 * Captures per hour of *active* Session time, and the median Session length.
 *
 * The rate deliberately divides by active time rather than wall time: idle and
 * locked minutes are already excluded from trueActiveMs, and dividing by wall
 * time would report a rate for hours nobody was working. Both are null when
 * there is nothing to divide by — a Project with no Sessions has no rate, and
 * saying "0" would be a claim about work that was never measured.
 */
async function sessionMetrics(projectId, captureCount) {
  const durations = await readSessionDurations(projectId);

  const activeMs = durations.reduce((total, d) => total + (d.activeMs ?? 0), 0);
  const wallDurations = durations
    .map((d) => d.wallMs)
    .filter((ms) => ms !== null);

  return {
    capturesPerHour: activeMs > 0
      ? round1(captureCount / (activeMs / MS_PER_HOUR))
      : null,
    medianSessionLength: wallDurations.length > 0
      ? formatDuration(median(wallDurations))
      : null
  };
}

/**
 * Metrics for one report, or null when the type has none defined.
 *
 * `captureCount` comes back alongside them because the caller needs to tell
 * "this Project recorded nothing" from "this Project recorded zero of the
 * thing I asked about" — the first is worth saying out loud in the report.
 */
async function computeReportMetrics(projectId, reportType) {
  const captureCount = await countCaptures(projectId);

  if (reportType === 'project_progress') {
    return { captureCount, metrics: await progressMetrics(projectId, captureCount) };
  }

  if (reportType === 'user_efficiency') {
    return { captureCount, metrics: await sessionMetrics(projectId, captureCount) };
  }

  if (reportType === 'executive_summary') {
    return {
      captureCount,
      metrics: {
        ...(await progressMetrics(projectId, captureCount)),
        ...(await sessionMetrics(projectId, captureCount))
      }
    };
  }

  return { captureCount, metrics: null };
}

module.exports = { computeReportMetrics, formatDuration };
