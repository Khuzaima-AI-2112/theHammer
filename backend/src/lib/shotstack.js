'use strict';

/**
 * Shotstack render client (#90) — theHammer's only Shotstack integration.
 *
 * Calls Shotstack via the platform's global `fetch` rather than an SDK, the
 * same way reports.js already calls its own worker endpoint. There is
 * nothing here to mock through `jest.mock('some-sdk')`; tests replace
 * `global.fetch` instead — see `tests/helpers/shotstackMock.js`.
 *
 * `refreshVideoReportStatus()` is the one entry point GET /admin/reports/:id
 * /status (reports.js) calls. theHammer has no queue/worker/webhook
 * infrastructure to learn when a Shotstack render finishes (Rule 7, "No
 * Phantom Infrastructure" — nothing here assumes a Pub/Sub topic or Cloud
 * Tasks queue that was never provisioned), so instead of pushing, this pulls:
 * the existing "poll GET /admin/reports/:id/status every few seconds" the
 * portal already does for the PDF (#89) is reused as the trigger to check
 * Shotstack, lazily, only for a `storyboard-video` report still
 * `processing`. A render that's still queued/fetching/rendering/saving on
 * Shotstack's side is a no-op read; one that has finished (successfully or
 * not) is the one time this writes anything.
 */

const { Storage } = require('@google-cloud/storage');
const logger = require('./logger');

const SHOTSTACK_API_KEY = process.env.SHOTSTACK_API_KEY || '';
const SHOTSTACK_ENV = process.env.SHOTSTACK_ENV || 'stage'; // 'stage' is Shotstack's sandbox, 'v1' is production
// Confirmed against Shotstack's own dashboard/playground (2026-09-04): the
// real path is /edit/{env}/render, not /{env}/render as first guessed —
// api.shotstack.io/stage/render 404s, api.shotstack.io/edit/stage/render
// doesn't.
const SHOTSTACK_BASE_URL = process.env.SHOTSTACK_BASE_URL || `https://api.shotstack.io/edit/${SHOTSTACK_ENV}`;

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET || 'thehammer-storage-2026';

function nowISO() { return new Date().toISOString(); }

/**
 * Fails loudly rather than sending Shotstack an empty `x-api-key` and
 * surfacing whatever opaque error it hands back — the same "Server
 * misconfiguration" shape index.js already uses when GCS_BUCKET is unset,
 * rather than the silent-degrade Rule 7 ("No Phantom Infrastructure") warns
 * against.
 */
function requireApiKey() {
  if (!SHOTSTACK_API_KEY) {
    throw new Error('Server misconfiguration: SHOTSTACK_API_KEY not set');
  }
}

/** Posts a timeline to Shotstack's /render and returns the render id. */
async function submitRender(timeline) {
  requireApiKey();
  const res = await fetch(`${SHOTSTACK_BASE_URL}/render`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': SHOTSTACK_API_KEY,
    },
    body: JSON.stringify(timeline),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.success) {
    throw new Error(body?.message || `Shotstack render request failed (HTTP ${res.status})`);
  }
  return body.response.id;
}

async function fetchRenderStatus(renderId) {
  requireApiKey();
  const res = await fetch(`${SHOTSTACK_BASE_URL}/render/${renderId}`, {
    headers: { 'x-api-key': SHOTSTACK_API_KEY },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.success) {
    throw new Error(body?.message || `Shotstack status check failed (HTTP ${res.status})`);
  }
  return body.response;
}

// Shotstack's own vocabulary (queued/fetching/rendering/saving/done/failed)
// collapses onto the queued/processing/done/error the Reports poll already
// uses for the PDF — the portal doesn't need a second status vocabulary for
// a second reportType.
function mapShotstackStatus(shotstackStatus) {
  if (shotstackStatus === 'done') return 'done';
  if (shotstackStatus === 'failed') return 'error';
  return 'processing';
}

async function refreshVideoReportStatus(reportRef, data) {
  if (data.reportType !== 'storyboard-video' || data.status !== 'processing' || !data.shotstackRenderId) {
    return data;
  }

  try {
    const render = await fetchRenderStatus(data.shotstackRenderId);
    const mappedStatus = mapShotstackStatus(render.status);

    if (mappedStatus === 'processing') {
      return data; // still rendering on Shotstack's side — nothing to persist yet
    }

    if (mappedStatus === 'error') {
      const update = {
        status: 'error',
        error: render.error || 'Shotstack render failed',
        updatedAt: nowISO(),
      };
      await reportRef.update(update);
      return { ...data, ...update };
    }

    // Done: pull the rendered MP4 down and re-host it in theHammer's own
    // bucket — the PDF (#89) never hands the portal a third party's URL,
    // and the finished video shouldn't either.
    const videoRes = await fetch(render.url);
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
    const gcsPath = `${data.projectId}/reports/${reportRef.id}.mp4`;
    await storage.bucket(BUCKET).file(gcsPath).save(videoBuffer, {
      metadata: { contentType: 'video/mp4' },
    });

    const update = { status: 'done', gcsPath, updatedAt: nowISO() };
    await reportRef.update(update);
    return { ...data, ...update };
  } catch (err) {
    // Left as 'processing' — a genuine transient failure to reach Shotstack
    // (or to re-host the video) is retried on the next poll, not surfaced
    // as a permanent error the render itself never actually had.
    logger.error(`[Shotstack] status refresh failed for report ${reportRef.id}:`, err);
    return data;
  }
}

module.exports = {
  submitRender,
  fetchRenderStatus,
  mapShotstackStatus,
  refreshVideoReportStatus,
};
