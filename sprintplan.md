# The Hammer — Sprint Plan

## Overview

4 sprints, estimated 3–5 days each. Build order: extension shell → Cloud Run + GCS upload → direct signed URL upload → hardening and UX polish.

Every task below has a **measurable pass/fail condition** listed beside it. A sprint is only complete when every task's condition is verified, not just coded.

---

## Sprint 0 — Spec & Infrastructure Setup (1–2 days)

**Goal:** Lock the contract and provision all GCP resources before touching any code.

### Deliverables

| # | Task | Done when | Success % | How to reach 100% |
|---|---|---|---|---|
| 0.1 | Confirm metadata fields: `project`, `tool`, `userName` | Written and agreed in `projectplan.md`; no open questions | 99% | Already documented. Review once before Sprint 1 kicks off. |
| 0.2 | Define object naming convention and sanitization rules | Naming pattern documented; 3 example paths written out and reviewed | 99% | Write 3 concrete example paths in `projectplan.md` before any code is written. |
| 0.3 | Choose Cloud region: `northamerica-northeast1` (Montréal) | Region recorded in `projectplan.md` and used in all infra commands | 99% | Grep all infra scripts for hardcoded region strings before Sprint 2 starts. |
| 0.4 | Choose auth strategy: API key via `X-Api-Key` header stored in Secret Manager | Decision documented; no alternative left open | 99% | Close any open Slack threads or comments about OAuth alternatives before starting. |
| 0.5 | Decide Chrome Web Store visibility: **Unlisted** | Recorded in `projectplan.md` | 99% | Already decided. No action needed. |
| 0.6 | Create GCP project; enable APIs | `gcloud services list` includes all 4 APIs | 97% | Use `infra/setup.ps1` — runs all `gcloud services enable` commands in one shot and exits non-zero on any failure. Re-run until clean. |
| 0.7 | Create GCS bucket with versioning off, 90-day lifecycle rule | `gcloud storage buckets describe` shows region and lifecycle | 97% | All flags are in `infra/setup.ps1`. Verify with `gcloud storage buckets describe --format=json` after creation and assert the two fields. |
| 0.8 | Create service account with `roles/storage.objectCreator` | IAM policy on bucket lists SA with correct role | 97% | Run `gcloud storage buckets get-iam-policy` immediately after binding and grep for the SA name. If missing, re-apply and re-verify. |
| 0.9 | Store API key in Secret Manager; grant SA accessor | `gcloud secrets versions access latest` returns key value | 96% | Script the secret creation and IAM grant together. Run the access command as the SA (using `--impersonate-service-account`) to confirm it works from the SA's perspective, not just your own. |
| 0.10 | Set up Artifact Registry Docker repository | Describe command shows `format: DOCKER` | 97% | The `gcloud artifacts repositories create` command is in `infra/setup.ps1`. The only failure mode is a typo in the repo name — verify with describe immediately after. |

> **Note on 0.6:** `gsutil` commands are deprecated in favour of `gcloud storage`. All infra commands in this plan use `gcloud storage`.

---

## Sprint 1 — Extension Shell (3–5 days)

**Goal:** Working extension that captures a screenshot and logs the data URL to the console. No backend yet.

> **Architecture note — toolbar button vs. popup:**
> `chrome.action.onClicked` **does not fire when `default_popup` is set** in the manifest. Because the popup is always present (project/tool/name settings live there), the toolbar button click opens the popup — it cannot simultaneously trigger a capture. The three capture triggers are therefore: **(1) keyboard shortcut**, **(2) a dedicated "Capture Now" button inside the popup**, **(3) the floating page button injected by the content script**. Task 1.5 below reflects this.

> **⚠️ Developer Mode warning (Chrome 149+, June 2026):**
> Loading an unpacked extension in developer mode causes Chrome to show a "Disable developer mode extensions" banner **every time Chrome starts**. This is a Chrome security feature and cannot be suppressed in a standard profile. It is expected and normal during development. Dismiss it with the X or press Escape. The warning disappears permanently once the extension is published to the Chrome Web Store (even as Unlisted). Do not spend time trying to suppress it during Sprint 1 — it is not a bug.

### Deliverables

| # | Task | Done when | Success % | How to reach 100% |
|---|---|---|---|---|
| 1.1 | `manifest.json` with MV3, correct permissions | 0 errors in `chrome://extensions` | 98% | Copy the validated skeleton from this plan verbatim. The only gap is a typo — lint with `npx @crxjs/manifest-types` or the Chrome extension linter before loading. |
| 1.2 | `commands` key with `Ctrl+Shift+S` / `Command+Shift+S` | Shortcut appears in `chrome://extensions/shortcuts`; logs `"command fired"` | 93% | **Known conflict risk on Windows:** `Ctrl+Shift+S` is claimed by AMD Radeon software, some screen recorders, and certain Office apps. Test immediately after loading. If the shortcut is silently swallowed, open `chrome://extensions/shortcuts`, reassign to `Ctrl+Shift+Y`, and update `suggested_key` in the manifest. Always verify in `chrome://extensions/shortcuts` — Chrome will show "(Not set)" if the key is in conflict with another extension. |
| 1.3 | Popup saves/loads via `chrome.storage.local` | All 3 fields reload after popup closed/reopened | 97% | Wrap every `chrome.storage.local.set` call in a try/catch and log errors. Test the reload in an Incognito window where storage behaves slightly differently. **Never use `localStorage` in an extension** — use `chrome.storage.local` only. |
| 1.4 | Service worker: `onCommand` calls `captureVisibleTab` | Logs PNG data URL > 10,000 chars | 95% | `captureVisibleTab` requires the tab to be active and focused. In tests, ensure the Chrome window is in the foreground. Add an `activeTab` guard: check `tab.active === true` before calling. |
| 1.5 | Popup "Capture Now" button sends `runtime.sendMessage` | Service worker receives message and logs PNG data URL | 94% | The popup and service worker are separate contexts. Confirm the `chrome.runtime.sendMessage` call fires from `popup.js` as a **separate file** — never use inline `onclick="..."` attributes in HTML, which are blocked by MV3's Content Security Policy. Attach listeners via `addEventListener` in `popup.js`. |
| 1.6 | `onMessage` relay from content script | Floating button message received; PNG data URL logged | 90% | **New risk:** Content scripts declared in `manifest.json` are **not automatically injected into tabs that were already open** when the extension is first loaded or updated. Add a `chrome.runtime.onInstalled` listener in the service worker that calls `chrome.scripting.executeScript` to inject `content.js` into all existing `http/https` tabs. Also use `sender.frameId === 0` in the service worker message listener to ignore messages from iframes. |
| 1.7 | Content script injects floating capture button | Button visible in DOM on any http/https page | 93% | Some pages (e.g. Google Docs, Figma) override `z-index` or use Shadow DOM. Give the button `z-index: 2147483647` (max) and `position: fixed`. Use a unique `id="thehammer-float-btn"` to detect and skip re-injection on already-open tabs after the `onInstalled` injection. |
| 1.8 | Error handling on `chrome://` pages | Notification shown; no uncaught exception | 91% | Wrap `captureVisibleTab` in a try/catch with an explicit check: if `tab.url.startsWith('chrome://')`, short-circuit before calling capture and fire the notification immediately. Never let the API call happen. |
| 1.9 | PNG data URL is a real screenshot | Length > 10,000 chars; renders correctly | 97% | Validate in the service worker: after capture, assert `dataUrl.startsWith('data:image/png;base64,')` and `dataUrl.length > 10000`. If either fails, log the actual value and show an error notification. |
| 1.10 | Service worker stays alive during async operations | Capture + log completes without silent drop | 93% | **New task.** The service worker terminates after ~30s of idle. For short operations (capture + console log only, < 2s), this is not a problem in Sprint 1. However, to prevent any edge-case silent drop, open a long-lived `chrome.runtime.connect` port from the content script to the service worker before sending the capture message, and close it immediately after the response is received. This keeps the worker alive for the duration of the operation. |
| 1.11 | Admin config view exists (`admin.html` / `admin.js`) | Clicking "Admin" link in popup opens admin page | 96% | Use a separate HTML page (`admin.html`) with its own script (`admin.js`). Add a small "Admin" link or icon in the popup that calls `chrome.tabs.create({ url: chrome.runtime.getURL('admin.html') })`. Test that this works even when no normal tabs are open by clicking it from a fresh Chrome window with only the extensions page. |
| 1.12 | Admin can create/update/delete Projects and Users | Admin UI shows 2 lists; changes persist via `chrome.storage.local` | 94% | Define a simple schema under a `config` key in `chrome.storage.local`, e.g. `{ projects: [...], users: [...] }`. In `admin.js`, implement add/remove for both lists and call `chrome.storage.local.set({ config })` on every change. Unit-test the pure functions that add/remove items so UI bugs are easier to isolate. |
| 1.13 | Popup Project/User dropdowns populate from admin config | Dropdowns show all configured Projects/Users | 95% | In `popup.js`, read the `config` key from `chrome.storage.local` on `DOMContentLoaded` and populate two `<select>` elements. If `config` is missing (first run), fall back to a small hardcoded seed list and prompt the admin to open the Admin view to customize. |
| 1.14 | Session selection stored under `session` key | After selecting Project/User, reload popup: same selection is shown | 96% | When the user selects a Project/User/Tool and clicks "Save", call `chrome.storage.local.set({ session: { projectId, userId, tool } })`. On popup load, read `session` and set `<select>` and input values accordingly. This must survive a full Chrome restart, not just popup close. |
| 1.15 | Capture blocked when Project/User not set | All three triggers show clear error and do not capture | 95% | In the service worker capture handler, read `session` from `chrome.storage.local`. If `!session || !session.projectId || !session.userId`, show a `chrome.notifications.create` or popup-level error and **return early without calling `captureVisibleTab`**. Test this path for keyboard shortcut, popup button, and floating button. |

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

### Content Script Injection Fix (service-worker.js)

```js
// Inject content.js into all already-open tabs on install/update
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
    } catch (e) {
      // Tab may be a restricted page — ignore silently
    }
  }
});
```

### Popup Script Pattern (popup.js — never inline onclick)

```js
// popup.js — always a separate file, never inline onclick in HTML
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('capture-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CAPTURE' });
  });

  document.getElementById('admin-link').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('admin.html') });
  });
});
```

---

## Sprint 2 — Cloud Run Backend + GCS Upload (3–5 days)

**Goal:** End-to-end working upload — screenshot lands in Cloud Storage with the correct filename via a containerized Cloud Run service.

### Backend Deliverables

| # | Task | Done when | Success % | How to reach 100% |
|---|---|---|---|---|
| 2.1 | Express app with `POST /capture` and `GET /health` | `curl /health` → HTTP 200 `{ "status": "ok" }` | 97% | Keep the health route dependency-free (no DB, no GCS call). It must return 200 even if GCS is unreachable. Add a startup smoke test in CI: `curl -f $SERVICE_URL/health`. |
| 2.2 | `multer` parses `multipart/form-data` | Valid upload 200; missing `file` field 400 | 95% | Set explicit `multer` limits: `fileSize: 10 * 1024 * 1024` (10 MB). Without a size limit, a large PNG will silently hang or OOM the container. Test with a 0-byte file — it should return 400, not 200. |
| 2.3 | Validate required fields; return 400 on missing | Each missing field returns 400 with field name | 97% | Use a validation middleware (e.g. `zod` or manual check) that runs **before** `multer` processes the file. This avoids loading the file buffer into memory for a request that will be rejected anyway. |
| 2.4 | Sanitize fields; truncate to 64 chars | Object path contains sanitized values | 95% | Unit-test the sanitizer with 5 adversarial inputs: path traversal (`../../etc`), unicode (`café`), all-special-chars (`!!!`), empty string, and 200-char string. All must produce a valid, non-empty, ≤ 64-char slug. |
| 2.5 | Build object path with timestamp | Name matches naming regex | 96% | Add a pure unit test for the path builder. Test that two calls within the same millisecond produce different paths (use a mock clock). Assert the regex match in the test, not just visually. |
| 2.6 | Upload buffer to GCS | Object appears in bucket within 5s | 94% | Use `@google-cloud/storage` `save()` with `{ resumable: false }` for files < 5 MB — this avoids the resumable upload handshake and is faster and more reliable for small PNGs. Handle the GCS `ApiError` explicitly and return 502 (not 500) so the extension can distinguish a backend crash from a GCS failure. |
| 2.7 | Validate `X-Api-Key`; return 401 on mismatch | Missing/wrong key → 401; correct → 200 | 97% | Use `timingSafeEqual` from Node's `crypto` module for the key comparison to prevent timing attacks — even on an internal tool, it's one line of code. Read the key from `process.env.API_KEY` (injected by Secret Manager via `--set-secrets`), not from a config file. |
| 2.8 | Return `{ success, path, size }` | Response matches GCS object metadata | 96% | The `size` field should come from the `multer` `file.size` property (bytes received), not from a subsequent GCS metadata call. This avoids an extra round-trip and the value is always available. |

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

### Deploy Commands (`infra/deploy.ps1`)

```powershell
$PROJECT_ID = 'YOUR_GCP_PROJECT_ID'
$REGION     = 'northamerica-northeast1'
$IMAGE      = "$REGION-docker.pkg.dev/$PROJECT_ID/thehammer/backend:latest"

gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
docker build -t $IMAGE ./backend
docker push $IMAGE

gcloud run deploy thehammer-backend `
  --image $IMAGE `
  --region $REGION `
  --platform managed `
  --allow-unauthenticated `
  --min-instances 0 `
  --max-instances 5 `
  --memory 256Mi `
  --timeout 30s `
  --set-secrets API_KEY=thehammer-api-key:latest `
  --service-account "thehammer-backend@$PROJECT_ID.iam.gserviceaccount.com"
```

### Extension Deliverables

| # | Task | Done when | Success % | How to reach 100% |
|---|---|---|---|---|
| 2.9 | Convert data URL to `Blob` in service worker | `blob instanceof Blob`, `blob.type === 'image/png'` | 96% | Use the `fetch(dataUrl).then(r => r.blob())` pattern — it's more reliable than manual base64 decoding. Assert `blob.size > 0` before attaching to the FormData. |
| 2.10 | `fetch()` POST to Cloud Run with `X-Api-Key` | Cloud Logging shows POST 200 < 5s | 93% | **Keep the service worker alive during the upload** by opening a `chrome.runtime.connect` port from the content script before the message is sent and holding it open until the upload response is received. The upload is typically < 2s, but without the port, a cold worker restart mid-upload will silently drop the request. |
| 2.11 | Success notification shows GCS path | Notification contains full GCS path | 94% | `chrome.notifications` requires the `notifications` permission and an `iconUrl` — a missing icon causes the notification to silently fail on some platforms. Include a 128×128 PNG icon in the extension and reference it in every `chrome.notifications.create` call. |
| 2.12 | Error notification on failure | Error shown within 10s; no crash | 91% | Set an explicit `AbortController` timeout on the `fetch` (e.g. 15s). Without it, a hung Cloud Run container will keep the service worker alive until Chrome kills it, leaving the user with no feedback. |
| 2.13 | Cloud Run URL configurable in settings | Changing URL routes to new service | 95% | Validate the URL format (must start with `https://`) before saving in `chrome.storage.local`. Show an inline error in the popup if the URL is invalid rather than silently saving a broken value. |

---

## Sprint 3 — Direct Signed URL Upload (3–4 days)

**Goal:** Reduce Cloud Run bandwidth by uploading the PNG directly from the extension to GCS via a V4 signed URL. Cloud Run issues the URL only — image bytes never pass through it.

> ⚠️ Only start this sprint after Sprint 2 is fully working end-to-end.

### Backend Deliverables

| # | Task | Done when | Success % | How to reach 100% |
|---|---|---|---|---|
| 3.1 | `POST /upload-url` accepts `{ project, tool, name }` | Returns HTTP 200 with `signedUrl` field | 95% | Reuse the same field validator and sanitizer from task 2.3/2.4. Do not write a second copy — share the middleware. Test the endpoint with `curl` before wiring the extension. |
| 3.2 | Generates V4 signed PUT URL, 10-minute expiry | `curl -X PUT` with PNG returns 200; object in GCS | 91% | The SA must have `roles/iam.serviceAccountTokenCreator` **on itself** (task 3.4). Confirm this with `gcloud iam service-accounts get-iam-policy` before writing the signing code. The 403 from a missing role is cryptic and easy to misdiagnose. |
| 3.3 | Returns `{ signedUrl, path }` | Both fields present; path matches convention | 95% | The `path` returned must be **identical** to the GCS object name encoded in the signed URL. Parse the URL and assert they match in a unit test. |
| 3.4 | SA has `roles/iam.serviceAccountTokenCreator` | IAM policy lists role; signing does not 403 | 90% | Grant the role **before** deploying the signing code. Use `gcloud iam service-accounts add-iam-policy-binding SA_EMAIL --role=roles/iam.serviceAccountTokenCreator --member=serviceAccount:SA_EMAIL` (self-binding). Verify with `gcloud iam service-accounts get-iam-policy SA_EMAIL` immediately after. |

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
```powershell
gcloud storage buckets update gs://thehammer-screenshots --cors-file=infra\cors.json
```

Verify:
```powershell
gcloud storage buckets describe gs://thehammer-screenshots --format="json(cors)"
```

### Extension Deliverables

| # | Task | Done when | Success % | How to reach 100% |
|---|---|---|---|---|
| 3.5 | POST to `/upload-url` and receive signed URL | Service worker logs URL starting with `https://storage.googleapis.com/...` | 92% | Log the full signed URL to the service worker console on first successful run. Confirm the `path` field is also present. Only then wire the PUT in task 3.6. |
| 3.6 | PUT blob directly to GCS signed URL | Object in GCS; Cloud Run logs show < 300 byte body | 88% | This is the highest-risk task. Use `fetch(signedUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/png' } })`. The `Content-Type` header **must exactly match** what was used when generating the signed URL. A mismatch causes a silent 403. Set `Content-Type: image/png` in both the signing call and the PUT. |
| 3.7 | Fallback to `/capture` on `/upload-url` failure | Mock 500 → extension uses `/capture`; object lands in GCS | 90% | Implement the fallback as a named function `uploadViaProxy()` that is also called by the primary path's catch block. This ensures the same code path is used for both fallback and the Sprint 2 direct upload — no divergence. |

### CORS Verification

| # | Check | Done when | Success % | How to reach 100% |
|---|---|---|---|---|
| 3.8 | CORS preflight passes | `curl -X OPTIONS` returns 200 with correct `Access-Control-Allow-Origin` | 85% | **Highest-risk task in the project.** Do this in 3 steps before touching extension code: (1) Apply `cors.json`. (2) Run `gcloud storage buckets describe --format=json(cors)` and confirm it's set. (3) Run the `curl -X OPTIONS` command with your actual extension ID. Only proceed to task 3.6 after step 3 passes. CORS config propagates in < 60s but can take up to 5 minutes — wait and retry if the first check fails. |
| 3.9 | Signed URL expires correctly | After 10-min TTL, PUT returns HTTP 403 | 93% | This is a passive verification — just wait and test. The only failure mode is generating the URL with the wrong expiry. Assert `expiresAt = Date.now() + 600_000` in the signing code and log it. |

---

## Sprint 4 — Hardening & UX (3–5 days)

**Goal:** Production-ready reliability, retry logic, and optional history view.

### Extension Deliverables

| # | Task | Done when | Success % | How to reach 100% |
|---|---|---|---|---|
| 4.1 | Offline queue persisted in `chrome.storage.local` | 2 queued entries visible; both upload on restore | 88% | Use a simple array in `chrome.storage.local` with keys `queue` (pending) and `failed` (exhausted retries). On every service worker startup, check `queue.length > 0` and drain it. The service worker wakes on browser start — this is the natural drain trigger. |
| 4.2 | Exponential backoff retry (max 3, 1s/2s/4s) | 3 attempt logs with correct delays; 3rd fail → `failed` | 87% | Do not use `setTimeout` directly in a service worker — the worker may sleep between retries and `setTimeout` callbacks are dropped. Use `chrome.alarms.create` with the retry delay as the alarm period. The alarm wakes the worker reliably. Note: `chrome.alarms` has a **minimum interval of 30 seconds** — retries at 1s/2s/4s must be handled in a single worker wake cycle while the worker is alive, only falling back to `chrome.alarms` for the final long retry. |
| 4.3 | Upload progress via `XMLHttpRequest.upload.onprogress` | Progress bar updates 0–100% for ≥ 100 KB PNG | 85% | `fetch()` does not expose upload progress in service workers. Use `XMLHttpRequest` wrapped in a Promise for the upload call. The `onprogress` handler must post a message back to the popup via `chrome.runtime.sendMessage` since the popup is a separate context. Test this with a throttled network connection in Chrome DevTools (Network tab → Slow 3G). |
| 4.4 | Settings persist all 5 fields across restart | All 5 fields reload after full Chrome restart | 95% | Use one `chrome.storage.local.set({ settings: { ...allFields } })` call rather than 5 separate `set` calls. A single atomic write prevents partial saves if the popup closes mid-save. |
| 4.5 | History tab: last 20 uploads; oldest drops at 21 | After 21 captures, exactly 20 rows | 86% | Store history as a fixed-length array. On each push, use `history.unshift(newEntry); if (history.length > 20) history.pop();`. Write this as a pure function and unit-test it with 0, 1, 20, and 21 items. |

### Backend Deliverables

| # | Task | Done when | Success % | How to reach 100% |
|---|---|---|---|---|
| 4.6 | Rate limiting: 60 req/IP/min via `express-rate-limit` | Requests 61–65 return HTTP 429 with `retryAfter` | 93% | Cloud Run's load balancer can change the client IP reported in `req.ip`. Set `app.set('trust proxy', 1)` so `express-rate-limit` reads `X-Forwarded-For` correctly. Without this, every request appears to come from the same IP and all users share one rate-limit bucket. |
| 4.7 | Cloud Monitoring uptime check on `/health` | Stopping service causes alert email within 2 min | 91% | Set the uptime check period to 1 minute, not the default 5 minutes. This halves the detection window. Set the alert notification delay to 0 (alert on first failure) rather than waiting for 2 consecutive failures. |
| 4.8 | Alert: error rate > 5% over 5 minutes | Alerting policy fires when 6/10 requests return 500 | 87% | Use a ratio-based alerting condition: `(5xx count / total count) > 0.05` over a 5-minute rolling window. A count-only alert will fire even during normal operation if traffic is high. Test the alert by deploying a temporary handler that returns 500 for 70% of `/capture` requests. |
| 4.9 | Firestore write on upload (optional) | Each upload creates document with 8 non-null fields | 89% | Use a Firestore `set()` with `merge: false` so a retry of the same upload ID overwrites rather than creates a duplicate. Generate the document ID from the GCS object path (URL-encoded) to make deduplication deterministic. |

### Container Hardening Deliverables

| # | Task | Done when | Success % | How to reach 100% |
|---|---|---|---|---|
| 4.10 | Pin base image to digest | `FROM node:20-alpine@sha256:DIGEST`; build succeeds | 96% | Retrieve the current digest with `docker inspect --format='{{index .RepoDigests 0}}' node:20-alpine` and paste it into the Dockerfile. Add a comment with the date pinned. Set a calendar reminder to re-pin every 90 days. |
| 4.11 | Run as non-root user | `docker run --entrypoint whoami IMAGE` outputs `node` | 97% | Add `USER node` as the last line before `CMD`. Also add `RUN chown -R node:node /app` after `COPY dist/` — otherwise the `node` user cannot read the app files. |
| 4.12 | `.dockerignore` excludes dev files | `ls /app` does not show `src/` or `node_modules/` | 96% | Use a whitelist approach in `.dockerignore`: ignore everything (`*`) then explicitly allow what you need (`!dist/`, `!package*.json`). This is safer than a blacklist which can miss new dev files. |

---

## Success Probability Summary

| Sprint | Description | Avg Task % | Sprint-level % | Key risk task |
|---|---|---|---|---|
| Sprint 0 | Spec & Infrastructure | 98% | **97%** | 0.9 — SA secret access verification |
| Sprint 1 | Extension Shell | 95% | **90%** | 1.6 — Content script injection into open tabs |
| Sprint 2 | Cloud Run + GCS Upload | 95% | **83%** | 2.12 — Error notification + AbortController |
| Sprint 3 | Direct Signed URL Upload | 91% | **72%** | 3.8 — CORS preflight verification |
| Sprint 4 | Hardening & UX | 91% | **70%** | 4.2 — Retry via chrome.alarms |
| **Full project end-to-end** | All sprints complete | — | **~58–63%** | Sprint 3 CORS + Sprint 4 retry |

> With every "How to reach 100%" mitigation applied, conservative re-estimates: Sprint 1 → 95%, Sprint 2 → 90%, Sprint 3 → 82%, Sprint 4 → 78%. Full project → **~67–72%**.

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
| `captureVisibleTab` fails on `chrome://` pages | Medium | Short-circuit before calling capture if `tab.url.startsWith('chrome://')` (task 1.8) |
| `chrome.action.onClicked` silently never fires | High — **already fixed** | Popup button sends `runtime.sendMessage` instead; `onClicked` is not used |
| Content scripts not injected into already-open tabs | Medium — **new** | `onInstalled` listener calls `chrome.scripting.executeScript` on all open http/https tabs (task 1.6, code snippet above) |
| Inline `onclick` attributes blocked by MV3 CSP | Medium — **new** | All event listeners attached via `addEventListener` in separate `.js` files (task 1.5, code snippet above) |
| `Ctrl+Shift+S` shortcut conflict on Windows | Medium — **new** | Verify in `chrome://extensions/shortcuts` after loading; fallback to `Ctrl+Shift+Y` if silently ignored (task 1.2) |
| Developer mode banner on Chrome restart | Low — **expected** | Normal during development; disappears after Web Store publish. Do not attempt to suppress (noted in Sprint 1 intro) |
| Service worker terminated mid-upload | Medium — **updated** | Hold `chrome.runtime.connect` port open from content script during capture+upload; close on response (tasks 1.10, 2.10) |
| Cloud Run cold start delays first capture | Low | ~500ms–2s acceptable; set `--min-instances 1` if team complaints arise |
| CORS misconfiguration blocks Sprint 3 uploads | High | Verify with `curl -X OPTIONS` before wiring extension (task 3.8); fallback in place (task 3.7) |
| `Content-Type` mismatch on signed URL PUT | High | Set identical `Content-Type: image/png` in both signing call and PUT headers (task 3.6) |
| `setTimeout` dropped in sleeping service worker | Medium | Use `chrome.alarms` for retry delays > 30s; handle short retries in same wake cycle (task 4.2) |
| XHR progress events not reaching popup | Medium | Post progress via `chrome.runtime.sendMessage` from service worker to popup (task 4.3) |
| Signed URL intercepted in transit | Medium | HTTPS enforced by GCS; 10-minute TTL limits exposure window |
| Object name collision | Low | `Date.now()` epoch suffix on every filename (task 2.5) |
| Container running as root | Medium — **fixed** | `USER node` + `chown -R node:node /app` in Dockerfile (task 4.11) |
| API key readable by any extension user | Medium | Acceptable for 5 trusted internal users; rotate via Secret Manager if team grows |

---

## Backlog (Post-Sprint 4)

- Full-page scroll-and-stitch capture
- Chrome Web Store public listing (removes developer mode banner permanently)
- Per-project GCS bucket isolation
- Slack / Teams webhook notification on upload
- Admin dashboard (Firestore-backed web app or Cloud Storage Browser)
- BigQuery export for usage analytics
- Cloud Run `--min-instances 1` if cold start latency becomes a complaint
