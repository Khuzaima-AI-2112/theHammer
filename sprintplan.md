# The Hammer — Sprint Plan

## Overview

4 sprints, estimated 3–5 days each. Build order: extension shell → Cloud Function + GCS upload → direct signed URL upload → hardening and UX polish.

---

## Sprint 0 — Spec & Security (1–2 days)

**Goal:** Lock the contract before touching any code.

### Deliverables

- [ ] Confirm the three metadata fields: `project`, `tool`, `userName`
- [ ] Define object naming convention and sanitization rules (see `projectplan.md`)
- [ ] Choose Cloud region (Montreal `northamerica-northeast1` recommended for location)
- [ ] Choose auth strategy: API key via `X-Api-Key` header stored in Secret Manager
- [ ] Decide Chrome Web Store visibility: **Unlisted**
- [ ] Create GCS bucket with versioning off, lifecycle rule: delete after N days
- [ ] Create GCP project, enable APIs: Cloud Functions, Cloud Storage, Secret Manager
- [ ] Create service account with `roles/storage.objectCreator` on the bucket

### Acceptance Criteria

- Bucket exists and accessible via `gsutil ls`
- Service account key stored in Secret Manager
- Naming convention documented and agreed

---

## Sprint 1 — Extension Shell (3–5 days)

**Goal:** Working extension that captures a screenshot and logs the data URL to the console.

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

## Sprint 2 — Cloud Function + GCS Upload (3–5 days)

**Goal:** End-to-end working upload — screenshot lands in Cloud Storage with correct filename.

### Deliverables

#### Extension changes
- [ ] Convert data URL to `Blob` in service worker
- [ ] `fetch()` POST to Cloud Function endpoint with `multipart/form-data`:
  - Fields: `project`, `tool`, `name`, image file
  - Header: `X-Api-Key: {secret}`
- [ ] Read API key from `chrome.storage.local` (set once in popup settings)
- [ ] Show success notification with object path; show error notification on failure

#### Backend (`backend/index.ts`)
- [ ] Express.js Cloud Function with `POST /capture` route
- [ ] `multer` middleware to parse `multipart/form-data`
- [ ] Validate required fields (`project`, `tool`, `name`); return 400 on missing
- [ ] Sanitize all fields: lowercase, strip non-`[a-z0-9_-]`, truncate to 64 chars
- [ ] Build object path: `{project}/{tool}/{yyyy}/{mm}/{dd}/{name}_{Date.now()}.png`
- [ ] Upload buffer to GCS using `@google-cloud/storage` `.file().save()`
- [ ] Validate `X-Api-Key` header against Secret Manager value; return 401 on mismatch
- [ ] Return JSON: `{ success: true, path: "...", size: N }`

#### Infrastructure
- [ ] Deploy function: `gcloud functions deploy capture --gen2 --runtime nodejs20 --trigger-http --allow-unauthenticated --region northamerica-northeast1`
- [ ] Set `--min-instances 0` (default); revisit if cold starts are annoying
- [ ] Set `API_KEY` secret in Secret Manager; bind to function as env var
- [ ] Configure Cloud Logging; verify upload logs appear

### Acceptance Criteria

- Pressing shortcut → screenshot appears in GCS bucket at correct path within 5 seconds
- Wrong or missing API key returns HTTP 401
- Missing required fields return HTTP 400
- Cloud Logging shows each upload request with timestamp and object path

---

## Sprint 3 — Direct Signed URL Upload (3–4 days)

**Goal:** Reduce backend bandwidth by uploading PNG directly from extension to GCS.

> ⚠️ Only start this sprint after Sprint 2 is fully working end-to-end.

### Deliverables

#### Backend
- [ ] `POST /upload-url` endpoint — accepts `project`, `tool`, `name` fields
- [ ] Generates a V4 signed PUT URL for the computed object path (5–15 minute expiry)
- [ ] Returns JSON: `{ signedUrl: "...", path: "..." }`
- [ ] Uses `roles/iam.serviceAccountTokenCreator` on service account for self-signing

#### Bucket CORS config

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

Apply with: `gcloud storage buckets update gs://BUCKET --cors-file=cors.json`

#### Extension changes
- [ ] On capture: first POST to `/upload-url` to get signed URL
- [ ] Then PUT blob directly to GCS: `fetch(signedUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/png' } })`
- [ ] Use `XMLHttpRequest` instead of `fetch` if upload progress indicator is needed

### Key Rules

- Always use **V4 signing** — V2 has a confirmed CORS bug with browser uploads
- Signed URL TTL: **5–15 minutes** (user-triggered, not pre-generated)
- Origin in CORS config must use your real extension ID, not `*` wildcard in production

### Acceptance Criteria

- Upload goes directly from extension to GCS (verify no image data passes through Cloud Function)
- CORS preflight OPTIONS returns 200 with correct headers
- Signed URL expires after configured TTL
- Fallback to server-side upload (Sprint 2 path) if signed URL request fails

---

## Sprint 4 — Hardening & UX (3–5 days)

**Goal:** Production-ready reliability, retry logic, and optional history view.

### Deliverables

#### Extension
- [ ] Offline queue: persist pending uploads in `chrome.storage.local`; retry on next service worker wake
- [ ] Exponential backoff retry (max 3 attempts)
- [ ] Upload progress indicator (use `XMLHttpRequest.upload.onprogress` — `fetch` does not expose upload progress)
- [ ] Settings page: configure API endpoint URL, API key, default project/tool/name
- [ ] Optional history tab in popup: last N uploads with path, timestamp, status (from `chrome.storage.local`)

#### Backend
- [ ] Rate limiting middleware (e.g., 60 requests/user/minute)
- [ ] Cloud Monitoring alert on error rate > 5% over 5 minutes
- [ ] Optional: Firestore write on each upload for searchable metadata

#### Firestore schema (if added)

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

### Acceptance Criteria

- Failed uploads are retried automatically on next browser session
- Cloud Monitoring dashboard shows request count and error rate
- All three triggers still work correctly after hardening changes
- Extension installable from a `.zip` via Chrome Developer Dashboard

---

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| `captureVisibleTab` fails on `chrome://` pages | Medium | Catch error, show notification |
| Service worker terminated mid-upload | Low | PNGs are small (<1 MB); add retry queue in Sprint 4 |
| CORS misconfiguration blocks Sprint 3 uploads | High | Test with `curl` before wiring extension |
| Signed URL intercepted in transit | Medium | HTTPS only (enforced by Cloud Run/Functions); short TTL |
| Cold start latency on first daily use | Low | Acceptable for internal tool; set min instances 1 if needed |
| Object name collision | Low | Append `Date.now()` to filename |
| Tab title contains illegal GCS characters | Medium | Sanitize on server side |

---

## Backlog (Post-Sprint 4)

- Full-page scroll-and-stitch capture
- Chrome Web Store public listing
- Per-project GCS bucket isolation
- Slack/Teams notification on upload
- Admin dashboard (Cloud Storage Browser or simple Firestore-backed web app)
- BigQuery export for usage analytics
