# The Hammer — Sprint Plan

## Overview

4 sprints, estimated 3–5 days each. Build order: extension shell → Cloud Run + GCS upload → direct signed URL upload → hardening and UX polish.

Every task below has a **measurable pass/fail condition** listed beside it. A sprint is only complete when every task's condition is verified, not just coded.

---

## Sprint 0 — Spec & Infrastructure Setup (1–2 days)

**Goal:** Lock the contract and provision all GCP resources before touching any code.

### Deliverables

| # | Task | Done when | Success % |
|---|---|---|---|
| 0.1 | Confirm metadata fields: `project`, `tool`, `userName` | Written and agreed in `projectplan.md`; no open questions | 99% |
| 0.2 | Define object naming convention and sanitization rules | Naming pattern documented; 3 example paths written out and reviewed | 99% |
| 0.3 | Choose Cloud region: `northamerica-northeast1` (Montréal) | Region recorded in `projectplan.md` and used in all infra commands | 99% |
| 0.4 | Choose auth strategy: API key via `X-Api-Key` header stored in Secret Manager | Decision documented; no alternative left open | 99% |
| 0.5 | Decide Chrome Web Store visibility: **Unlisted** | Recorded in `projectplan.md` | 99% |
| 0.6 | Create GCP project; enable APIs: Cloud Run, Artifact Registry, Cloud Storage, Secret Manager | `gcloud services list` includes all 4 APIs | 97% |
| 0.7 | Create GCS bucket with versioning off, 90-day lifecycle rule, region `northamerica-northeast1` | `gcloud storage buckets describe` shows region and lifecycle | 97% |
| 0.8 | Create service account `thehammer-backend` with `roles/storage.objectCreator` on bucket | IAM policy on bucket lists SA with correct role | 97% |
| 0.9 | Store API key in Secret Manager; grant SA `roles/secretmanager.secretAccessor` | `gcloud secrets versions access latest` returns key value | 96% |
| 0.10 | Set up Artifact Registry Docker repository | Describe command shows `format: DOCKER` | 97% |

> **Note on 0.6:** `gsutil` commands are deprecated in favour of `gcloud storage`. All infra commands in this plan use `gcloud storage`.

---

## Sprint 1 — Extension Shell (3–5 days)

**Goal:** Working extension that captures a screenshot and logs the data URL to the console. No backend yet.

> **Architecture note — toolbar button vs. popup:**
> `chrome.action.onClicked` **does not fire when `default_popup` is set** in the manifest. Because the popup is always present (project/tool/name settings live there), the toolbar button click opens the popup — it cannot simultaneously trigger a capture. The three capture triggers are therefore: **(1) keyboard shortcut**, **(2) a dedicated "Capture Now" button inside the popup**, **(3) the floating page button injected by the content script**. Task 1.5 below reflects this correction.

### Deliverables

| # | Task | Done when | Success % |
|---|---|---|---|
| 1.1 | `manifest.json` with MV3, correct permissions | 0 errors in `chrome://extensions`, manifest version `3` visible | 98% |
| 1.2 | `commands` key with `Ctrl+Shift+S` / `Command+Shift+S` | Shortcut appears in `chrome://extensions/shortcuts`; logs `"command fired"` | 95% |
| 1.3 | Popup saves/loads `project`, `tool`, `userName` via `chrome.storage.local` | All 3 fields reload after popup closed and reopened | 97% |
| 1.4 | Service worker: `chrome.commands.onCommand` calls `captureVisibleTab` | Logs PNG data URL > 10,000 chars in service worker console | 95% |
| 1.5 | Popup "Capture Now" button sends `runtime.sendMessage` → service worker | Service worker receives message and logs PNG data URL | 94% |
| 1.6 | Service worker: `chrome.runtime.onMessage` relay from content script | Floating button message received; PNG data URL logged | 92% |
| 1.7 | Content script injects floating capture button | Button visible in DOM on any http/https page | 93% |
| 1.8 | Error handling on `chrome://` pages | `chrome.notifications` notification shown; no uncaught exception | 91% |
| 1.9 | PNG data URL is a real screenshot | Length > 10,000 chars; renders correctly when opened in new tab | 97% |

### Manifest Skeleton

```json
{
  "manifest_version": 3,
  "name": "The Hammer",
  "version": "0.1.0",
  "permissions": ["activeTab", "storage", "scripting", "notifications"],
  "commands": {
    "capture-screenshot": {
      "suggested_key": { "default": "Ctrl+Shift+S", "mac": "Command+Shift+S" },
      "description": "Capture and upload screenshot"
    }
  },
  "background": { "service_worker": "service-worker.js" },
  "action": { "default_popup": "popup.html" },
  "content_scripts": [{ "matches": ["<all_urls>"], "js": ["content.js"] }]
}
```

---

## Sprint 2 — Cloud Run Backend + GCS Upload (3–5 days)

**Goal:** End-to-end working upload — screenshot lands in Cloud Storage with the correct filename via a containerized Cloud Run service.

### Backend Deliverables

| # | Task | Done when | Success % |
|---|---|---|---|
| 2.1 | Express app with `POST /capture` and `GET /health` routes | `curl /health` returns HTTP 200 and `{ "status": "ok" }` | 97% |
| 2.2 | `multer` parses `multipart/form-data` | Valid upload returns 200; missing `file` field returns 400 | 95% |
| 2.3 | Validate required fields; return 400 on missing | Each missing field individually returns 400 with named error | 97% |
| 2.4 | Sanitize fields: lowercase, strip non-`[a-z0-9_-]`, truncate 64 chars | Object path contains sanitized values; 100-char input truncates to 64 | 95% |
| 2.5 | Build object path with timestamp | Object name matches regex `^[a-z0-9_-]+/.../[a-z0-9_-]+_\d+\.png$` | 96% |
| 2.6 | Upload buffer to GCS | Object appears in bucket within 5s of POST | 94% |
| 2.7 | Validate `X-Api-Key`; return 401 on mismatch | Missing or wrong key → 401; correct key → 200 | 97% |
| 2.8 | Return `{ success, path, size }` | Response matches GCS object metadata | 96% |

### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

### Deploy Commands (`infra/deploy.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="YOUR_GCP_PROJECT_ID"
REGION="northamerica-northeast1"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/thehammer/backend:latest"

# Authenticate Docker with Artifact Registry
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet

# Build and push image
docker build -t "$IMAGE" ./backend
docker push "$IMAGE"

# Deploy to Cloud Run
gcloud run deploy thehammer-backend \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 5 \
  --memory 256Mi \
  --timeout 30s \
  --set-secrets API_KEY=thehammer-api-key:latest \
  --service-account "thehammer-backend@$PROJECT_ID.iam.gserviceaccount.com"
```

### Extension Deliverables

| # | Task | Done when | Success % |
|---|---|---|---|
| 2.9 | Convert data URL to `Blob` in service worker | `blob instanceof Blob === true` and `blob.type === 'image/png'` | 96% |
| 2.10 | `fetch()` POST to Cloud Run with `X-Api-Key` header | Cloud Logging shows POST `/capture` HTTP 200 < 5s | 93% |
| 2.11 | Success notification shows GCS path | Notification `message` contains full GCS path string | 94% |
| 2.12 | Error notification on failure | Unreachable host shows error notification within 10s; no crash | 91% |
| 2.13 | Cloud Run URL configurable in popup settings | Changing URL in settings routes request to new service | 95% |

---

## Sprint 3 — Direct Signed URL Upload (3–4 days)

**Goal:** Reduce Cloud Run bandwidth by uploading the PNG directly from the extension to GCS via a V4 signed URL. Cloud Run issues the URL only — image bytes never pass through it.

> ⚠️ Only start this sprint after Sprint 2 is fully working end-to-end.

### Backend Deliverables

| # | Task | Done when | Success % |
|---|---|---|---|
| 3.1 | `POST /upload-url` accepts `{ project, tool, name }` JSON body | Returns HTTP 200 with `signedUrl` field | 95% |
| 3.2 | Generates V4 signed PUT URL, 10-minute expiry | `curl -X PUT` with PNG against URL returns 200; object appears in GCS | 91% |
| 3.3 | Returns `{ signedUrl, path }` | Both fields present and non-empty; path matches naming convention | 95% |
| 3.4 | SA has `roles/iam.serviceAccountTokenCreator` | IAM policy lists role; signing call does not throw 403 | 90% |

### Bucket CORS Config (`infra/cors.json`)

```json
[
  {
    "origin": ["chrome-extension://YOUR_EXTENSION_ID"],
    "method": ["PUT", "OPTIONS"],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 300
  }
]
```

Apply with:
```bash
gcloud storage buckets update gs://thehammer-screenshots --cors-file=infra/cors.json
```

Verify applied config:
```bash
gcloud storage buckets describe gs://thehammer-screenshots --format="json(cors)"
```

### Extension Deliverables

| # | Task | Done when | Success % |
|---|---|---|---|
| 3.5 | POST to `/upload-url` and receive signed URL | Service worker logs URL starting with `https://storage.googleapis.com/thehammer-screenshots/` | 92% |
| 3.6 | PUT blob directly to GCS signed URL | Object in GCS; Cloud Run logs show < 300 bytes body (no image bytes) | 88% |
| 3.7 | Fallback to `/capture` on `/upload-url` failure | Mock 500 from `/upload-url` → extension uses `/capture` path; object still lands in GCS | 90% |

### CORS Verification

| # | Check | Done when | Success % |
|---|---|---|---|
| 3.8 | CORS preflight passes | `curl -X OPTIONS` returns 200 with `Access-Control-Allow-Origin: chrome-extension://ID` | 85% |
| 3.9 | Signed URL expires correctly | After 10-min TTL, `curl -X PUT` returns HTTP 403 with `<Code>ExpiredToken</Code>` | 93% |

---

## Sprint 4 — Hardening & UX (3–5 days)

**Goal:** Production-ready reliability, retry logic, and optional history view.

### Extension Deliverables

| # | Task | Done when | Success % |
|---|---|---|---|
| 4.1 | Offline queue persisted in `chrome.storage.local` | 2 queued entries visible in storage; both upload on restore | 88% |
| 4.2 | Exponential backoff retry (max 3 attempts, 1s/2s/4s) | 3 attempt logs with correct delays; 3rd failure → `failed` state | 87% |
| 4.3 | Upload progress via `XMLHttpRequest.upload.onprogress` | Progress bar updates 0–100% for ≥ 100 KB PNG | 85% |
| 4.4 | Settings page persists all 5 fields across browser restart | All 5 fields reload after full Chrome restart | 95% |
| 4.5 | History tab shows last 20 uploads; oldest drops off at 21 | After 21 captures, exactly 20 rows; oldest gone; each row has path, timestamp, status | 86% |

### Backend Deliverables

| # | Task | Done when | Success % |
|---|---|---|---|
| 4.6 | Rate limiting: 60 req/IP/min via `express-rate-limit` | Requests 61–65 return HTTP 429 with `retryAfter` field | 93% |
| 4.7 | Cloud Monitoring uptime check on `/health` | Stopping Cloud Run causes alert email within 2 minutes | 91% |
| 4.8 | Alert: error rate > 5% over 5 minutes | Alerting policy fires incident within 5 min when 6/10 requests return 500 | 87% |
| 4.9 | Firestore write on upload (optional) | Each upload creates document in `uploads/{uploadId}` with 8 non-null fields | 89% |

### Container Hardening Deliverables

| # | Task | Done when | Success % |
|---|---|---|---|
| 4.10 | Pin base image to digest | `FROM node:20-alpine@sha256:DIGEST`; build succeeds | 96% |
| 4.11 | Run as non-root user | `docker run --entrypoint whoami IMAGE` outputs `node` | 97% |
| 4.12 | `.dockerignore` excludes dev files | `docker run IMAGE ls /app` does not show `src/` or `node_modules/` | 96% |

---

## Success Probability Summary

| Sprint | Description | Avg Task % | Sprint-level Completion % |
|---|---|---|---|
| Sprint 0 | Spec & Infrastructure | 98% | **97%** |
| Sprint 1 | Extension Shell | 95% | **88%** |
| Sprint 2 | Cloud Run + GCS Upload | 95% | **82%** |
| Sprint 3 | Direct Signed URL Upload | 91% | **72%** |
| Sprint 4 | Hardening & UX | 91% | **70%** |
| **Full project end-to-end** | All sprints complete and working | — | **~55–60%** |

> Sprint-level completion % = product of all task probabilities in that sprint.
> Full project % = product of all sprint-level probabilities.
> The biggest risk driver is Sprint 3 CORS/signed URL configuration (tasks 3.6, 3.8) and Sprint 4 queue/retry UX (tasks 4.2, 4.3). Completing Sprint 2 (server-side upload) alone delivers ~82% of the core value.

---

## Sprint Completion Gates

A sprint is **not done** until all of the following are true:

| Gate | Sprint 0 | Sprint 1 | Sprint 2 | Sprint 3 | Sprint 4 |
|---|---|---|---|---|---|
| All tasks verified against their Done When condition | ✓ | ✓ | ✓ | ✓ | ✓ |
| No open TODO comments in committed code | — | ✓ | ✓ | ✓ | ✓ |
| All three capture triggers work end-to-end | — | ✓ (console only) | ✓ (GCS upload) | ✓ (direct upload) | ✓ (with retry) |
| Previous sprint's acceptance criteria still pass (regression check) | — | — | ✓ | ✓ | ✓ |

---

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| `captureVisibleTab` fails on `chrome://` pages | Medium | Catch the rejected promise; show `chrome.notifications` alert (task 1.8) |
| `chrome.action.onClicked` silently never fires | High — **already fixed** | Popup button sends `runtime.sendMessage` instead; `onClicked` is not used (see Sprint 1 architecture note) |
| Cloud Run cold start delays first capture | Low | ~500ms–2s acceptable for internal tool; set `--min-instances 1` if team complaints arise |
| Service worker terminated mid-upload | Low | PNGs typically < 1 MB; upload completes in < 2s; retry queue handles any edge case (task 4.1) |
| CORS misconfiguration blocks Sprint 3 uploads | High | Verify with `curl -X OPTIONS` before wiring extension (task 3.8); fallback to `/capture` in place (task 3.7) |
| Signed URL intercepted in transit | Medium | HTTPS enforced by GCS; 10-minute TTL limits exposure window |
| Object name collision | Low | `Date.now()` epoch suffix on every filename (task 2.5) |
| Metadata fields contain illegal GCS path characters | Medium | Server-side regex sanitization before path construction (task 2.4) |
| Container running as root | Medium — **fixed in plan** | `USER node` in Dockerfile (task 4.11) |
| API key readable by any extension user | Medium | Acceptable for 5 trusted internal users; rotate via Secret Manager if team grows |

---

## Backlog (Post-Sprint 4)

- Full-page scroll-and-stitch capture
- Chrome Web Store public listing
- Per-project GCS bucket isolation
- Slack / Teams webhook notification on upload
- Admin dashboard (Firestore-backed web app or Cloud Storage Browser)
- BigQuery export for usage analytics
- Cloud Run `--min-instances 1` if cold start latency becomes a complaint
