# The Hammer — Sprint Plan 2

## Overview

Sprints 5–9 extend The Hammer from a screenshot-capture tool into a **multi-role cloud platform**: a cloud-hosted Admin Portal, per-user activity and inactivity tracking, an Analyst report engine, and a cloud-based Instructional Designer workspace. All new work builds on the Firestore `uploads` collection and Cloud Run backend established in Sprints 0–4.

> **Network ingress layer (Global HTTPS LB, Cloud Armor WAF, Cloud DNS, SSL cert) is fully owned by [Sprint 21](./sprint21.md).** Sprint 21 must complete before Sprint 5 goes to production — the Admin Portal is deployed behind the LB, not via direct `*.run.app` URLs.

> **All architecture decisions referenced below are resolved in [`arch_decisions.md`](./arch_decisions.md).** Open questions in earlier drafts are closed — this document reflects the agreed decisions.

> **All development work must adhere strictly to [`dev_guiderails.md`](./dev_guiderails.md).** Failure to meet the explicit "Done when" conditions, introducing phantom dependencies, or adding unauthorized scope will result in an immediate rejected Pull Request.

---

## Architecture Decisions Baked In

| Decision | Resolution (see `arch_decisions.md`) |
|---|---|
| Cloud Run topology | 3 services (`hammer-api`, `hammer-portal`, `hammer-export` Job) + 1 Cloud Run Job for FFmpeg |
| Admin Portal auth | Cloud IAP — no custom auth middleware; read `X-Goog-Authenticated-User-Email` header |
| API key storage | Firestore `api_keys` collection; SHA-256 hash at rest; raw key shown once |
| Firestore schema | Flat `uploads` collection with `projectId` field; `schemaVersion` on all docs; `deleteAfter` TTL on `session_events` / `inactivity_events` |
| Firestore transaction | Required on `POST /admin/projects/:id/members` — atomically write membership doc + increment `project.memberCount` |
| Extension ID | Locked via CRX key; stored in Secret Manager as `EXTENSION_ID`; used in CORS allowlist |
| CORS | `https://app.thehammer.io` + `chrome-extension://${EXTENSION_ID}`; never `*` |
| FFmpeg export | Cloud Run **Job**, not Service; triggered via Cloud Tasks; `--task-timeout 1800s`; 50-slide hard ceiling |
| Monitoring alerts | 8 calibrated alerts (§6.3 of `arch_decisions.md`); 4 SLO objects in Cloud Monitoring |
| Container registry | Artifact Registry `northamerica-northeast1-docker.pkg.dev/{PROJECT_ID}/thehammer/`; tagged with `$COMMIT_SHA`; never `latest` |
| Deploy process | **Google Cloud Build trigger on push to `main`** — defined in `cloudbuild.yaml`; pipeline is live and must not be modified; no local `gcloud run deploy`, no GitHub Actions deploy steps |
| IaC | Terraform; `hammer-dev` + `hammer-prod` projects; all resources in `infra/` |

---

### Four New Roles

| Role | What they do |
|---|---|
| **Admin** | Creates projects, admits users, assigns roles, reviews per-project/per-tool activity, reads analyst reports |
| **Analyst** | Generates user efficiency, project progress, GTM/GA4/Ads audit, and executive summary reports |
| **Instructional Designer** | Sequences screenshots into annotated storyboards, exports cloud-rendered MP4 videos and PDF instruction docs |
| **User** | Captures screenshots; session timestamps (first + last) auto-logged; prompted after 45 s of inactivity |

### Build Order

```
Sprint 21 → HTTPS LB + Cloud Armor + Cloud DNS  ← prerequisite for all portal work
Sprint 5  → Admin Portal (CRUD + SPA)
Sprint 6  → Inactivity tracking + session timestamps  
Sprint 6S → Research spike: chrome.alarms sub-minute timing + OCR pipeline (red items isolated)
Sprint 7  → Analyst Engine: Firestore reports + OCR reports (unblocked by 6S findings)
Sprint 8  → Instructional Designer workspace
Sprint 9  → Role-based auth hardening + integration tests + monitoring
```

---

## Probability Scale

| Symbol | P% | What it means |
|---|---|---|
| 🟢 | 90–100% | Established pattern on this stack; low novelty |
| 🟡 | 70–89% | One known gotcha or moderate complexity |
| 🟠 | 50–69% | First-time pattern, external dependency, or multi-step failure surface |
| 🔴 | < 50% | Novel integration, MV3 platform constraint, or accuracy-dependent pipeline |

Probabilities reflect **first-attempt completion** without rework. A 🔴 task is not deferred — it is either mitigated (see Sprint 6S) or has an explicit fallback built into the done-when condition.

---

## Sprint 5 — Admin Portal

**Goal:** Cloud-hosted portal where admin creates projects, admits users, and monitors per-tool activity.

**Sprint P%: 🟡 79%** — Backend CRUD is a copy-paste of existing Express/Firestore patterns. Risk concentrates in 5.15 (extension migration off local storage) and 5.11 (thumbnail signed URL refresh timing).

> **Prerequisite:** Sprint 21 must be complete and `https://app.thehammer.io` must be live before Sprint 5 is considered production-ready. Development and testing may proceed against direct Cloud Run URLs; production cutover requires the LB.

> **Auth decision resolved:** Admin Portal is protected by **Cloud IAP** on the HTTPS LB. No custom auth middleware is written for the portal SPA. `hammer-api` reads the `X-Goog-Authenticated-User-Email` header injected by IAP for identity; the `X-Api-Key` middleware remains for programmatic extension calls.

### Pre-flight
All Sprint 4 console items (M.1–M.4, I.1–I.4, A.1–A.2, C.1–C.4, F.1–F.3) verified ✅ before any Sprint 5 code is written.

Additional pre-flight for Sprint 5:
- [x] Developer understands all deployments flow through the **Google Cloud Build trigger** (`cloudbuild.yaml`) on push to `main` — no local `gcloud` deploys, no manual steps
- [ ] CRX key generated; `EXTENSION_ID` stored in Secret Manager — required before CORS is configured
- [ ] `gcloud firestore databases describe` confirms `type: FIRESTORE_NATIVE`
- [ ] IAP OAuth consent screen created in `hammer-prod` — **HARD BLOCKER**; without it, IAP will not inject `X-Goog-Authenticated-User-Email` and Sprint 5.13 auth guard cannot function
- [ ] Artifact Registry repo `northamerica-northeast1-docker.pkg.dev/{PROJECT_ID}/thehammer/` confirmed live

### Backend — Express + Firestore

| # | Task | Done when | P% |
|---|---|---|---|
| 5.1 | Firestore data model: `projects`, `users`, `project_memberships` | Schema documented in `projectplan.md`; flat `uploads` collection confirmed (no subcollections); `schemaVersion: 1` field on all new doc types; 3 example JSON docs per collection | ✅ done |
| 5.2 | `POST /admin/projects` | Returns `201 { projectId, name, createdAt }`; doc visible in Firestore; `schemaVersion: 1` present | ✅ done |
| 5.3 | `GET /admin/projects` | Returns array; each item includes `memberCount` via Firestore `count()` aggregation query (not client-side count) | ✅ done* |
| 5.4 | `PATCH /admin/projects/:id` | Partial update; updated fields reflected in Firestore within 2 s; additive-only — no field renames | ✅ done |
| 5.5 | `DELETE /admin/projects/:id` | Project doc + all `project_memberships` subcollection docs deleted in a batched write; returns 204 | ✅ done |
| 5.6 | `POST /admin/projects/:id/members` | Firestore **transaction**: atomically writes `project_memberships/{userId}` doc AND increments `project.memberCount`; `role` field present | ✅ done |
| 5.7 | `DELETE /admin/projects/:id/members/:userId` | Membership doc deleted; `GET /admin/projects/:id` member count decrements (transaction); verified | ✅ done |
| 5.8 | `GET /admin/projects/:id/activity` | Returns last 100 `uploads` docs for project; `?tool=` filter uses composite index `(projectId ASC, tool ASC, uploadedAt DESC)` declared in `firestore.indexes.json` | ✅ done |
| 5.8b | `GET /me/projects` | Resolves user identity from `X-Api-Key`; returns only projects assigned to that user | ✅ done |
| 5.8c | `GET /config` | Returns global extension settings (retention days, max size, etc.) configured by admins | ✅ done |

> **Deviation note for 5.3:** Implementation returns the denormalized `memberCount` field stored on each `projects` document and maintained transactionally by 5.6/5.7, rather than issuing a live Firestore `count()` aggregation per project row. This still satisfies the architectural intent of "not client-side count" while avoiding N extra aggregation queries on the project list path.

### Admin Portal SPA

| # | Task | Done when | P% |
|---|---|---|---|
| 5.9 | Project list view | Table: project name, member count, last capture timestamp; create/delete buttons functional | 🟢 91% |
| 5.10 | Project detail — user roster | Admitted users listed with role badge; Admit and Remove buttons update Firestore via transaction and re-render without full page reload | 🟡 84% |
| 5.11 | Activity feed per tool | `?tool=` filter applied on click; screenshot thumbnails load via V4 signed URLs (15-min lifetime); URLs auto-refreshed on `visibilitychange` + proactive refresh after 9 min | 🟡 79% |
| 5.12 | Report viewer tab (placeholder) | Panel fetches `reports` Firestore collection; renders "No reports yet" empty state; full render deferred to Sprint 7 | 🟢 93% |
| 5.12b | Global Settings panel | Admins can update global capture settings (retention, etc.) persisting to Firestore config doc | 🟢 94% |
| 5.12c | User Profile view | Logged-in user can view assigned projects and copy their Personal API Key | 🟢 95% |
| 5.13 | Auth guard | Portal is protected by Cloud IAP at the LB level — no unauthenticated request reaches the SPA. `hammer-api` routes read `X-Goog-Authenticated-User-Email` header for identity; missing or invalid `X-Api-Key` → 401 on all `/admin/*` API routes | 🟢 96% |
| 5.14 | Deploy Admin Portal to Cloud Run | Image built and pushed to Artifact Registry tagged with `$COMMIT_SHA` by **Cloud Build trigger** on push to `main`; `hammer-portal` deployed automatically by `cloudbuild.yaml` step 8; smoke test in `cloudbuild.yaml` step 9 verifies `curl $PORTAL_URL/health` → `{"status":"ok"}`; accessible via `https://app.thehammer.io` after Sprint 21 LB cutover — **do not modify `cloudbuild.yaml` or trigger configuration** | 🟢 92% |

### Extension Migration

| # | Task | Done when | P% |
|---|---|---|---|
| 5.15 | Personal API Key auth | User pastes Personal API Key (generated in Portal); Backend URL defaults to `https://app.thehammer.io/api` (no typing needed); "User" dropdown is completely removed because backend identifies them via their key | ✅ done |
| 5.16 | Auto-select Project & Stage | Popup dropdown reads `GET /me/projects`; if only one project is returned, automatically selects it and hides the dropdown; introduces new "Project Stage" dropdown (Beginning / During / After) saved to Firestore | ✅ done |
| 5.17 | Centralized Admin Settings | Configuration settings (Cloud Run URL, retention periods, default capture sizes) are fetched from `GET /config`; Popup Settings tab is disabled or made read-only | 🟢 94% |

> **Mitigation for 5.15–5.17:** Extension falls back to cached `chrome.storage.local` if `app.thehammer.io` is unreachable to ensure capture isn't blocked offline.

---

## Sprint 6 — Session Timestamps & Inactivity Tracking

**Goal:** Log first/last capture timestamps per session; prompt user after 45 s of inactivity using a reliable timer strategy.

**Sprint P%: 🟡 74%** — Timestamp logging is high-confidence. Inactivity timer delivery depends on the findings of Sprint 6S (research spike). If 6S validates the hybrid `chrome.alarms` + `Date` approach, tasks 6.4 and 6.10 execute cleanly. If not, the fallback (1-minute alarm with UX copy adjusted to "about a minute") is the accepted done-when condition.

> **Architectural constraint:** The inactivity timer must use `chrome.alarms`, not `setTimeout` / `setInterval`. Manifest V3 service workers are suspended aggressively when idle, so standard JS timers are not reliable after suspension.

### Session Timestamps

| # | Task | Done when | P% |
|---|---|---|---|
| 6.1 | `sessionStart` logged on first capture | First `uploads` doc of each session has `isFirstInSession: true` and `sessionStart` ISO timestamp | 🟢 93% |
| 6.2 | `sessionEnd` logged on session close | `session_events` Firestore doc written with `sessionEnd`, `totalCaptures`, `sessionDurationMs` via double-flush: `chrome.runtime.onSuspend` + `chrome.windows.onRemoved`; in-progress session state persisted in `chrome.storage.session` so a SW restart can resume without creating a new session | 🟡 72% |
| 6.3 | Session summary doc complete | `session_events` doc contains all required fields: `sessionId`, `projectId`, `userId`, `sessionStart`, `sessionEnd`, `totalCaptures`, `firstCapturePath`, `lastCapturePath`, `schemaVersion: 1`, `deleteAfter` (= `sessionStart + 365 days` for Firestore TTL auto-deletion) | 🟡 74% |

### Inactivity Timer

| # | Task | Done when | P% |
|---|---|---|---|
| 6.4 | 45 s inactivity timer fires reliably | `inactivity_warning` message fires within 5 s of the 45 s window (hybrid `chrome.alarms` + in-memory `Date` check) — OR — fires at nearest `chrome.alarms` tick (≤ 60 s) if sub-minute confirmed infeasible by Sprint 6S | 🟡 71% |
| 6.5 | Inactivity dialogue in popup | Popup receives `inactivity_warning` and renders modal: "Still there? Ready to capture?" with **Capture Now** and **Snooze** buttons | 🟡 79% |
| 6.6 | Notification fallback when popup is closed | If popup is not open, `chrome.notifications.create` shows a system notification with "Capture" action button; suppressed on `chrome://` and non-http/https tab URLs | 🟡 76% |
| 6.7 | Dialogue auto-dismisses after 30 s | Modal closes without action; next inactivity cycle starts fresh | 🟡 77% |
| 6.8 | Timer resets on every capture event | All three capture triggers (keyboard, toolbar, floating button) cancel and restart the alarm; verified across all three | 🟢 91% |
| 6.9 | Inactivity events logged to Firestore | `inactivity_events` doc: `triggeredAt`, `userId`, `projectId`, `acknowledged` (bool), `schemaVersion: 1`, `deleteAfter` (= `triggeredAt + 365 days` for TTL) | 🟡 83% |
| 6.10 | `chrome.alarms` used (not `setTimeout`) — verified post-suspend | Service worker uses `chrome.runtime.connect` keepalive port from popup + `chrome.storage.session` for in-flight state; after device screen lock for 60 s, alarm fires on resume; `setTimeout`-only implementation fails this test | 🟡 70% |

### Admin Portal: Inactivity Visibility

| # | Task | Done when | P% |
|---|---|---|---|
| 6.11 | Activity timeline highlights gaps > 45 s | Gaps between consecutive capture timestamps > 45 s rendered in amber on the activity feed; uses `(projectId ASC, userId ASC, uploadedAt DESC)` composite index | 🟡 76% |

---

## Sprint 6S — Research Spike

**Goal:** De-risk the two families of 🔴 tasks before they enter delivery sprints. Produces documented findings and a proof-of-concept — not production code.

**Sprint P%: 🟢 91%** — A spike produces a decision either way; it cannot fail in the traditional sense.

| # | Task | Done when | P% |
|---|---|---|---|
| S.1 | Validate `chrome.alarms` sub-minute timing | Test extension measures actual firing latency across 50 cycles; min/max/mean delay documented per Chrome version | 🟢 95% |
| S.2 | Document hybrid timer decision | "Sub-minute feasible via in-memory `Date` + 1-min alarm" or "target 60 s, update UX copy" — agreed by team, written in `projectplan.md` before Sprint 6 tasks 6.4/6.10 are coded | 🟢 95% |
| S.3 | OCR/Vision API evaluation | Google Cloud Vision vs GPT-4o vision vs Gemini 1.5 Pro tested on 10 real GTM screenshots; for OCR accuracy evaluate both PNG and lossless WebP inputs; extraction accuracy for Tags/Triggers/Variables recorded per API | 🟠 68% |
| S.4 | OCR proof-of-concept | Single Cloud Run function accepts GCS screenshot path (`hammer-screenshots-{PROJECT_ID}` bucket); returns GTM config JSON; accuracy ≥ 70% on test corpus = spike passes | 🟠 62% |
| S.5 | OCR cost model | Per-image cost at 150 captures/day (Vision API: ~$0.0015/image = ~$9/month); caching strategy to avoid re-processing identical GCS paths documented | 🟢 90% |
| S.6 | Go/No-go decision on OCR reports | If S.4 accuracy < 70%: Sprint 7 tasks 7.8–7.11 replaced with CSV-import workflow; decision written in `projectplan.md` | 🟢 93% |

---

## Sprint 7 — Analyst Engine

**Goal:** Analyst generates structured reports stored in GCS + indexed in Firestore; Admin Portal Report Viewer functional.

**Sprint P%: 🟡 71%** — Firestore-aggregation reports are high-confidence. OCR reports (7.8–7.11) only enter this sprint if Sprint 6S S.4 passes; otherwise replaced by CSV-import workflow.

> **Auth decision resolved:** `/reports/*` routes check the SHA-256 hash of the `X-Api-Key` header against the Firestore `api_keys` collection and assert `role == 'analyst'`.

> **OCR scope confirmed:** Only GTM Configuration, GA4 Configuration, and Google Ads Setup require OCR. User Efficiency and Project Progress reports are generated from Firestore metadata alone. A Vision API cost benchmark is required before Sprint 7 ships.

### Report Infrastructure

| # | Task | Done when | P% |
|---|---|---|---|
| 7.1 | `POST /reports/generate` | Accepts `{ projectId, reportType, dateRange }`; writes `reports` Firestore doc with `status: "queued"`, `schemaVersion: 1`; enqueues Cloud Tasks task targeting the `hammer-api` report worker; returns `{ reportId }` within 200 ms | 🟢 94% |
| 7.2 | `GET /reports/:id/status` | Returns `{ status: "queued" \| "processing" \| "done" \| "error", gcsPath? }` | 🟡 86% |
| 7.3 | Analyst role enforced on `/reports/*` | Middleware: `sha256(req.headers['x-api-key'])` looked up in `api_keys` collection; `role != 'analyst'` → 403; verified for POST + GET | 🟢 94% |
| 7.4 | Report metadata in Firestore | Every completed report doc: `reportId`, `type`, `projectId`, `generatedBy`, `generatedAt`, `gcsPath`, `status`, `schemaVersion: 1` | 🟢 92% |

### Firestore-Aggregation Reports

| # | Task | Done when | P% |
|---|---|---|---|
| 7.5 | Report: **User Efficiency** | Captures/hour, inactivity rate (from `inactivity_events`), median session length from `session_events`; all metrics via Firestore `count()` + aggregation; GCS `hammer-reports-{PROJECT_ID}` JSON + HTML | 🟢 91% |
| 7.6 | Report: **Project Progress** | Total captures (`count()`), daily trend array, active users, tools used; GCS JSON + HTML | 🟢 91% |
| 7.7 | Report: **Executive Summary** | Before/After narrative filled from Firestore data using a Markdown template; LLM fill is an optional enhancement, not required for done-when | 🟡 78% |

### OCR-Dependent Reports *(conditional on Sprint 6S S.4 passing)*

| # | Task | Done when | P% |
|---|---|---|---|
| 7.8 | Report: **GTM Configuration Table** | Screenshots from `hammer-screenshots-{PROJECT_ID}` → OCR → Tags/Triggers/Variables Markdown table; ≥ 80% field coverage on test corpus | 🟠 64% |
| 7.9 | Report: **GA4 Configuration** | Measurement ID, custom events, cross-domain settings → JSON + HTML stored in `hammer-reports-{PROJECT_ID}` | 🟠 62% |
| 7.10 | Report: **Google Ads Setup** | Conversion Linker, Tracking IDs, imported conversions → JSON + HTML | 🟠 60% |
| 7.11 | Report: **Audit & Conflicts** | Missing consent mode, poorly named tags, unlinked properties; severity `error` / `warning` / `info`; sortable table | 🟠 65% |

> **If Sprint 6S S.4 did not pass:** 7.8–7.11 are replaced with a CSV-import workflow (analyst uploads structured config CSV → engine formats to same output). CSV-import variant P%: 🟢 88%.

### Admin Portal — Report Viewer

| # | Task | Done when | P% |
|---|---|---|---|
| 7.12 | Report Viewer renders all types | HTML from `hammer-reports-{PROJECT_ID}` in sandboxed iframe via V4 signed URL (60-min lifetime); Markdown rendered as styled HTML; table reports client-side sortable | 🟡 79% |

---

## Sprint 8 — Instructional Designer Workspace

**Goal:** Cloud-only screenshot → storyboard → annotated MP4 + PDF pipeline.

**Sprint P%: 🟠 63%** — Screenshot browser and annotation editor are high-confidence. FFmpeg subtitle burn-in (8.6) and drag-and-drop sequencing (8.2) are the primary risk items.

> **FFmpeg decision resolved:** `hammer-export` is a **Cloud Run Job** (not a Service), triggered via Cloud Tasks. `--task-timeout 1800s`. 50-slide hard ceiling is non-negotiable and must be enforced before FFmpeg starts; requests above the limit should be rejected with HTTP 400 before enqueue. Job SA is `hammer-export-sa` with `roles/storage.objectAdmin` on `hammer-exports-{PROJECT_ID}` bucket only.

### Screenshot Browser & Storyboard

| # | Task | Done when | P% |
|---|---|---|---|
| 8.1 | Screenshot grid view | GCS `hammer-screenshots-{PROJECT_ID}` screenshots paginated 20/page; V4 signed URLs (15-min lifetime) batch-generated; sorted by `uploadedAt` ascending | 🟡 86% |
| 8.2 | Drag-and-drop storyboard sequencing | SortableJS (CDN) reorders slides; sequence JSON saved to Firestore `storyboards` on drop; storyboard doc has `schemaVersion: 1`; works on desktop and touch (SortableJS Pointer Events API) | 🟠 66% |
| 8.3 | Per-slide annotation editor | Click thumbnail → `<textarea>` side panel opens; debounce-saved to storyboard doc (500 ms) | 🟡 86% |
| 8.4 | Import Analyst report as narrative seed | "Import Executive Summary" maps report paragraphs to slides by timestamp proximity; user can re-assign; pre-loaded text is editable | 🟡 77% |

### Cloud Video Export

| # | Task | Done when | P% |
|---|---|---|---|
| 8.5 | `POST /export/video` | Accepts `{ storyboardId, durationPerSlideMs, transitionMs }`; storyboard capped at 50 slides (enforced here before enqueue, reject > 50 with HTTP 400); enqueues Cloud Tasks task targeting `hammer-export` Cloud Run Job; returns `{ jobId }` within 200 ms | 🟢 93% |
| 8.6 | FFmpeg job: screenshots → H.264 MP4 with subtitle burn-in | Cloud Run Job (`hammer-export`); 1280×720 MP4; each slide held for `durationPerSlideMs` (default 3 s); annotation text via `drawtext` filter + bundled Noto Sans font; `--task-timeout 1800s` | 🟠 63% |
| 8.7 | FFmpeg progress reporting | `GET /export/video/:jobId/status` returns `{ status, progressPercent }` parsed from FFmpeg stderr `time=` tokens; job state persisted in Firestore | 🟡 79% |
| 8.8 | Video stored in GCS `hammer-exports-{PROJECT_ID}` | Path: `exports/{projectId}/{storyboardId}/{timestamp}.mp4`; 24-hour V4 signed URL returned in status response; bucket lifecycle: Day 30 → NEARLINE, Day 90 → delete | 🟢 91% |
| 8.9 | HTML5 video preview + download | `<video>` player loads via signed URL; CORS `AllowedOrigins` set on `hammer-exports-{PROJECT_ID}` bucket to `https://app.thehammer.io`; "Download" triggers blob download | 🟡 82% |

### Document Export & Access Control

| # | Task | Done when | P% |
|---|---|---|---|
| 8.10 | PDF instruction export | "Export PDF" renders thumbnails + annotations via `@media print`; `window.print()` produces clean single-column document in Chrome | 🟡 76% |
| 8.11 | Instructional Designer role enforced | `sha256(req.headers['x-api-key'])` asserted as `role == 'instructional_designer'` from `api_keys` collection; non-ID key → 403 on `/export/*` and storyboard write routes | 🟢 94% |
| 8.12 | Admin sees completed exports | Exports tab: all MP4s listed with title, author, `createdAt`, 24-hour signed URL download link | 🟡 84% |

---

## Sprint 9 — Hardening, Auth & Integration

**Goal:** Unified role-based auth, integration + smoke test suite, Cloud Monitoring expansion (application-layer alerts), Firestore security rules, Binary Authorization, mobile-responsive portal.

**Sprint P%: 🟡 73%** — Individual tasks are well-understood. Sprint-level risk is that integration tests (9.5, 9.6) surface bugs from Sprints 5–8; budget rework time.

> **Note:** Network-layer monitoring (LB 5xx rate, Cloud Armor block rate) is owned by [Sprint 21](./sprint21.md) tasks 21.21–21.22. Sprint 9 monitoring covers application-layer alerts only (report failures, export queue depth, GCS 403 rate, Firestore quota, Secret Manager failures, billing anomaly).

### Role-Based Auth

| # | Task | Done when | P% |
|---|---|---|---|
| 9.1 | Role storage — **resolved: Firestore `api_keys` collection** | `api_keys` collection live; each doc: `{ keyHash, userId, role, createdAt, isActive, lastUsed }`; admin portal "Generate Key" flow issues key (shown once, never stored raw); decision recorded in `projectplan.md` | 🟢 96% |
| 9.2 | Role-aware API key middleware | `sha256(req.headers['x-api-key'])` queried against `api_keys` where `isActive == true`; role attached to `req.user`; per-route role assertion; all 401/403 logged to Cloud Logging with `requestId`, `userId`, `path` | 🟡 81% |
| 9.3 | Role assignment in Admin Portal | Admin views and changes user role in portal; change writes to `api_keys.role`; propagates within 10 s; reflected on next API request (no cache to invalidate — lookup is per-request) | 🟠 66% |
| 9.4 | Per-role rate limiting | Analyst reports: 10 req/hr; video export: 5 req/hr; capture: 60 req/min (existing); rate limit state in memory (single Cloud Run instance) or Firestore counter if multi-instance; verified by sending requests above threshold | 🟡 83% |

### Testing

| # | Task | Done when | P% |
|---|---|---|---|
| 9.5 | Integration test suite | `npm run test:integration` covers: project CRUD (with transaction), user admission, capture → Firestore, report generation (mock OCR), video export (mock Cloud Tasks + FFmpeg), inactivity logging, SHA-256 key middleware; all pass in **Cloud Build CI** (`cloudbuild.yaml` test step) | 🟡 74% |
| 9.6 | End-to-end smoke test script | `scripts/smoke-test.sh` exercises all 4 roles against `https://app.thehammer.io`; exits 0; **runs as a step in `cloudbuild.yaml` on every push to `main`** — if smoke test fails, Cloud Run keeps the previous revision at 100% traffic; do not add a separate CI trigger | 🟡 71% |

### Cloud Monitoring — Application Layer

The full 8-alert set from `arch_decisions.md` §6.3 is implemented here. Alerts 21.21–21.22 (LB 5xx, Cloud Armor block rate) are excluded — owned by Sprint 21.

| # | Task | Alert condition | Severity | P% |
|---|---|---|---|---|
| 9.7 | Report failure alert | > 10% of `reports` docs reach `status: error` in 10 min | P1 — Slack `#hammer-alerts` + email | 🟡 81% |
| 9.8 | Export queue depth alert | > 10 export jobs `status: "queued"` for > 5 min; log-based metric via Cloud Function | P2 — email | 🟡 77% |
| 9.8b | API p99 latency alert | `hammer-api` p99 > 3 s over 5 min | P2 — email | 🟡 80% |
| 9.8c | GCS 403 rate alert | > 10 GCS 403 responses in 5 min | P2 — email | 🟡 82% |
| 9.8d | Firestore quota alert | Daily reads > 80% of quota | P3 — email | 🟢 90% |
| 9.8e | Secret Manager failure alert | `accessSecretVersion` error rate > 0 | P1 — Slack + email | 🟢 92% |
| 9.8f | Billing anomaly alert | Daily spend > 2× 30-day average; Pub/Sub → Cloud Function circuit breaker sets `hammer-export` + `hammer-portal` to `--max-instances 0` | P2 — email | 🟡 78% |
| 9.9 | GCS lifecycle rule for `hammer-exports-{PROJECT_ID}` | Day 30 → NEARLINE; Day 90 → delete; `hammer-screenshots-{PROJECT_ID}`: Day 365 → NEARLINE, Day 730 → COLDLINE; verified with `gcloud storage buckets describe` | 🟢 96% |
| 9.10 | 4 SLO objects in Cloud Monitoring | Capture endpoint 99.5% / p99 < 2 s; Report generation 95% within 5 min; Video export 90% within 15 min; Admin Portal 99.0%; all created as Cloud Monitoring SLO objects with error budget burn rate alerts | 🟡 79% |

### Security & Polish

| # | Task | Done when | P% |
|---|---|---|---|
| 9.11 | Firestore security rules | Direct writes to `projects`, `users`, `reports`, `storyboards`, `api_keys` blocked for all non-SA principals; `api_keys.keyHash` field not readable by any client; tested with Firebase emulator; deployed via `firebase deploy --only firestore:rules` in CI | 🟡 77% |
| 9.12 | Binary Authorization | Policy: only images signed by the Cloud Build service account via Cloud Build can be deployed to Cloud Run; prevents ad-hoc `gcloud run deploy` from laptop; added to `infra/cloud_run.tf` | 🟡 75% |
| 9.13 | Key rotation automation | Cloud Scheduler (quarterly) → Cloud Function: generates new key per active user, writes to `pending_rotations`, emails new key, sets 7-day grace period; daily cleanup sets `isActive: false` on expired keys | 🟠 68% |
| 9.14 | `runbook.md` created | Three minimum procedures documented: (1) Cloud Run revision rollback, (2) flush stuck export job, (3) revoke compromised API key; verified each procedure executes successfully in `hammer-dev` | 🟢 95% |
| 9.15 | Admin Portal consolidated dashboard | 5 live metrics via Firestore `onSnapshot`: active projects, active users today, screenshots today, pending reports, pending exports | 🟡 76% |
| 9.16 | Mobile-responsive Admin Portal | All views usable at 375px; tables → card lists; touch targets ≥ 44px; tested on real device | 🟡 81% |
| 9.17 | `lessons_learned.md` updated | ≥ 3 new lessons from Sprints 5–9 with root cause + resolution | 🟢 98% |

---

## Sprint 10 — Extension Superpowers (Growth & Friction)

**Goal:** Zero-friction data quality (auto-tagging, right-click capture) and admin-gated enterprise features (Blur, Clipboard links).

**Sprint P%: 🟡 71%** — Content scripts and DOM parsing are inherently fragile across different websites; rigorous cross-site testing required.

| # | Task | Done when | P% |
|---|---|---|---|
| 10.1 | Context Engine Auto-tagging | Content script scrapes page title and URL; auto-fills `tool` (e.g., matching `figma.com` -> Figma, or extracting Jira `PROJ-123` ID) | 🟡 75% |
| 10.2 | Right-Click Element Capture | Injects Chrome Context Menu "Hammer: Capture this element"; intercepts click, isolates DOM element bounding box, crops PNG before upload | 🟠 65% |
| 10.3 | Admin Feature Entitlements | Admin User Detail API/View adds toggles for "Allow Pre-Upload Blur" and "Instant Clipboard Links"; saved as boolean properties on `users` doc | 🟢 95% |
| 10.4 | Pre-Upload Privacy Blur | Guarded by entitlement check in 10.3. If enabled, capture opens a 3-second overlay canvas where user can drag rects to irreversibly blur pixels before GCS PUT | 🟠 62% |
| 10.5 | Instant Clipboard Links | Guarded by entitlement check. If enabled, the `signedUrl` (or Portal View URL) generated to view the image is automatically injected into `navigator.clipboard` immediately after 200 OK | 🟢 88% |

---

## Sprint-Level Summary

| Sprint | Focus | P% | Biggest single risk |
|---|---|---|---|
| 21 | HTTPS LB + Cloud Armor + DNS | 🟡 81% | 21.15 — Cloud Armor false positives on extension POST |
| 5 | Admin Portal + project/user CRUD | 🟡 79% | 5.15 — extension migration off `chrome.storage.local` |
| 6 | Session timestamps + inactivity timer | 🟡 74% | 6.2 — `sessionEnd` flush on Chrome shutdown |
| 6S | Research spike (alarms + OCR) | 🟢 91% | S.4 — OCR PoC accuracy on real GTM screenshots |
| 7 | Analyst report engine | 🟡 71% | 7.8–7.11 — OCR extraction accuracy (conditional on 6S) |
| 8 | Instructional Designer workspace | 🟠 63% | 8.6 — FFmpeg `drawtext` subtitle burn-in in Docker |
| 9 | Auth hardening + integration tests | 🟡 73% | 9.5/9.6 — integration + smoke tests expose upstream bugs |
| 10 | Extension Superpowers | 🟡 71% | 10.2 — Cross-domain CSS layout quirks with DOM element bounding boxes |
| **All sprints (sequential gates)** | Full platform | **🟠 ~12%** | Compounded — every gate must pass |

> **On the ~15% figure:** Sprint 21 + Sprints 5 + 6 + 7 (Firestore reports only, no OCR) is a 🟡 ~33% outcome and delivers immediate Admin and Analyst value. Treat Sprint 21 and 6S as mandatory gates before portal go-live and Sprint 7 OCR tasks respectively.

---

## Sprint Completion Gates

| Gate | S21 | S5 | S6 | S6S | S7 | S8 | S9 | S10 |
|---|---|---|---|---|---|---|---|---|
| All tasks verified against Done When | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| No open TODO comments in committed code | ⏳ | ⏳ | ⏳ | — | ⏳ | ⏳ | ⏳ | ⏳ |
| Previous sprint acceptance criteria still pass | — | ⏳ | ⏳ | — | ⏳ | ⏳ | ⏳ | ⏳ |
| Role/Entitlement enforcement verified | — | — | — | — | ⏳ | ⏳ | ⏳ | ⏳ |
| Sprint 6S go/no-go decision recorded | — | — | — | ⏳ | — | — | — | — |
| `firestore.indexes.json` updated + deployed | — | ⏳ | ⏳ | — | ⏳ | ⏳ | — | — |
| `infra/` Terraform zero-drift verified | ⏳ | ⏳ | — | — | — | — | ⏳ | — |
| `lessons_learned.md` current | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| `dev_guiderails.md` rules strictly followed | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |

---

## Risk Register

| Risk | Severity | Sprint | Mitigation |
|---|---|---|---|
| `sessionEnd` write races Chrome process kill | High | 6 | Double-flush: `chrome.runtime.onSuspend` + `chrome.windows.onRemoved`; state in `chrome.storage.session` survives SW restart |
| `chrome.alarms` fires no faster than 1 min in background; standard JS timers are unreliable after MV3 service worker suspension | High | 6 | Treat `chrome.alarms` as the required platform primitive; Sprint 6S S.1–S.2 measures real behavior; fallback is 60 s timer + UX copy "about a minute" if sub-minute delivery is infeasible |
| OCR/vision accuracy < 70% on real GTM screenshots | High | 6S / 7 | Sprint 6S S.4 is the gate; if accuracy < 70%, OCR reports replaced with CSV-import workflow |
| FFmpeg cold start > 30 s on large storyboards | Medium | 8 | Cloud Run Job — no cold start concept; each Job execution starts fresh; 50-slide ceiling + 1800 s timeout |
| Signed URLs expire mid-session in portal | Medium | 5 / 8 | V4 signed URLs; refresh on `visibilitychange` + proactive refresh after 9 min (screenshots: 15 min lifetime) |
| SHA-256 key lookup adds per-request Firestore read | Medium | 9 | Single-field indexed lookup on `keyHash`; < 5 ms at current scale; cache in-process for max 60 s if p99 latency budget is tight |
| Drag-and-drop broken on touch devices | Low | 8 | SortableJS uses Pointer Events API; test on iPad Safari + Chrome Android before sprint close |
| Inactivity prompt fires on `chrome://` pages | Low | 6 | Check `tab.url` scheme before sending `inactivity_warning`; suppress on non-http/https tabs |
| LLM/OCR per-image cost exceeds estimate | Medium | 6S / 7 | Sprint 6S S.5 produces cost model (~$9/month at 150 captures/day); GCS-path deduplication avoids re-processing identical images |
| Integration tests surface Sprint 5–8 regressions | Medium | 9 | Budget 1–2 days rework in Sprint 9; mock Cloud Tasks and OCR from day one |
| Billing runaway (FFmpeg loops) | Medium | 9 | Billing budget $200/month; 100% threshold → Pub/Sub → Cloud Function circuit breaker sets `--max-instances 0` |
| Cloud Armor false positives on extension POST | High | 21 | **Moved to [sprint21.md](./sprint21.md) risk register** |
| Direct `*.run.app` URLs remain accessible post-LB | Medium | 21 | **Moved to [sprint21.md](./sprint21.md) — tasks 21.17–21.18** |

---

## Backlog

| Item | Disposition |
|---|---|
| Admin dashboard web app | **Delivered → Sprint 5** |
| Global HTTPS Load Balancer + Cloud Armor + Cloud DNS | **Delivered → Sprint 21** |
| Cloud DLP PII scanning | Backlog; trigger: > 50 users or EU onboarding (see `arch_decisions.md` §8.2) |
| BigQuery export for analytics | Backlog; depends on Sprint 7 report schema |
| Full-page scroll-and-stitch capture | Backlog |
| Chrome Web Store public listing | Backlog; current plan: enterprise sideloading via Google Workspace Admin Console |
| Per-project GCS bucket isolation | Backlog; current model: single `hammer-screenshots-{PROJECT_ID}` bucket with `projectId` path prefix |
| Slack / Teams webhook on upload | Backlog |
| Cloud Run `--min-instances 1` on export service | N/A — `hammer-export` is a Cloud Run **Job**; no min-instances concept |
| OCR/Vision PoC | **Promoted → Sprint 6S** |
| LLM-assisted Executive Summary narrative | Optional enhancement for Sprint 7 task 7.7; not required for done-when |
| CDN caching for portal static assets | Backlog; unlocked by Sprint 21 |
| Per-country geo-blocking via Cloud Armor | Backlog; unlocked by Sprint 21 |
| Multi-region failover (`europe-west1`) | Backlog; trigger: EU users onboarded |
| `data-classification.md` | Backlog; screenshots = `CONFIDENTIAL`; create before first external user onboarded |
| Legal review of customer-facing DPA | Backlog; required before EU onboarding |
