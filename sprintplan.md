# The Hammer — Sprint Plan

## Overview

4 sprints, estimated 3–5 days each. Build order: extension shell → Cloud Run + GCS upload → direct signed URL upload → hardening and UX polish.

---

## Sprint 0 — Spec & Infrastructure Setup (1–2 days)

**Goal:** Lock the contract and provision all GCP resources before touching any code.

### Deliverables

- [ ] Confirm the three metadata fields: `project`, `tool`, `userName`
- [ ] Define object naming convention and sanitization rules (see `projectplan.md`)
- [ ] Choose Cloud region: `northamerica-northeast1` (Montréal)
- [ ] Choose auth strategy: API key via `X-Api-Key` header stored in Secret Manager
- [ ] Decide Chrome Web Store visibility: **Unlisted**
- [ ] Create GCP project; enable APIs: Cloud Run, Artifact Registry, Cloud Storage, Secret Manager
- [ ] Create GCS bucket: versioning off, lifecycle rule (delete after 90 days), region `northamerica-northeast1`
- [ ] Create service account `thehammer-backend` with `roles/storage.objectCreator` on bucket
- [ ] Store API key in Secret Manager; grant service account `roles/secretmanager.secretAccessor`
- [ ] Set up Artifact Registry repository for Docker images

### Acceptance Criteria

- Bucket accessible via `gsutil ls gs://thehammer-screenshots`
- Artifact Registry repo visible in GCP Console
- Secret Manager secret created and accessible by service account
- All required APIs enabled in the project

---

## Sprint 1 — Extension Shell (3–5 days)

**Goal:** Working extension that captures a screenshot and logs the data URL to the console. No backend yet.

### Deliverables

- [ ] `manifest.json` with MV3, `activeTab`, `storage`, `scripting`, `notifications` permissions
- [ ] `commands` key with `Ctrl+Shift+S` / `Command+Shift+S` shortcut
- [ ] Popup (`popup.html` + `popup.ts`) — save/load `project`, `tool`, `userName` via `chrome.storage.local`
- [ ] Service worker (`service-worker.ts`):
  - [ ] `chrome.commands.onCommand` listener
  - [ ] `chrome.action.onClicked` listener
  - [ ] `chrome.runtime.onMessage` listener (relay from content script)
  - [ ] Calls `chrome.tabs.captureVisibleTab({ format: 'png' })` on all three triggers
- [ ] Content script (`content.ts`) — injects floating capture button; click sends message to service worker
- [ ] Error handling: catches capture failure on `chrome://` pages, shows `chrome.notifications` error
- [ ] Console logs the PNG data URL on success

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

### Acceptance Criteria

- All three triggers (shortcut, toolbar button, floating button) produce a PNG data URL in the console
- Popup saves and reloads project/tool/name correctly across popup closes
- Failure on `chrome://newtab` shows a notification, does not crash

---

## Sprint 2 — Cloud Run Backend + GCS Upload (3–5 days)

**Goal:** End-to-end working upload — screenshot lands in Cloud Storage with the correct filename via a containerized Cloud Run service.

### Deliverables

#### Backend (`backend/`)
- [ ] Express.js app with `POST /capture` and `GET /health` routes
- [ ] `multer` middleware to parse `multipart/form-data`
- [ ] Validate required fields (`project`, `tool`, `name`); return 400 on missing
- [ ] Sanitize all fields: lowercase, strip non-`[a-z0-9_-]`, truncate to 64 chars
- [ ] Build object path: `{project}/{tool}/{yyyy}/{mm}/{dd}/{name}_{Date.now()}.png`
- [ ] Upload buffer to GCS using `@google-cloud/storage` `.file().save()`
- [ ] Validate `X-Api-Key` header against Secret Manager value; return 401 on mismatch
- [ ] Return JSON: `{ success: true, path: "...", size: N }`

#### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

#### Deploy commands (`infra/deploy.sh`)

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

#### Extension changes
- [ ] Convert data URL to `Blob` in service worker
- [ ] `fetch()` POST to Cloud Run URL with `multipart/form-data`: fields `project`, `tool`, `name`, image file
- [ ] Header: `X-Api-Key: {key}` — read from `chrome.storage.local`
- [ ] Show success notification with object path; show error notification on failure
- [ ] Store Cloud Run service URL in popup settings

### Acceptance Criteria

- Pressing shortcut → screenshot appears in GCS bucket at correct path within 5 seconds
- `GET /health` returns HTTP 200 (used for Cloud Run health check)
- Wrong or missing API key returns HTTP 401
- Missing required fields return HTTP 400
- Cloud Logging shows each upload request with timestamp and object path
- `docker build` succeeds locally before deploying

---

## Sprint 3 — Direct Signed URL Upload (3–4 days)

**Goal:** Reduce Cloud Run bandwidth by uploading the PNG directly from the extension to GCS via a signed URL. Cloud Run only issues the URL, not the image bytes.

> ⚠️ Only start this sprint after Sprint 2 is fully working end-to-end.

### Deliverables

#### Backend
- [ ] `POST /upload-url` endpoint — accepts `project`, `tool`, `name` JSON body
- [ ] Generates a **V4 signed PUT URL** for the computed object path (5–15 min expiry)
- [ ] Returns JSON: `{ signedUrl: "...", path: "..." }`
- [ ] Service account needs `roles/iam.serviceAccountTokenCreator` for self-signing

#### Bucket CORS config (`infra/cors.json`)

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

#### Extension changes
- [ ] On capture: POST `{ project, tool, name }` to `/upload-url` → receive signed URL
- [ ] PUT blob directly to GCS: `fetch(signedUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/png' } })`
- [ ] Use `XMLHttpRequest` instead of `fetch` if upload progress indicator is needed
- [ ] Fallback to `/capture` (Sprint 2 server-side path) if signed URL request fails

### Key Rules

- Always use **V4 signing** — V2 has a confirmed CORS bug with browser uploads
- Signed URL TTL: **5–15 minutes** — user-triggered, generated per capture, never pre-cached
- CORS `origin` must be `chrome-extension://YOUR_EXTENSION_ID`, not `*` in production
- Test CORS preflight with `curl -X OPTIONS` before wiring the extension

### Acceptance Criteria

- Image bytes go directly from extension to GCS (Cloud Run logs show no image data in `/upload-url` requests)
- CORS preflight `OPTIONS` returns 200 with correct `Access-Control-Allow-*` headers
- Signed URL expires and returns 403 after TTL
- Fallback to server-side upload works when `/upload-url` returns non-200

---

## Sprint 4 — Hardening & UX (3–5 days)

**Goal:** Production-ready reliability, retry logic, and optional history view.

### Deliverables

#### Extension
- [ ] Offline queue: persist pending uploads in `chrome.storage.local`; retry on next service worker wake
- [ ] Exponential backoff retry (max 3 attempts, 1s / 2s / 4s delays)
- [ ] Upload progress indicator (`XMLHttpRequest.upload.onprogress` — `fetch` does not expose upload progress)
- [ ] Settings page: configure Cloud Run URL, API key, default project/tool/name
- [ ] Optional history tab in popup: last N uploads with path, timestamp, status (from `chrome.storage.local`)

#### Backend
- [ ] Rate limiting middleware (e.g., 60 requests/IP/minute via `express-rate-limit`)
- [ ] Cloud Monitoring uptime check on `/health` endpoint
- [ ] Cloud Monitoring alert: error rate > 5% over 5 minutes
- [ ] Optional: Firestore write on each successful upload for searchable metadata

#### Firestore schema (optional)

```
uploads/{uploadId}
  project:    string
  tool:       string
  userName:   string
  gcsPath:    string
  tabUrl:     string
  timestamp:  timestamp
  fileSize:   number
  status:     "success" | "error"
```

#### Container hardening
- [ ] Pin base image to specific digest: `node:20-alpine@sha256:...`
- [ ] Run as non-root user in Dockerfile: `USER node`
- [ ] Add `.dockerignore` to exclude `node_modules`, `src/`, `.env`
- [ ] Set `--cpu-throttling` off if latency matters (optional)

### Acceptance Criteria

- Failed uploads are retried automatically on next browser session
- Cloud Monitoring dashboard shows request count, latency p95, and error rate
- All three triggers still work correctly after hardening changes
- Extension installable from a `.zip` via Chrome Developer Dashboard
- Container runs as non-root user

---

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| `captureVisibleTab` fails on `chrome://` pages | Medium | Catch error, show notification |
| Cloud Run cold start delays first capture | Low | ~500ms–2s; acceptable for internal tool. Set `--min-instances 1` if it becomes annoying |
| Service worker terminated mid-upload | Low | PNGs are small (<1 MB); upload completes in <1s |
| CORS misconfiguration blocks Sprint 3 uploads | High | Test with `curl -X OPTIONS` before wiring extension; fall back to server-side upload |
| Signed URL intercepted in transit | Medium | HTTPS enforced by Cloud Run; short TTL (5–15 min) limits exposure window |
| Object name collision | Low | Append `Date.now()` or `crypto.randomUUID()` to filename |
| Metadata fields contain illegal GCS path characters | Medium | Sanitize server-side; reject or strip before building object path |
| Container image vulnerability | Low | Pin to digest; run `docker scout` or Artifact Registry scanning |
| API key leaked in extension source | Medium | Store in `chrome.storage.local`, never hardcode in JS; rotate via Secret Manager |

---

## Backlog (Post-Sprint 4)

- Full-page scroll-and-stitch capture
- Chrome Web Store public listing
- Per-project GCS bucket isolation
- Slack / Teams webhook notification on upload
- Admin dashboard (simple Firestore-backed web app or Cloud Storage Browser)
- BigQuery export for usage analytics
- Cloud Run minimum instances 1 if cold start latency becomes a complaint
