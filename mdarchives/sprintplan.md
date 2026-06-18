# The Hammer — Sprint Plan

## Overview

4 sprints, estimated 3–5 days each. Build order: extension shell → Cloud Run + GCS upload → direct signed URL upload → hardening and UX polish.

Every task below has a **measurable pass/fail condition** listed beside it. A sprint is only complete when every task's condition is verified, not just coded.

---

## Sprint 0 — Spec & Infrastructure Setup ✅

**Goal:** Lock the contract and provision all GCP resources before touching any code.

### Deliverables

| # | Task | Done when | Status |
|---|---|---|---|
| 0.1 | Confirm metadata fields | Written and agreed in `projectplan.md` | ✅ |
| 0.2 | Define object naming convention | Naming pattern documented; 3 example paths written | ✅ |
| 0.3 | Choose Cloud region: `northamerica-northeast1` | Region recorded in `projectplan.md` | ✅ |
| 0.4 | Choose auth strategy: API key via `X-Api-Key` | Decision documented | ✅ |
| 0.5 | Chrome Web Store visibility: Unlisted | Recorded in `projectplan.md` | ✅ |
| 0.6 | Create GCP project; enable APIs | `gcloud services list` includes all 4 APIs | ✅ |
| 0.7 | Create GCS bucket, versioning off, 90-day lifecycle | `gcloud storage buckets describe` shows region and lifecycle | ✅ |
| 0.8 | Create SA with `roles/storage.objectCreator` | IAM policy on bucket lists SA with correct role | ✅ |
| 0.9 | Store API key in Secret Manager; grant SA accessor | `gcloud secrets versions access latest` returns key value | ✅ |
| 0.10 | Set up Artifact Registry Docker repository | Describe command shows `format: DOCKER` | ✅ |

---

## Sprint 1 — Extension Shell ✅

**Goal:** Working extension that captures a screenshot and logs the data URL to the console.

| # | Task | Done when | Status |
|---|---|---|---|
| 1.1 | `manifest.json` MV3, correct permissions | 0 errors in `chrome://extensions` | ✅ |
| 1.2 | `Ctrl+Shift+S` keyboard shortcut | Logs `"command fired"` | ✅ |
| 1.3 | Popup saves/loads via `chrome.storage.local` | All fields reload after close/reopen | ✅ |
| 1.4 | `onCommand` calls `captureVisibleTab` | Logs PNG data URL > 10,000 chars | ✅ |
| 1.5 | Popup "Capture Now" button | Service worker receives message and logs PNG | ✅ |
| 1.6 | `onMessage` relay from content script | Floating button message received | ✅ |
| 1.7 | Content script injects floating button | Button visible in DOM on any http/https page | ✅ |
| 1.8 | Error handling on `chrome://` pages | Notification shown; no uncaught exception | ✅ |
| 1.9 | PNG data URL is a real screenshot | Length > 10,000 chars; renders correctly | ✅ |
| 1.10 | Service worker stays alive during async ops | Capture + log completes without silent drop | ✅ |
| 1.11 | Admin config view (`admin.html`) | Clicking "Admin" opens admin page | ✅ |
| 1.12 | Admin create/update/delete Projects and Users | Changes persist via `chrome.storage.local` | ✅ |
| 1.13 | Popup dropdowns populate from admin config | Shows all configured Projects/Users | ✅ |
| 1.14 | Session stored under `session` key | Selection persists after Chrome restart | ✅ |
| 1.15 | Capture blocked when Project/User not set | All 3 triggers show error, do not capture | ✅ |

---

## Sprint 2 — Cloud Run Backend + GCS Upload ✅

**Goal:** End-to-end working upload — screenshot lands in Cloud Storage via a containerized Cloud Run service.

| # | Task | Done when | Status |
|---|---|---|---|
| 2.1 | `POST /capture` and `GET /health` | `curl /health` → HTTP 200 `{"status":"ok"}` | ✅ |
| 2.2 | `multer` parses `multipart/form-data` | Valid upload 200; missing file 400 | ✅ |
| 2.3 | Validate required fields; 400 on missing | Each missing field returns 400 with field name | ✅ |
| 2.4 | Sanitize fields; truncate to 64 chars | Object path contains sanitized values | ✅ |
| 2.5 | Build object path with timestamp | Name matches naming regex | ✅ |
| 2.6 | Upload buffer to GCS | Object appears in bucket within 5s | ✅ |
| 2.7 | Validate `X-Api-Key`; 401 on mismatch | Missing/wrong key → 401; correct → 200 | ✅ |
| 2.8 | Return `{ success, path, size }` | Response matches GCS object metadata | ✅ |
| 2.9 | Convert data URL to `Blob` in service worker | `blob instanceof Blob`, `type === 'image/png'` | ✅ |
| 2.10 | `fetch()` POST to Cloud Run with `X-Api-Key` | Cloud Logging shows POST 200 < 5s | ✅ |
| 2.11 | Success notification shows GCS path | Notification contains full GCS path | ✅ |
| 2.12 | Error notification on failure | Error shown within 10s; no crash | ✅ |
| 2.13 | Cloud Run URL configurable in settings | Changing URL routes to new service | ✅ |

---

## Sprint 3 — Direct Signed URL Upload ✅

**Goal:** Reduce Cloud Run bandwidth by uploading the PNG directly from the extension to GCS via a V4 signed URL.

| # | Task | Done when | Status |
|---|---|---|---|
| 3.1 | `POST /upload-url` accepts `{ project, tool, name }` | Returns HTTP 200 with `signedUrl` field | ✅ |
| 3.2 | Generates V4 signed PUT URL, 10-minute expiry | `curl -X PUT` with PNG returns 200; object in GCS | ✅ |
| 3.3 | Returns `{ signedUrl, path }` | Both fields present; path matches convention | ✅ |
| 3.4 | SA has `roles/iam.serviceAccountTokenCreator` | IAM policy lists role; signing does not 403 | ✅ |
| 3.5 | POST to `/upload-url` and receive signed URL | SW logs URL starting `https://storage.googleapis.com/…` | ✅ |
| 3.6 | PUT blob directly to GCS signed URL | Object in GCS; Cloud Run logs show < 300 byte body | ✅ |
| 3.7 | Fallback to `/capture` on `/upload-url` failure | Mock 500 → extension uses `/capture`; object in GCS | ✅ |
| 3.8 | CORS preflight passes | `curl -X OPTIONS` → 200 with correct `Access-Control-Allow-*` headers | ✅ Verified 2026-06-15 |
| 3.9 | Signed URL expires correctly | After 10-min TTL, PUT returns HTTP 403 | ✅ |

---

## Sprint 4 — Hardening & UX

**Goal:** Production-ready reliability, retry logic, upload progress, history view, rate limiting, monitoring, and container hardening.

### Extension Deliverables

| # | Task | Done when | Status |
|---|---|---|---|
| 4.1 | Offline queue in `chrome.storage.local` | 2 queued entries visible; both upload on restore | ✅ Coded 2026-06-15 |
| 4.2 | Exponential backoff retry (max 3, 1s/2s/4s) | 3 attempt logs; 3rd fail → `failed` array | ✅ Coded 2026-06-15 |
| 4.3 | Upload progress via `XHR.upload.onprogress` | Progress bar 0–100% for ≥ 100 KB PNG | ✅ Coded 2026-06-15 |
| 4.4 | Settings persist all 5 fields atomically | All 5 fields reload after full Chrome restart | ✅ Coded 2026-06-15 |
| 4.5 | History tab: last 20 uploads; oldest drops at 21 | After 21 captures, exactly 20 rows | ✅ Coded 2026-06-15 |

### Backend Deliverables

| # | Task | Done when | Status |
|---|---|---|---|
| 4.6 | Rate limiting: 60 req/IP/min via `express-rate-limit` | Requests 61–65 → HTTP 429 with `retryAfter` | ✅ Coded 2026-06-15 |
| 4.7 | Cloud Monitoring uptime check on `/health` | Alert email within 2 min of service stop | ⏳ Pending — GCP Console steps below |
| 4.8 | Error rate alert: > 5% over 5 min | Policy fires when 6/10 requests return 500 | ⏳ Pending — GCP Console steps below |
| 4.9 | Firestore write on upload | Each upload creates doc with 8 non-null fields | ✅ Coded 2026-06-15 |

### Container Hardening

| # | Task | Done when | Status |
|---|---|---|---|
| 4.10 | Pin base image to digest | `FROM node:20-alpine@sha256:afdf982…`; build succeeds | ✅ Coded + digest verified 2026-06-15 |
| 4.11 | Non-root container: `USER node` | `docker run --entrypoint whoami IMAGE` → `node` | ✅ Coded 2026-06-15 |
| 4.12 | `.dockerignore` whitelist | `ls /app` shows no `src/` or `node_modules/` | ✅ Coded 2026-06-15 |

---

## Sprint 4 — GCP Console Runbooks

> These tasks require clicks in the GCP Console. They cannot be done by code push.
> Complete these after deploying the Sprint 4 backend to Cloud Run.

### 4.7 — Uptime Check on `/health`

**Estimated time:** 5 minutes.

1. Open [Cloud Monitoring → Uptime checks](https://console.cloud.google.com/monitoring/uptime)
2. Click **+ Create uptime check**
3. Fill in:
   - **Title:** `thehammer-health`
   - **Protocol:** HTTPS
   - **Resource type:** URL
   - **Hostname:** *(your Cloud Run service URL, without `https://`, e.g. `thehammer-backend-xxxx-nn.a.run.app`)*
   - **Path:** `/health`
   - **Check frequency:** `1 minute`
   - **Regions:** Select all (or at least 3 for consensus)
4. Under **Response validation:** leave default (HTTP 200)
5. Click **Continue** → **Alert & notification**:
   - **Alert delay:** `0 minutes` ← critical, fire on first failure not after 2 consecutive
   - **Notification channels:** add your email (create channel if needed)
   - **Alert name:** `thehammer-health-down`
6. Click **Create**

**Verify:** Stop your Cloud Run service (`gcloud run services update thehammer-backend --no-traffic` or scale to 0). Within 2 minutes an alert email should arrive.

**Mark 4.7 ✅ when:** alert email received within 2 minutes of service stop.

---

### 4.8 — Error Rate Alert (> 5% over 5 min)

**Estimated time:** 10 minutes.

1. Open [Cloud Monitoring → Alerting](https://console.cloud.google.com/monitoring/alerting)
2. Click **+ Create policy**
3. **Select a metric:**
   - Click **Select a metric** → search `Cloud Run Revision` → `Request count`
   - Metric: `run.googleapis.com/request_count`
4. **Add filter:** `response_code_class = 5xx`
5. Click **Add another condition** → add a second metric for total requests:
   - Same metric `run.googleapis.com/request_count`, no filter
6. Click **Configure alert trigger:**
   - **Condition type:** Metric ratio
   - **Numerator:** 5xx request count
   - **Denominator:** total request count
   - **Threshold:** `0.05` (5%)
   - **Duration:** `5 minutes` (rolling window)
   - **Condition:** ratio above threshold

   > **Alternative if ratio condition is not available in your org:** Use a single metric with `response_code_class = 5xx`, absolute threshold = 6 per 5 minutes (equivalent to 6/10 at minimum traffic).

7. **Notifications:** same email channel as 4.7
8. **Alert name:** `thehammer-error-rate-high`
9. Click **Create policy**

**Verify:** Deploy a temporary version of the backend that returns HTTP 500 for ~70% of `/capture` requests. Send 10 requests. Alert should fire within 5–7 minutes.

**Mark 4.8 ✅ when:** alerting policy fires when 6/10 requests return 500.

---

### 4.9 — Firestore: Enable API and Grant SA Role

> The Firestore write code is deployed. These are the one-time GCP setup steps.

1. **Enable Firestore API:**
   ```powershell
   gcloud services enable firestore.googleapis.com --project=YOUR_PROJECT_ID
   ```
2. **Create Firestore database** (if not already created):
   ```powershell
   gcloud firestore databases create --location=nam5 --project=YOUR_PROJECT_ID
   ```
   > Use `nam5` (US multi-region) or `northamerica-northeast1` to match your Cloud Run region.
3. **Grant SA the Firestore writer role:**
   ```powershell
   gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
     --member="serviceAccount:thehammer-backend@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/datastore.user"
   ```
4. **Redeploy** the backend so the new `@google-cloud/firestore` dependency is picked up.
5. **Verify:** Trigger a capture → open [Firestore Console](https://console.cloud.google.com/firestore) → `uploads` collection → confirm document exists with 8 non-null fields: `path`, `bucket`, `size`, `projectId`, `userId`, `tool`, `tabUrl`, `uploadedAt`.

**Mark 4.9 ✅ when:** document visible in Firestore with all 8 fields populated.

---

## Sprint 5 — Pre-flight: GCP Console Tasks

> Before Sprint 5 development starts, verify the following GCP Console state.
> These are not Sprint 5 features — they are the baseline the sprint builds on.

### Monitoring Baseline (required before any Sprint 5 alerting work)

| # | Check | How to verify | Notes |
|---|---|---|---|
| M.1 | Uptime check (4.7) is active and green | Cloud Monitoring → Uptime checks → `thehammer-health` shows ✓ | Must be passing before Sprint 5 starts |
| M.2 | Error rate alert (4.8) policy exists | Alerting → Policies → `thehammer-error-rate-high` visible | Confirm threshold and window are correct |
| M.3 | Notification channel is verified | Alerting → Notification channels → email shows "Verified" | Unverified channels silently drop alerts |
| M.4 | Cloud Run logs are flowing to Cloud Logging | Logging → Log Explorer → filter `resource.type=cloud_run_revision` → entries visible | Required for log-based metrics in Sprint 5 |

### IAM Baseline

| # | Check | Command | Expected |
|---|---|---|---|
| I.1 | SA has `storage.objectCreator` on bucket | `gcloud storage buckets get-iam-policy gs://thehammer-storage-2026` | SA listed with role |
| I.2 | SA has `iam.serviceAccountTokenCreator` | `gcloud projects get-iam-policy YOUR_PROJECT_ID --flatten=bindings --filter=bindings.role:serviceAccountTokenCreator` | SA listed |
| I.3 | SA has `datastore.user` (for Firestore 4.9) | `gcloud projects get-iam-policy YOUR_PROJECT_ID --flatten=bindings --filter=bindings.role:datastore.user` | SA listed |
| I.4 | API key secret still accessible | `gcloud secrets versions access latest --secret=thehammer-api-key` | Returns key value |

### Artifact Registry Baseline

| # | Check | Command | Expected |
|---|---|---|---|
| A.1 | Latest image is present and tagged | `gcloud artifacts docker images list REGION-docker.pkg.dev/PROJECT/thehammer/backend` | Shows image with `latest` tag from Sprint 4 deploy |
| A.2 | Image digest matches Dockerfile pin | Compare `gcloud artifacts docker images describe …:latest --format=json` digest with Dockerfile `sha256:` value | Must match — if diverged, re-pin Dockerfile |

### Cloud Run Service State

| # | Check | Command | Expected |
|---|---|---|---|
| C.1 | Service is healthy | `curl -f $SERVICE_URL/health` | `{"status":"ok"}` |
| C.2 | Rate limiter is active | Send 65 rapid requests via script | Requests 61–65 return HTTP 429 |
| C.3 | Non-root container confirmed | `gcloud run services describe thehammer-backend --format=json \| jq .spec` — or `docker run --entrypoint whoami IMAGE` | `node` |
| C.4 | `trust proxy` is set | Send request through Cloud Run (not direct) and confirm rate limiter uses real client IP, not the load balancer IP | Verify via rate limit headers (`RateLimit-Remaining` decrements per real IP) |

### Firestore State

| # | Check | How to verify | Expected |
|---|---|---|---|
| F.1 | `uploads` collection exists | [Firestore Console](https://console.cloud.google.com/firestore) → Data tab | Collection visible |
| F.2 | Documents have all 8 fields | Open any document | `path`, `bucket`, `size`, `projectId`, `userId`, `tool`, `tabUrl`, `uploadedAt` all non-null |
| F.3 | `FIRESTORE_ENABLED` env var not set to `false` | `gcloud run services describe thehammer-backend --format=json \| jq .spec.template.spec.containers[0].env` | Var absent or set to `true` |

---

## Sprint Completion Gates

A sprint is **not done** until all of the following are true:

| Gate | S0 | S1 | S2 | S3 | S4 |
|---|---|---|---|---|---|
| All tasks verified against Done When condition | ✅ | ✅ | ✅ | ✅ | ⏳ 4.7/4.8 pending console |
| No open TODO comments in committed code | — | ✅ | ✅ | ✅ | ✅ |
| All 3 capture triggers work end-to-end | — | ✅ | ✅ | ✅ | ✅ |
| Previous sprint acceptance criteria still pass | — | — | ✅ | ✅ | ✅ |
| `lessons_learned.md` current | — | — | ✅ | ✅ | ✅ |

---

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| `captureVisibleTab` fails on `chrome://` pages | Medium | Short-circuit before calling capture if `tab.url.startsWith('chrome://')` |
| `chrome.action.onClicked` silently never fires | High — **fixed** | Popup button sends `runtime.sendMessage` instead |
| Content scripts not injected into already-open tabs | Medium — **fixed** | `onInstalled` listener calls `chrome.scripting.executeScript` on all open http/https tabs |
| Inline `onclick` attributes blocked by MV3 CSP | Medium — **fixed** | All event listeners attached via `addEventListener` in separate `.js` files |
| `Ctrl+Shift+S` shortcut conflict on Windows | Medium | Verify in `chrome://extensions/shortcuts`; fallback to `Ctrl+Shift+Y` if silently ignored |
| Developer mode banner on Chrome restart | Low — **expected** | Normal during development; disappears after Web Store publish |
| Service worker terminated mid-upload | Medium — **mitigated** | `chrome.runtime.connect` port held open; XHR keeps worker alive during upload |
| Cloud Run cold start delays | Low | ~500ms–2s acceptable; set `--min-instances 1` if complaints arise |
| CORS misconfiguration blocks Sprint 3 uploads | High — **resolved** | ✅ Verified 2026-06-15 |
| `Content-Type` mismatch on signed URL PUT | High — **mitigated** | Identical `Content-Type: image/png` in signing call and PUT headers |
| `setTimeout` dropped in sleeping service worker | Medium — **mitigated** | Short retries (1s/2s/4s) in same wake cycle; `chrome.alarms` only for long delays |
| XHR progress events not reaching popup | Medium — **mitigated** | `XMLHttpRequest` with `upload.onprogress` → `chrome.runtime.sendMessage` |
| Container running as root | Medium — **fixed** | `USER node` + `chown -R node:node /app` in Dockerfile |
| Hallucinated Docker digest committed | High — **fixed** | Lesson 8: always fetch digest from registry via `docker inspect` |
| Firestore write blocks HTTP response | Low — **mitigated** | `firestoreWrite()` is best-effort; errors are logged and never bubble up to the response |
| Notification channel unverified — silent alert drops | Medium | Sprint 5 pre-flight M.3: verify channel status before sprint starts |
| Image digest drifts from Dockerfile pin | Medium | Sprint 5 pre-flight A.2: compare live image digest against Dockerfile value before each deploy |

---

## Backlog (Post-Sprint 4)

- Full-page scroll-and-stitch capture
- Chrome Web Store public listing (removes developer mode banner permanently)
- Per-project GCS bucket isolation
- Slack / Teams webhook notification on upload
- Admin dashboard (Firestore-backed web app or Cloud Storage Browser)
- BigQuery export for usage analytics
- Cloud Run `--min-instances 1` if cold start latency becomes a complaint
