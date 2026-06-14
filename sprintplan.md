# The Hammer — Sprint Plan

## Overview

4 sprints, estimated 3–5 days each. Build order: extension shell → Cloud Run + GCS upload → direct signed URL upload → hardening and UX polish.

Every task below has a **measurable pass/fail condition** listed beside it. A sprint is only complete when every task's condition is verified, not just coded.

---

## Sprint 0 — Spec & Infrastructure Setup (1–2 days)

**Goal:** Lock the contract and provision all GCP resources before touching any code.

> All gaps in Sprint 0 are operational (typos, missing verification steps) — there is no novel code risk here.

### Deliverables

| # | Task | Done when | Success % | Gap | How to reach 100% |
|---|---|---|---|---|---|
| 0.1 | Confirm metadata fields: `project`, `tool`, `userName` | Written and agreed in `projectplan.md`; no open questions | 99% | 1% | Already documented. Re-read `projectplan.md` once before Sprint 1 kicks off. |
| 0.2 | Define object naming convention and sanitization rules | Naming pattern documented; 3 example paths written out and reviewed | 99% | 1% | Write 3 concrete example paths in `projectplan.md` before any code is written. |
| 0.3 | Choose Cloud region: `northamerica-northeast1` (Montréal) | Region recorded in `projectplan.md` and used in all infra commands | 99% | 1% | Grep all infra scripts for hardcoded region strings before Sprint 2 starts. |
| 0.4 | Choose auth strategy: API key via `X-Api-Key` header stored in Secret Manager | Decision documented; no alternative left open | 99% | 1% | Close any open Slack threads or comments about OAuth alternatives before starting. |
| 0.5 | Decide Chrome Web Store visibility: **Unlisted** | Recorded in `projectplan.md` | 99% | 1% | Already decided. No action needed. |
| 0.6 | Create GCP project; enable APIs | `gcloud services list` includes all 4 APIs | 97% | 3% | Run `infra/setup.ps1`; assert exit 0; re-run until clean. |
| 0.7 | Create GCS bucket with versioning off, 90-day lifecycle rule | `gcloud storage buckets describe` shows region and lifecycle | 97% | 3% | `gcloud storage buckets describe --format=json`; assert region + lifecycle fields immediately after creation. |
| 0.8 | Create service account with `roles/storage.objectCreator` | IAM policy on bucket lists SA with correct role | 97% | 3% | Run `gcloud storage buckets get-iam-policy` and grep for SA name immediately after binding. If missing, re-apply and re-verify. |
| 0.9 | Store API key in Secret Manager; grant SA accessor | `gcloud secrets versions access latest` returns key value | 96% | 4% | Run the access command as the SA via `--impersonate-service-account` — confirms it works from the SA's perspective, not just your own. |
| 0.10 | Set up Artifact Registry Docker repository | Describe command shows `format: DOCKER` | 97% | 3% | `gcloud artifacts repositories describe` right after creation; the only failure mode is a typo in the repo name. |

> **Note on 0.6:** `gsutil` commands are deprecated in favour of `gcloud storage`. All infra commands in this plan use `gcloud storage`.

---

## Sprint 1 — Extension Shell (3–5 days)

**Goal:** Working extension that captures a screenshot and logs the data URL to the console. No backend yet.

> **Architecture note — toolbar button vs. popup:**
> `chrome.action.onClicked` **does not fire when `default_popup` is set** in the manifest. Because the popup is always present (project/tool/name settings live there), the toolbar button click opens the popup — it cannot simultaneously trigger a capture. The three capture triggers are therefore: **(1) keyboard shortcut**, **(2) a dedicated "Capture Now" button inside the popup**, **(3) the floating page button injected by the content script**. Task 1.5 below reflects this.

> **⚠️ Developer Mode warning (Chrome 149+, June 2026):**
> Loading an unpacked extension in developer mode causes Chrome to show a "Disable developer mode extensions" banner **every time Chrome starts**. This is a Chrome security feature and cannot be suppressed in a standard profile. It is expected and normal during development. Dismiss it with the X or press Escape. The warning disappears permanently once the extension is published to the Chrome Web Store (even as Unlisted). Do not spend time trying to suppress it during Sprint 1 — it is not a bug.

### Deliverables

| # | Task | Done when | Success % | Gap | How to reach 100% |
|---|---|---|---|---|---|
| 1.1 | `manifest.json` with MV3, correct permissions | 0 errors in `chrome://extensions` | 98% | 2% | Copy the validated skeleton from this plan verbatim. Lint with `npx @crxjs/manifest-types` or the Chrome extension linter before loading — the only gap is a typo. |
| 1.2 | `commands` key with `Ctrl+Shift+S` / `Command+Shift+S` | Shortcut appears in `chrome://extensions/shortcuts`; logs `"command fired"` | 93% | 7% | **Known conflict risk on Windows:** `Ctrl+Shift+S` is claimed by AMD Radeon software, screen recorders, and some Office apps. Check `chrome://extensions/shortcuts` immediately after loading — Chrome shows "(Not set)" for conflicted keys. Reassign to `Ctrl+Shift+Y` and update `suggested_key` if silently swallowed. |
| 1.3 | Popup saves/loads via `chrome.storage.local` | All 3 fields reload after popup closed/reopened | 97% | 3% | Wrap every `chrome.storage.local.set` call in a try/catch and log errors. Test in an Incognito window. **Never use `localStorage` in an extension** — use `chrome.storage.local` only. |
| 1.4 | Service worker: `onCommand` calls `captureVisibleTab` | Logs PNG data URL > 10,000 chars | 95% | 5% | `captureVisibleTab` requires the tab to be active and focused. Ensure the Chrome window is foregrounded during tests. Assert `tab.active === true` before calling. |
| 1.5 | Popup "Capture Now" button sends `runtime.sendMessage` | Service worker receives message and logs PNG data URL | 94% | 6% | Listeners in `popup.js` only — never inline `onclick` in HTML (blocked by MV3 CSP). Verify the CSP allows no inline scripts. Attach all listeners via `addEventListener`. |
| 1.6 | `onMessage` relay from content script | Floating button message received; PNG data URL logged | 90% | **10%** | **Highest risk in Sprint 1.** Content scripts are not auto-injected into already-open tabs. Add `chrome.runtime.onInstalled` → `chrome.scripting.executeScript` for all open `http/https` tabs. Filter with `sender.frameId === 0` to ignore iframe messages. |
| 1.7 | Content script injects floating capture button | Button visible in DOM on any http/https page | 93% | 7% | `z-index: 2147483647`, `position: fixed`. Use a unique `id="thehammer-float-btn"` to detect and skip re-injection on already-open tabs after `onInstalled`. |
| 1.8 | Error handling on `chrome://` pages | Notification shown; no uncaught exception | 91% | 9% | Pre-check `tab.url.startsWith('chrome://')` before any API call. Never let `captureVisibleTab` execute on restricted pages — short-circuit first, then fire the notification. |
| 1.9 | PNG data URL is a real screenshot | Length > 10,000 chars; renders correctly | 97% | 3% | After capture, assert `dataUrl.startsWith('data:image/png;base64,')` and `dataUrl.length > 10000`. Log the actual value and show an error notification if either fails. |
| 1.10 | Service worker stays alive during async operations | Capture + log completes without silent drop | 93% | 7% | Open a `chrome.runtime.connect` port from the content script before sending the capture message; close it immediately after the response is received. This keeps the worker alive for the operation duration. |
| 1.11 | Admin config view exists (`admin.html` / `admin.js`) | Clicking "Admin" link in popup opens admin page | 96% | 4% | Use a separate HTML page (`admin.html`) with its own script (`admin.js`). The popup calls `chrome.tabs.create({ url: chrome.runtime.getURL('admin.html') })`. Test from a Chrome window with zero normal tabs open (extensions-only window). |
| 1.12 | Admin can create/update/delete Projects and Users | Admin UI shows 2 lists; changes persist via `chrome.storage.local` | 94% | 6% | Schema under `config` key: `{ projects: [...], users: [...] }`. Call `chrome.storage.local.set({ config })` on every change. Unit-test the pure add/remove functions separately so UI bugs are easier to isolate. |
| 1.13 | Popup Project/User dropdowns populate from admin config | Dropdowns show all configured Projects/Users | 95% | 5% | Read `config` from `chrome.storage.local` on `DOMContentLoaded`; populate two `<select>` elements. If `config` is missing (first run), fall back to a hardcoded seed list and prompt the admin to open the Admin view to customize. |
| 1.14 | Session selection stored under `session` key | After selecting Project/User, reload popup: same selection is shown | 96% | 4% | `chrome.storage.local.set({ session: { projectId, userId, tool } })` on Save. Verify with a full Chrome quit + reopen test — not just popup close. |
| 1.15 | Capture blocked when Project/User not set | All three triggers show clear error and do not capture | 95% | 5% | Read `session` in the service worker capture handler. If `!session || !session.projectId || !session.userId`, show a notification and **return early**. Test all three triggers (keyboard shortcut, popup button, floating button) in the no-session state. |

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

| # | Task | Done when | Success % | Gap | How to reach 100% |
|---|---|---|---|---|---|
| 2.1 | Express app with `POST /capture` and `GET /health` | `curl /health` → HTTP 200 `{ "status": "ok" }` | 97% | 3% | Health route must have zero dependencies on GCS/DB — must return 200 even if GCS is unreachable. Add `curl -f $SERVICE_URL/health` as a CI smoke test. |
| 2.2 | `multer` parses `multipart/form-data` | Valid upload 200; missing `file` field 400 | 95% | 5% | Set `fileSize: 10 * 1024 * 1024` limit. Test with a 0-byte file — it must return 400, not 200. Without a size limit, a large PNG silently hangs or OOMs the container. |
| 2.3 | Validate required fields; return 400 on missing | Each missing field returns 400 with field name | 97% | 3% | Validation middleware runs **before** `multer` so the file buffer is never loaded for a request that will be rejected. Test each field missing independently. |
| 2.4 | Sanitize fields; truncate to 64 chars | Object path contains sanitized values | 95% | 5% | Unit-test with 5 adversarial inputs: path traversal (`../../etc`), unicode (`café`), all-special-chars (`!!!`), empty string, 200-char string. All must produce a valid non-empty ≤ 64-char slug. |
| 2.5 | Build object path with timestamp | Name matches naming regex | 96% | 4% | Pure unit test with a mock clock. Assert two calls in the same millisecond produce different paths. Assert the regex match in the test, not just visually. |
| 2.6 | Upload buffer to GCS | Object appears in bucket within 5s | 94% | 6% | `save({ resumable: false })` for files < 5 MB. Return 502 (not 500) on GCS `ApiError` so the extension can distinguish a backend crash from a GCS failure. |
| 2.7 | Validate `X-Api-Key`; return 401 on mismatch | Missing/wrong key → 401; correct → 200 | 97% | 3% | `crypto.timingSafeEqual` for comparison. Key from `process.env.API_KEY` via `--set-secrets` — never a config file. |
| 2.8 | Return `{ success, path, size }` | Response matches GCS object metadata | 96% | 4% | `size` from `multer` `file.size` (bytes received), not a second GCS metadata call — avoids an extra round-trip. |

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

| # | Task | Done when | Success % | Gap | How to reach 100% |
|---|---|---|---|---|---|
| 2.9 | Convert data URL to `Blob` in service worker | `blob instanceof Blob`, `blob.type === 'image/png'` | 96% | 4% | `fetch(dataUrl).then(r => r.blob())` — more reliable than manual base64 decoding. Assert `blob.size > 0` before attaching to FormData. |
| 2.10 | `fetch()` POST to Cloud Run with `X-Api-Key` | Cloud Logging shows POST 200 < 5s | 93% | 7% | Hold `chrome.runtime.connect` port open for the full upload duration. Without it, a cold worker restart mid-upload silently drops the request. |
| 2.11 | Success notification shows GCS path | Notification contains full GCS path | 94% | 6% | Every `chrome.notifications.create` call requires a 128×128 `iconUrl` — a missing icon causes silent failure on some platforms. Include the icon in the extension package. |
| 2.12 | Error notification on failure | Error shown within 10s; no crash | 91% | **9%** | **Biggest risk in Sprint 2.** `AbortController` with a 15 s timeout on every `fetch`. This is one line of code but is easy to forget entirely — without it, a hung Cloud Run container leaves the user with no feedback. |
| 2.13 | Cloud Run URL configurable in settings | Changing URL routes to new service | 95% | 5% | Validate `https://` prefix before saving. Show an inline error in the popup — never silently save a broken URL. |

---

## Sprint 3 — Direct Signed URL Upload (3–4 days)

**Goal:** Reduce Cloud Run bandwidth by uploading the PNG directly from the extension to GCS via a V4 signed URL. Cloud Run issues the URL only — image bytes never pass through it.

> ⚠️ Only start this sprint after Sprint 2 is fully working end-to-end.

### Backend Deliverables

| # | Task | Done when | Success % | Gap | How to reach 100% |
|---|---|---|---|---|---|
| 3.1 | `POST /upload-url` accepts `{ project, tool, name }` | Returns HTTP 200 with `signedUrl` field | 95% | 5% | Reuse the 2.3/2.4 middleware — share, do not copy. Test with `curl` before wiring the extension. |
| 3.2 | Generates V4 signed PUT URL, 10-minute expiry | `curl -X PUT` with PNG returns 200; object in GCS | 91% | 9% | Confirm SA has `roles/iam.serviceAccountTokenCreator` (task 3.4) **before** writing signing code. The 403 from a missing role is cryptic and easy to misdiagnose as a signing bug. |
| 3.3 | Returns `{ signedUrl, path }` | Both fields present; path matches convention | 95% | 5% | Parse the signed URL and assert the embedded object name is identical to `path` in a unit test. |
| 3.4 | SA has `roles/iam.serviceAccountTokenCreator` | IAM policy lists role; signing does not 403 | 90% | **10%** | Self-binding: `gcloud iam service-accounts add-iam-policy-binding SA_EMAIL --role=roles/iam.serviceAccountTokenCreator --member=serviceAccount:SA_EMAIL`. Verify with `gcloud iam service-accounts get-iam-policy SA_EMAIL` immediately after. Grant **before** deploying signing code. |

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

| # | Task | Done when | Success % | Gap | How to reach 100% |
|---|---|---|---|---|---|
| 3.5 | POST to `/upload-url` and receive signed URL | Service worker logs URL starting with `https://storage.googleapis.com/...` | 92% | 8% | Log the full signed URL to the service worker console on the first successful run. Confirm `path` is also present. Only then write the PUT in task 3.6. |
| 3.6 | PUT blob directly to GCS signed URL | Object in GCS; Cloud Run logs show < 300 byte body | 88% | **12%** | `Content-Type: image/png` must be **identical** in both the signing call and the PUT header. A mismatch causes a silent 403 — the most common failure mode in this sprint. |
| 3.7 | Fallback to `/capture` on `/upload-url` failure | Mock 500 → extension uses `/capture`; object lands in GCS | 90% | 10% | Named function `uploadViaProxy()` called by both the fallback path and the primary path's catch block. No code divergence between the two paths. |

### CORS Verification

| # | Check | Done when | Success % | Gap | How to reach 100% |
|---|---|---|---|---|---|
| 3.8 | CORS preflight passes | `curl -X OPTIONS` returns 200 with correct `Access-Control-Allow-Origin` | 85% | **15%** | **Highest-risk task in the entire project.** Three steps before touching extension code: (1) Apply `cors.json`. (2) `gcloud storage buckets describe --format=json(cors)` — confirm it's set. (3) `curl -X OPTIONS` with your actual extension ID. Only proceed to task 3.6 after step 3 passes. Wait up to 5 minutes for CORS propagation. |
| 3.9 | Signed URL expires correctly | After 10-min TTL, PUT returns HTTP 403 | 93% | 7% | Passive verification — wait and test. Assert `expiresAt = Date.now() + 600_000` in the signing code and log it so the expiry is always visible. |

---

## Sprint 4 — Hardening & UX (3–5 days)

**Goal:** Production-ready reliability, retry logic, and optional history view.

### Extension Deliverables

| # | Task | Done when | Success % | Gap | How to reach 100% |
|---|---|---|---|---|---|
| 4.1 | Offline queue persisted in `chrome.storage.local` | 2 queued entries visible; both upload on restore | 88% | 12% | `queue` (pending) + `failed` (exhausted retries) arrays in storage. Drain `queue` on every service worker startup — the worker wakes on browser start, which is the natural drain trigger. |
| 4.2 | Exponential backoff retry (max 3, 1s/2s/4s) | 3 attempt logs with correct delays; 3rd fail → `failed` | 87% | **13%** | **Do not use `setTimeout` in a service worker** — callbacks are dropped when the worker sleeps. Short retries (1s/2s/4s) must run in a single wake cycle while the worker is alive. Only the final long retry falls back to `chrome.alarms` (30 s minimum floor). |
| 4.3 | Upload progress via `XMLHttpRequest.upload.onprogress` | Progress bar updates 0–100% for ≥ 100 KB PNG | 85% | **15%** | **`fetch()` has no upload progress in service workers** — must use `XMLHttpRequest` wrapped in a Promise. The `onprogress` handler posts progress back to the popup via `chrome.runtime.sendMessage`. Test with Chrome DevTools Network → Slow 3G throttling. |
| 4.4 | Settings persist all 5 fields across restart | All 5 fields reload after full Chrome restart | 95% | 5% | Single atomic `chrome.storage.local.set({ settings: { ...allFields } })` — not 5 separate calls. Prevents partial saves if the popup closes mid-save. |
| 4.5 | History tab: last 20 uploads; oldest drops at 21 | After 21 captures, exactly 20 rows | 86% | 14% | `history.unshift(newEntry); if (history.length > 20) history.pop();` — pure function, unit-tested at 0, 1, 20, and 21 items. |

### Backend Deliverables

| # | Task | Done when | Success % | Gap | How to reach 100% |
|---|---|---|---|---|---|
| 4.6 | Rate limiting: 60 req/IP/min via `express-rate-limit` | Requests 61–65 return HTTP 429 with `retryAfter` | 93% | 7% | `app.set('trust proxy', 1)` is required for Cloud Run — without it, all traffic appears from one IP and all users share one bucket. |
| 4.7 | Cloud Monitoring uptime check on `/health` | Stopping service causes alert email within 2 min | 91% | 9% | 1-minute check interval (not the default 5 min). Alert delay = 0 (fire on first failure, not after 2 consecutive). |
| 4.8 | Alert: error rate > 5% over 5 minutes | Alerting policy fires when 6/10 requests return 500 | 87% | 13% | Ratio condition `(5xx count / total count) > 0.05` over a 5-minute rolling window. Test by deploying a temporary handler returning 500 for 70% of `/capture` requests. |
| 4.9 | Firestore write on upload (optional) | Each upload creates document with 8 non-null fields | 89% | 11% | `set({ merge: false })` for idempotent retries. Document ID = URL-encoded GCS object path for deterministic deduplication. |

### Container Hardening Deliverables

| # | Task | Done when | Success % | Gap | How to reach 100% |
|---|---|---|---|---|---|
| 4.10 | Pin base image to digest | `FROM node:20-alpine@sha256:DIGEST`; build succeeds | 96% | 4% | `docker inspect --format='{{index .RepoDigests 0}}' node:20-alpine`. Add a comment with the date pinned. Set a calendar reminder to re-pin every 90 days. |
| 4.11 | Run as non-root user | `docker run --entrypoint whoami IMAGE` outputs `node` | 97% | 3% | `RUN chown -R node:node /app` after `COPY dist/`, then `USER node` before `CMD` — order matters; the `node` user can't read files it doesn't own. |
| 4.12 | `.dockerignore` excludes dev files | `ls /app` does not show `src/` or `node_modules/` | 96% | 4% | Whitelist approach: ignore everything (`*`), then allowlist (`!dist/`, `!package*.json`). Safer than a blacklist that can miss new dev files. |

---

## Success Probability Summary

| Sprint | Description | Avg Task % | Sprint-level % | Key risk task |
|---|---|---|---|---|
| Sprint 0 | Spec & Infrastructure | 98% | **97%** | 0.9 — SA secret access verification (4% gap) |
| Sprint 1 | Extension Shell | 95% | **90%** | 1.6 — Content script injection into open tabs (10% gap) |
| Sprint 2 | Cloud Run + GCS Upload | 95% | **83%** | 2.12 — Error notification + AbortController (9% gap) |
| Sprint 3 | Direct Signed URL Upload | 91% | **72%** | 3.8 — CORS preflight verification (15% gap) |
| Sprint 4 | Hardening & UX | 91% | **70%** | 4.3 — XHR upload progress (15% gap) |
| **Full project end-to-end** | All sprints complete | — | **~58–63%** | Sprint 3 CORS + Sprint 4 retry/progress |

> With every "How to reach 100%" mitigation applied, conservative re-estimates: Sprint 1 → 95%, Sprint 2 → 90%, Sprint 3 → 82%, Sprint 4 → 78%. Full project → **~67–72%**.

### Top 3 Project-Level Risks by Gap Size

| Rank | Task | Gap | Why it stalls projects | Fix in one sentence |
|---|---|---|---|---|
| 1 | 3.8 CORS preflight | 15% | CORS config propagates slowly and the error is opaque | Verify with `curl -X OPTIONS` before touching any extension code |
| 2 | 4.3 XHR upload progress | 15% | Developers reach for `fetch()` by default and hit a dead end | Decide upfront to use `XMLHttpRequest` for the upload call |
| 3 | 3.6 Signed URL PUT | 12% | `Content-Type` mismatch causes a silent 403 | Set `Content-Type: image/png` identically in both the signing call and the PUT |

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
| XHR progress events not reaching popup | Medium | Use `XMLHttpRequest` (not `fetch`) for upload; post progress via `chrome.runtime.sendMessage` (task 4.3) |
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
