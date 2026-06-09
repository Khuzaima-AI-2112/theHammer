# The Hammer — Sprint Plan

## Overview

4 sprints, estimated 3–5 days each. Build order: extension shell → Cloud Run + GCS upload → direct signed URL upload → hardening and UX polish.

Every task below has a **measurable pass/fail condition** listed beside it. A sprint is only complete when every task's condition is verified, not just coded.

---

## Sprint 0 — Spec & Infrastructure Setup (1–2 days)

**Goal:** Lock the contract and provision all GCP resources before touching any code.

### Deliverables

| # | Task | Done when |
|---|---|---|
| 0.1 | Confirm metadata fields: `project`, `tool`, `userName` | Written and agreed in `projectplan.md`; no open questions |
| 0.2 | Define object naming convention and sanitization rules | Naming pattern documented; 3 example paths written out and reviewed |
| 0.3 | Choose Cloud region: `northamerica-northeast1` (Montréal) | Region recorded in `projectplan.md` and used in all infra commands |
| 0.4 | Choose auth strategy: API key via `X-Api-Key` header stored in Secret Manager | Decision documented; no alternative left open |
| 0.5 | Decide Chrome Web Store visibility: **Unlisted** | Recorded in `projectplan.md` |
| 0.6 | Create GCP project; enable APIs: Cloud Run, Artifact Registry, Cloud Storage, Secret Manager | `gcloud services list --enabled --project=PROJECT_ID` output includes `run.googleapis.com`, `artifactregistry.googleapis.com`, `storage.googleapis.com`, `secretmanager.googleapis.com` |
| 0.7 | Create GCS bucket with versioning off, 90-day lifecycle rule, region `northamerica-northeast1` | `gcloud storage ls gs://thehammer-screenshots` exits 0; `gcloud storage buckets describe gs://thehammer-screenshots` shows `location: NORTHAMERICA-NORTHEAST1` and lifecycle rule present |
| 0.8 | Create service account `thehammer-backend` with `roles/storage.objectCreator` on bucket | `gcloud storage buckets get-iam-policy gs://thehammer-screenshots` output includes `serviceAccount:thehammer-backend@PROJECT_ID.iam.gserviceaccount.com` with role `roles/storage.objectCreator` |
| 0.9 | Store API key in Secret Manager; grant SA `roles/secretmanager.secretAccessor` | `gcloud secrets versions access latest --secret=thehammer-api-key --project=PROJECT_ID` returns the key value without error |
| 0.10 | Set up Artifact Registry Docker repository | `gcloud artifacts repositories describe thehammer --location=northamerica-northeast1 --project=PROJECT_ID` shows `format: DOCKER` |

> **Note on 0.6:** `gsutil` commands are deprecated in favour of `gcloud storage`. All infra commands in this plan use `gcloud storage`.

---

## Sprint 1 — Extension Shell (3–5 days)

**Goal:** Working extension that captures a screenshot and logs the data URL to the console. No backend yet.

> **Architecture note — toolbar button vs. popup:**
> `chrome.action.onClicked` **does not fire when `default_popup` is set** in the manifest. Because the popup is always present (project/tool/name settings live there), the toolbar button click opens the popup — it cannot simultaneously trigger a capture. The three capture triggers are therefore: **(1) keyboard shortcut**, **(2) a dedicated "Capture Now" button inside the popup**, **(3) the floating page button injected by the content script**. Task 1.5 below reflects this correction.

### Deliverables

| # | Task | Done when |
|---|---|---|
| 1.1 | `manifest.json` with MV3, correct permissions | Loading the unpacked extension at `chrome://extensions` shows 0 errors and manifest version `3` in the extension card |
| 1.2 | `commands` key with `Ctrl+Shift+S` / `Command+Shift+S` | Shortcut appears in `chrome://extensions/shortcuts`; pressing it logs `"command fired"` to the service worker console (open via `chrome://extensions` → service worker "inspect") |
| 1.3 | Popup saves/loads `project`, `tool`, `userName` via `chrome.storage.local` | Fill all 3 fields → close popup → reopen popup → all 3 fields show the saved values. Verify in DevTools: `chrome.storage.local.get(null, console.log)` in the popup console shows the 3 keys |
| 1.4 | Service worker: `chrome.commands.onCommand` listener calls `captureVisibleTab` | Pressing shortcut logs a data URL beginning with `data:image/png;base64,` and length > 10,000 chars to the service worker console |
| 1.5 | Popup "Capture Now" button triggers capture | Clicking the button inside the popup logs a PNG data URL to the service worker console. **Note:** `chrome.action.onClicked` is not used because `default_popup` is set — the popup button sends a `chrome.runtime.sendMessage({ type: 'capture' })` message to the service worker instead |
| 1.6 | Service worker: `chrome.runtime.onMessage` relay from content script | Clicking the floating page button sends a message; service worker receives it and logs PNG data URL |
| 1.7 | Content script injects floating capture button | Button element is visible in the DOM on any `http://` or `https://` page; confirmed via DevTools Elements panel; button has a distinct `id` or `data-` attribute to avoid conflicts with page styles |
| 1.8 | Error handling on `chrome://` pages | Attempting capture on `chrome://newtab` shows a `chrome.notifications` notification with non-empty `message` text; service worker console shows no uncaught exception; background page remains alive |
| 1.9 | PNG data URL is a real screenshot | Data URL length > 10,000 characters; opening the data URL in a new tab renders a recognisable image of the captured page |

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

| # | Task | Done when |
|---|---|---|
| 2.1 | Express app with `POST /capture` and `GET /health` routes | `curl https://SERVICE_URL/health` returns HTTP 200 and JSON body `{ "status": "ok" }` |
| 2.2 | `multer` parses `multipart/form-data` | `curl -F project=test -F tool=figma -F name=alice -F file=@test.png https://SERVICE_URL/capture` with valid API key returns HTTP 200; sending the same request without the `file` field returns HTTP 400 |
| 2.3 | Validate required fields; return 400 on missing | Omitting `project`, `tool`, or `name` individually each returns HTTP 400 with a JSON body containing a non-empty `error` string describing which field is missing |
| 2.4 | Sanitize fields: lowercase, strip non-`[a-z0-9_-]`, truncate to 64 chars | Sending `project="My Project!!"` produces an object path segment `my-project` or `my_project` (consistent with the sanitizer); sending a field of 100 characters produces a path segment of exactly 64 characters — verified by inspecting the GCS object name |
| 2.5 | Build object path with timestamp | GCS object name matches the regex `^[a-z0-9_-]+/[a-z0-9_-]+/\d{4}/\d{2}/\d{2}/[a-z0-9_-]+_\d+\.png$`; verified by `gcloud storage ls --recursive gs://thehammer-screenshots/` after a test upload |
| 2.6 | Upload buffer to GCS | Object appears in bucket within 5 seconds of the POST; `gcloud storage ls gs://thehammer-screenshots/PROJECT/TOOL/YYYY/MM/DD/` lists the file |
| 2.7 | Validate `X-Api-Key`; return 401 on mismatch | `curl` without `X-Api-Key` header → HTTP 401; with wrong key value → HTTP 401; with correct key → HTTP 200 |
| 2.8 | Return `{ success: true, path, size }` | Response JSON contains `success: true`, a `path` string matching the GCS object name, and a `size` integer equal to the file's byte count confirmed by `gcloud storage objects describe gs://thehammer-screenshots/PATH --format="value(size)"` |

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

| # | Task | Done when |
|---|---|---|
| 2.9 | Convert data URL to `Blob` in service worker | In the service worker console: `blob instanceof Blob === true` and `blob.type === 'image/png'` logged before the POST fires |
| 2.10 | `fetch()` POST to Cloud Run with correct fields and `X-Api-Key` header | Cloud Run logs (Cloud Logging → `run.googleapis.com/requests`) show a POST to `/capture` with HTTP 200 and response time < 5s |
| 2.11 | Success notification shows GCS object path | `chrome.notifications` notification appears with a `message` field containing the full GCS path string (e.g. `project/figma/2026/06/08/alice_1749430800000.png`) |
| 2.12 | Error notification on failure | Scale Cloud Run to 0 manually or point URL to a bad host; triggering capture shows a notification with non-empty error text within 10 seconds; no uncaught exception in service worker |
| 2.13 | Cloud Run URL configurable in popup settings | Update the URL field in settings to a second test Cloud Run service; trigger capture; Cloud Logging on the second service shows the request |

---

## Sprint 3 — Direct Signed URL Upload (3–4 days)

**Goal:** Reduce Cloud Run bandwidth by uploading the PNG directly from the extension to GCS via a V4 signed URL. Cloud Run issues the URL only — image bytes never pass through it.

> ⚠️ Only start this sprint after Sprint 2 is fully working end-to-end.

### Backend Deliverables

| # | Task | Done when |
|---|---|---|
| 3.1 | `POST /upload-url` endpoint accepts `{ project, tool, name }` JSON body | `curl -X POST -H "Content-Type: application/json" -H "X-Api-Key: KEY" -d '{"project":"p","tool":"t","name":"n"}' https://SERVICE_URL/upload-url` returns HTTP 200 and JSON with a `signedUrl` field |
| 3.2 | Generates V4 signed PUT URL with 10-minute expiry | The returned URL contains the query parameter `X-Goog-Signature`; a `curl -X PUT -H "Content-Type: image/png" --data-binary @test.png "SIGNED_URL"` returns HTTP 200 and the object appears in GCS |
| 3.3 | Returns `{ signedUrl, path }` | Both fields present and non-empty; `path` matches the same naming convention verified in task 2.5 |
| 3.4 | SA has `roles/iam.serviceAccountTokenCreator` | `gcloud projects get-iam-policy PROJECT_ID --flatten="bindings[].members" --filter="bindings.members:thehammer-backend"` lists `roles/iam.serviceAccountTokenCreator`; signing call does not throw a 403 |

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

| # | Task | Done when |
|---|---|---|
| 3.5 | POST to `/upload-url` and receive signed URL | Service worker logs the signed URL string; URL starts with `https://storage.googleapis.com/thehammer-screenshots/` |
| 3.6 | PUT blob directly to GCS signed URL | Object appears in GCS; Cloud Run logs show `/upload-url` request body size < 300 bytes (metadata only — no image bytes); GCS object size matches the original PNG blob size |
| 3.7 | Fallback to `/capture` on `/upload-url` failure | Mock a non-200 from `/upload-url` (e.g. temporarily return 500 from backend); extension falls back to Sprint 2 `/capture` path; object still lands in GCS; Cloud Logging confirms the `/capture` request was made |

### CORS Verification

| # | Check | Done when |
|---|---|---|
| 3.8 | CORS preflight passes | `curl -s -o /dev/null -w "%{http_code}" -X OPTIONS -H "Origin: chrome-extension://YOUR_EXTENSION_ID" -H "Access-Control-Request-Method: PUT" -H "Access-Control-Request-Headers: Content-Type" "SIGNED_URL"` returns `200` (GCS returns 200, not 204, for OPTIONS on signed URLs); response includes `Access-Control-Allow-Origin: chrome-extension://YOUR_EXTENSION_ID` |
| 3.9 | Signed URL expires correctly | Wait until after the 10-minute TTL; `curl -X PUT -H "Content-Type: image/png" --data-binary @test.png "SIGNED_URL"` returns HTTP 403 with an XML body containing `<Code>ExpiredToken</Code>` or `<Code>AccessDenied</Code>` |

---

## Sprint 4 — Hardening & UX (3–5 days)

**Goal:** Production-ready reliability, retry logic, and optional history view.

### Extension Deliverables

| # | Task | Done when |
|---|---|---|
| 4.1 | Offline queue persisted in `chrome.storage.local` | With Cloud Run URL set to an unreachable host, trigger 2 captures; `chrome.storage.local.get('queue', console.log)` shows 2 pending entries; restore the real URL and trigger any capture (or reload the extension); both queued uploads complete and appear in GCS |
| 4.2 | Exponential backoff retry (max 3 attempts, delays 1s / 2s / 4s) | Service worker console shows 3 timestamped attempt logs; time between attempt 1→2 ≈ 1s, 2→3 ≈ 2s; after the 3rd failure the entry moves to a `failed` state in storage |
| 4.3 | Upload progress indicator via `XMLHttpRequest.upload.onprogress` | A progress bar or percentage label in the popup updates from 0% to 100% during an upload of a ≥ 100 KB PNG; `fetch` is **not** used for this request because it does not expose upload progress |
| 4.4 | Settings page persists all 5 fields across browser restart | Fill Cloud Run URL, API key, project, tool, name → quit Chrome completely → relaunch → open popup → all 5 fields show saved values; confirmed by `chrome.storage.local.get(null, console.log)` |
| 4.5 | History tab shows last 20 uploads; oldest drops off at limit | After 21 captures, the history tab shows exactly 20 rows; the 21st capture's entry is present and the oldest is gone; each row shows GCS path, ISO timestamp, and status (`success` or `failed`) |

### Backend Deliverables

| # | Task | Done when |
|---|---|---|
| 4.6 | Rate limiting: 60 requests/IP/minute via `express-rate-limit` | `for i in $(seq 1 65); do curl -s -o /dev/null -w "%{http_code}\n" -X POST ... ; done` — first 60 return 200, requests 61–65 return HTTP 429 with a JSON body containing a `retryAfter` field |
| 4.7 | Cloud Monitoring uptime check on `/health` | Uptime check visible in Cloud Monitoring → Uptime checks; manually stopping the Cloud Run service causes the check to fail within 2 minutes and an email alert fires |
| 4.8 | Alert: error rate > 5% over 5 minutes | A Cloud Monitoring alerting policy exists targeting the `run.googleapis.com/request_count` metric filtered to `response_code_class=5xx`; manually sending 10 requests of which 6 return 500 triggers an incident within 5 minutes |
| 4.9 | Firestore write on upload (optional) | Each successful `/capture` or signed URL upload creates a document in `uploads/{uploadId}` with all 8 fields non-null; `gcloud firestore documents list --collection-id=uploads --project=PROJECT_ID` lists the document |

### Container Hardening Deliverables

| # | Task | Done when |
|---|---|---|
| 4.10 | Pin base image to digest | `Dockerfile` `FROM` line is `node:20-alpine@sha256:DIGEST`; `docker build` succeeds; the digest can be retrieved with `docker pull node:20-alpine && docker inspect node:20-alpine --format='{{index .RepoDigests 0}}'` |
| 4.11 | Run as non-root user | `Dockerfile` contains `USER node` before the `CMD` line; `docker run --rm --entrypoint whoami IMAGE` outputs `node` |
| 4.12 | `.dockerignore` excludes dev files | `.dockerignore` lists `node_modules`, `src/`, `.env`, `*.test.ts`; after `docker build`, `docker run --rm IMAGE ls /app` does not show `src/` or `node_modules/` directories |

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
