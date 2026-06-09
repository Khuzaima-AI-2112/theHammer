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
| 0.4 | Choose auth strategy: API key via `X-Api-Key` + Secret Manager | Decision documented; no alternative left open |
| 0.5 | Decide Chrome Web Store visibility: **Unlisted** | Recorded in `projectplan.md` |
| 0.6 | Create GCP project; enable APIs: Cloud Run, Artifact Registry, Cloud Storage, Secret Manager | `gcloud services list --enabled` shows all 4 APIs active |
| 0.7 | Create GCS bucket with versioning off, 90-day lifecycle rule, region `northamerica-northeast1` | `gsutil ls gs://thehammer-screenshots` exits 0; lifecycle rule visible in GCP Console |
| 0.8 | Create service account `thehammer-backend` with `roles/storage.objectCreator` on bucket | `gsutil iam get gs://thehammer-screenshots` shows the binding |
| 0.9 | Store API key in Secret Manager; grant SA `roles/secretmanager.secretAccessor` | `gcloud secrets versions access latest --secret=thehammer-api-key` returns the key value |
| 0.10 | Set up Artifact Registry repository for Docker images | `gcloud artifacts repositories list` shows `thehammer` repo in `northamerica-northeast1` |

---

## Sprint 1 — Extension Shell (3–5 days)

**Goal:** Working extension that captures a screenshot and logs the data URL to the console. No backend yet.

### Deliverables

| # | Task | Done when |
|---|---|---|
| 1.1 | `manifest.json` with MV3, correct permissions | `chrome://extensions` loads the extension with 0 errors; manifest version shows `3` |
| 1.2 | `commands` key with `Ctrl+Shift+S` / `Command+Shift+S` | Shortcut appears in `chrome://extensions/shortcuts`; pressing it fires the command event |
| 1.3 | Popup saves/loads `project`, `tool`, `userName` via `chrome.storage.local` | Close and reopen popup → all 3 fields retain their values across popup close |
| 1.4 | Service worker: `chrome.commands.onCommand` listener | Pressing shortcut logs PNG data URL (starts with `data:image/png;base64,`) to service worker console |
| 1.5 | Service worker: `chrome.action.onClicked` listener | Clicking toolbar icon logs PNG data URL to service worker console |
| 1.6 | Service worker: `chrome.runtime.onMessage` relay from content script | Message from content script triggers `captureVisibleTab` and logs PNG data URL |
| 1.7 | Content script injects floating capture button | Button is visible on any `http/https` page; clicking it sends message to service worker |
| 1.8 | Error handling on `chrome://` pages | Attempting capture on `chrome://newtab` shows a Chrome notification with error text; service worker does not crash; no unhandled promise rejection in console |
| 1.9 | Console logs PNG data URL on success | Data URL length > 10,000 characters (confirms non-trivial image, not a blank frame) |

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
| 2.1 | Express app with `POST /capture` and `GET /health` | `curl https://SERVICE_URL/health` returns HTTP 200 and `{ status: "ok" }` |
| 2.2 | `multer` parses `multipart/form-data` | Sending a form with all fields + PNG file returns 200; sending without the file returns 400 |
| 2.3 | Validate required fields; return 400 on missing | Omitting `project`, `tool`, or `name` individually each returns `HTTP 400` with a descriptive error message |
| 2.4 | Sanitize fields: lowercase, strip non-`[a-z0-9_-]`, truncate to 64 chars | Input `"My Project!!"` produces object path segment `my-project` (or `my_project`); field longer than 64 chars is truncated to exactly 64 |
| 2.5 | Build object path with timestamp | Path matches `{project}/{tool}/{yyyy}/{mm}/{dd}/{name}_{epoch}.png`; verified by checking GCS object name after a test upload |
| 2.6 | Upload buffer to GCS via `@google-cloud/storage` | Object appears in bucket within 3 seconds of the POST; `gsutil ls gs://thehammer-screenshots/...` confirms it |
| 2.7 | Validate `X-Api-Key`; return 401 on mismatch | Request without header → HTTP 401; request with wrong key → HTTP 401; correct key → HTTP 200 |
| 2.8 | Return `{ success: true, path, size }` | Response body contains all 3 fields; `size` matches the byte count of the uploaded file in GCS |

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

### Deploy commands (`infra/deploy.sh`)

```bash
# Build and push image
docker build -t northamerica-northeast1-docker.pkg.dev/PROJECT_ID/thehammer/backend:latest ./backend
docker push northamerica-northeast1-docker.pkg.dev/PROJECT_ID/thehammer/backend:latest

# Deploy to Cloud Run
gcloud run deploy thehammer-backend \
  --image northamerica-northeast1-docker.pkg.dev/PROJECT_ID/thehammer/backend:latest \
  --region northamerica-northeast1 \
  --platform managed \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 5 \
  --memory 256Mi \
  --set-secrets API_KEY=thehammer-api-key:latest \
  --service-account thehammer-backend@PROJECT_ID.iam.gserviceaccount.com
```

### Extension Deliverables

| # | Task | Done when |
|---|---|---|
| 2.9 | Convert data URL to `Blob` in service worker | `typeof blob === 'object'` and `blob.type === 'image/png'` confirmed via console before POST |
| 2.10 | `fetch()` POST to Cloud Run with correct fields and `X-Api-Key` header | Cloud Run logs show request with all 3 metadata fields and correct content-type |
| 2.11 | Success notification shows GCS object path | Notification body contains the full path string (e.g. `website-redesign/figma/2026/...`) |
| 2.12 | Error notification on failure | Killing the Cloud Run service and triggering capture shows a notification with error text within 5 seconds |
| 2.13 | Cloud Run URL stored in popup settings | Changing URL in settings and triggering capture hits the new URL (verified in Cloud Logging) |

---

## Sprint 3 — Direct Signed URL Upload (3–4 days)

**Goal:** Reduce Cloud Run bandwidth by uploading the PNG directly from the extension to GCS via a signed URL.

> ⚠️ Only start this sprint after Sprint 2 is fully working end-to-end.

### Backend Deliverables

| # | Task | Done when |
|---|---|---|
| 3.1 | `POST /upload-url` endpoint | `curl -X POST` with valid JSON body returns HTTP 200 and a `signedUrl` field starting with `https://storage.googleapis.com/` |
| 3.2 | Generates V4 signed PUT URL with 5–15 min expiry | URL contains `X-Goog-Signature` parameter; a `PUT` to it with a PNG body returns HTTP 200 and the object appears in GCS |
| 3.3 | Returns `{ signedUrl, path }` | Both fields present in response; `path` matches the expected naming convention |
| 3.4 | SA has `roles/iam.serviceAccountTokenCreator` | Signing does not throw a permissions error; verified by checking IAM bindings in GCP Console |

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

### Extension Deliverables

| # | Task | Done when |
|---|---|---|
| 3.5 | POST to `/upload-url` and receive signed URL | Service worker logs signed URL string; URL is non-empty and starts with `https://storage.googleapis.com` |
| 3.6 | PUT blob directly to GCS signed URL | Object appears in GCS bucket; Cloud Run logs for `/upload-url` show no image bytes (request body < 500 bytes) |
| 3.7 | Fallback to `/capture` on signed URL failure | Simulating a 500 from `/upload-url` → extension automatically falls back to Sprint 2 server-side path; object still lands in GCS |

### CORS Verification

| # | Check | Done when |
|---|---|---|
| 3.8 | CORS preflight passes | `curl -X OPTIONS -H "Origin: chrome-extension://YOUR_ID" -H "Access-Control-Request-Method: PUT"` returns HTTP 200 with `Access-Control-Allow-Origin` header matching the extension origin |
| 3.9 | Signed URL expires correctly | Waiting past TTL and then attempting PUT returns HTTP 403 |

---

## Sprint 4 — Hardening & UX (3–5 days)

**Goal:** Production-ready reliability, retry logic, and optional history view.

### Extension Deliverables

| # | Task | Done when |
|---|---|---|
| 4.1 | Offline queue persisted in `chrome.storage.local` | Trigger capture while Cloud Run is down → entry appears in storage; when service is restored, upload completes automatically on next trigger or browser restart |
| 4.2 | Exponential backoff retry (max 3, delays 1s / 2s / 4s) | Console logs show 3 attempts at correct intervals before giving up; total wait time ≈ 7 seconds |
| 4.3 | Upload progress indicator | Progress bar or % visible in popup during upload; reaches 100% before success notification fires |
| 4.4 | Settings page with URL, API key, defaults | All 5 fields (URL, key, project, tool, name) persist across browser restart; changing any field is reflected on next capture |
| 4.5 | History tab shows last N uploads | After 5 captures, history shows 5 rows with path, timestamp, and status; oldest entry drops off after exceeding N limit |

### Backend Deliverables

| # | Task | Done when |
|---|---|---|
| 4.6 | Rate limiting: 60 requests/IP/minute | Sending 61 requests in 60 seconds returns HTTP 429 on the 61st; rate limit resets after 60 seconds |
| 4.7 | Cloud Monitoring uptime check on `/health` | Uptime check configured in GCP Console; fires alert if `/health` returns non-200 for > 2 consecutive minutes |
| 4.8 | Alert: error rate > 5% over 5 minutes | Manually triggering 6+ errors in 5 minutes creates an incident in Cloud Monitoring |
| 4.9 | Firestore write on upload (optional) | Each successful upload creates a document in `uploads/` collection with all 8 schema fields populated and non-null |

### Container Hardening Deliverables

| # | Task | Done when |
|---|---|---|
| 4.10 | Pin base image to digest | `Dockerfile` `FROM` line contains `@sha256:` digest; `docker build` succeeds with pinned digest |
| 4.11 | Run as non-root user | `docker run --rm IMAGE whoami` outputs `node`, not `root` |
| 4.12 | `.dockerignore` excludes `node_modules`, `src/`, `.env` | `docker build` context size < 500 KB (confirm with `docker build --no-cache 2>&1 | grep "Sending build context"`) |

---

## Sprint Completion Gates

A sprint is **not done** until all of the following are true:

| Gate | Sprint 0 | Sprint 1 | Sprint 2 | Sprint 3 | Sprint 4 |
|---|---|---|---|---|---|
| All tasks verified against their Done When condition | ✓ | ✓ | ✓ | ✓ | ✓ |
| No open TODO comments in committed code | — | ✓ | ✓ | ✓ | ✓ |
| All three capture triggers work end-to-end | — | ✓ (console only) | ✓ (GCS upload) | ✓ (direct upload) | ✓ (with retry) |
| Previous sprint's acceptance criteria still pass | — | — | ✓ | ✓ | ✓ |

---

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| `captureVisibleTab` fails on `chrome://` pages | Medium | Catch error, show notification (task 1.8) |
| Cloud Run cold start delays first capture | Low | ~500ms–2s acceptable; set `--min-instances 1` if complaints arise |
| Service worker terminated mid-upload | Low | PNGs < 1 MB; upload completes in < 1s; retry queue added in Sprint 4 |
| CORS misconfiguration blocks Sprint 3 uploads | High | Verify with `curl -X OPTIONS` before wiring extension (task 3.8); fallback to server-side upload (task 3.7) |
| Signed URL intercepted in transit | Medium | HTTPS enforced by Cloud Run; short TTL (5–15 min) limits exposure |
| Object name collision | Low | `Date.now()` suffix on every filename (task 2.5) |
| Metadata fields contain illegal GCS path characters | Medium | Server-side sanitization (task 2.4) |
| Container image vulnerability | Low | Pin to digest (task 4.10); enable Artifact Registry scanning |
| API key leaked in extension source | Medium | Store in `chrome.storage.local` only; rotate via Secret Manager |

---

## Backlog (Post-Sprint 4)

- Full-page scroll-and-stitch capture
- Chrome Web Store public listing
- Per-project GCS bucket isolation
- Slack / Teams webhook notification on upload
- Admin dashboard (Firestore-backed web app or Cloud Storage Browser)
- BigQuery export for usage analytics
- Cloud Run minimum instances 1 if cold start latency becomes a complaint
