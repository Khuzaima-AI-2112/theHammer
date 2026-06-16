# The Hammer — Sprint Plan 2 (Feature Expansion)

## Overview

This plan extends The Hammer beyond its original screenshot-capture-and-upload core into a **multi-role cloud platform** with project administration, task & schedule tracking, analyst reporting, and instructional design tooling.

Four new roles are introduced: **Admin**, **Analyst**, **Instructional Designer**, and **User**. Sprints 5–9 deliver these capabilities incrementally on the existing GCP infrastructure (Cloud Run, Firestore, GCS), using the Firestore `uploads` collection already established in Sprint 4 as the foundation.

Every task has a **measurable pass/fail condition** and a **probability of successful first-attempt completion** (P%). Probabilities are based on technical complexity, dependency depth, known MV3/GCP gotchas, and the team's demonstrated competence through Sprints 0–4.

### Probability Legend

| Symbol | Range | Meaning |
|---|---|---|
| 🟢 | 90–100% | Straightforward; well-trodden pattern on this stack |
| 🟡 | 70–89% | Moderate complexity or one known gotcha |
| 🟠 | 50–69% | Significant complexity, external dependency, or first-time pattern |
| 🔴 | < 50% | High risk; novel integration, MV3 edge case, or OCR/AI accuracy dependency |

---

## New Roles & Responsibilities

| Role | Core Capabilities |
|---|---|
| **Admin** | Sets up projects, admits users, configures tools, reviews all activity, accesses analyst reports |
| **Analyst** | Generates efficiency, progress, GTM/GA4/Ads audit, and executive summary reports |
| **Instructional Designer** | Creates video narratives and instructions from screenshots and analyst reports — all cloud-based |
| **User** | Captures screenshots with automatic timestamp logging; prompted after 45 s of inactivity |

---

## Architecture Additions

```
Existing Core
  └── GCS / Firestore / Cloud Run (Sprints 0–4)

New in Sprint Plan 2
  ├── Admin Portal (web app — Cloud Run or Firebase Hosting)
  │   ├── Project CRUD (name, description, tool list, user roster)
  │   ├── User admission & role assignment
  │   ├── Activity feed per project / per tool
  │   └── Report viewer (Analyst output)
  │
  ├── Analyst Engine (Cloud Run job or callable Cloud Function)
  │   ├── Efficiency & progress reports (Firestore → aggregated metrics)
  │   └── GTM / GA4 / Google Ads audit report (screenshot analysis pipeline)
  │
  ├── Instructional Designer Workspace (web app — Cloud Run)
  │   ├── Screenshot browser (GCS-backed, per project)
  │   ├── Narrative builder (text annotations + screenshot ordering)
  │   └── Video export (FFmpeg Cloud Run job — screenshots → MP4)
  │
  └── User Inactivity Monitor (extension service worker)
      ├── Timestamp logging on first and last screenshot per session
      └── Inactivity dialogue after 45 s of no captures
```

---

## Sprint 5 — Admin Portal: Project & User Management

**Goal:** A cloud-hosted Admin Portal where an admin can create projects, admit users into them, assign roles, and see what each user is doing per tool per project.

**Sprint-level probability of full completion: 🟡 78%**  
All backend tasks are standard Express + Firestore CRUD — high confidence. The main risk is the extension-to-backend migration (5.15), which touches the popup dropdown and requires careful backwards compatibility.

### Pre-flight (carry over from Sprint 4)

All Sprint 4 pre-flight items (M.1–M.4, I.1–I.4, A.1–A.2, C.1–C.4, F.1–F.3) must be verified before Sprint 5 development starts.

### Deliverables

| # | Task | Done when | P% | Risk note | Status |
|---|---|---|---|---|---|
| 5.1 | Design Admin Portal data model in Firestore | Collections `projects`, `users`, `project_memberships` documented; 3 example docs written | 🟢 95% | Pure design/doc task; no code risk | ⏳ |
| 5.2 | `POST /admin/projects` | Returns 201 with `{ projectId, name, createdAt }` | 🟢 95% | Identical pattern to existing `/capture` route | ⏳ |
| 5.3 | `GET /admin/projects` | Returns array with member count | 🟢 93% | Firestore aggregation query; use `collectionGroup` count — well-documented | ⏳ |
| 5.4 | `PATCH /admin/projects/:id` | Updated doc in Firestore within 2 s | 🟢 92% | Standard Firestore `.update()` call | ⏳ |
| 5.5 | `DELETE /admin/projects/:id` | Project + memberships removed; returns 204 | 🟡 85% | Cascading delete of `project_memberships` subcollection requires batched writes — easy to miss | ⏳ |
| 5.6 | `POST /admin/projects/:id/members` | Member doc written with role field | 🟢 93% | Single Firestore write; role is a string field | ⏳ |
| 5.7 | `DELETE /admin/projects/:id/members/:userId` | Membership doc deleted | 🟢 95% | Single Firestore `.delete()` | ⏳ |
| 5.8 | `GET /admin/projects/:id/activity` | Last 100 uploads; `?tool=` filter works | 🟡 88% | Composite Firestore index required on `projectId + tool + uploadedAt`; index build takes 2–5 min | ⏳ |
| 5.9 | Admin Portal SPA: Project list view | Table with projects, member count, last activity | 🟢 90% | Standard HTML table + `fetch()` — team has proven this pattern | ⏳ |
| 5.10 | Admin Portal SPA: Project detail — user roster | Role badges + admit/remove buttons functional | 🟡 85% | Role badge UI is new; remove-then-reflect in DOM requires optimistic update pattern | ⏳ |
| 5.11 | Admin Portal SPA: Activity feed per tool | Filter works; thumbnail signed URLs load | 🟡 80% | Signed URL refresh on thumbnail hover adds complexity; CORS on `<img>` src needs verification | ⏳ |
| 5.12 | Admin Portal SPA: Report viewer tab | Reads `reports` collection; shows empty state | 🟢 92% | Placeholder only; full render deferred to Sprint 7 | ⏳ |
| 5.13 | Admin Portal: Auth guard | 401 on missing/invalid `X-Api-Key` | 🟢 95% | Copy of existing backend middleware | ⏳ |
| 5.14 | Admin Portal: Deploy to Cloud Run | `/health` → 200; portal loads | 🟢 93% | Existing `deploy.ps1` script handles this; minor config change | ⏳ |
| 5.15 | Extension admin view reads from backend | Project appears in popup dropdown within 5 s | 🟠 68% | Breaking change to `chrome.storage.local` flow; popup must fall back gracefully if backend unreachable; first-time fetch-in-extension pattern | ⏳ |

---

## Sprint 6 — User Inactivity Tracking & Timestamp Logging

**Goal:** Capture precise timestamps for first/last screenshot per session and prompt the user after **45 seconds** of inactivity.

**Sprint-level probability of full completion: 🟠 65%**  
The `chrome.alarms` minimum 1-minute floor in MV3 is the highest-risk item. Sub-minute timing requires a hybrid alarms + in-memory Date approach that is easy to get wrong. The session flush on Chrome shutdown is also a known fragility in MV3.

### Deliverables

| # | Task | Done when | P% | Risk note | Status |
|---|---|---|---|---|---|
| 6.1 | Log `sessionStart` on first capture | First capture doc has `isFirstInSession: true` + `sessionStart` | 🟢 92% | Small flag check before Firestore write; builds on 4.9 | ⏳ |
| 6.2 | Log `sessionEnd` on session close | `session_events` doc written with `sessionEnd` + `sessionDurationMs` | 🟠 60% | `chrome.runtime.onSuspend` is not guaranteed to fire before process kill; race condition risk | ⏳ |
| 6.3 | Session summary doc in Firestore | Doc has all 8 fields non-null | 🟡 72% | Depends on 6.2 completing; `firstCapturePath` + `lastCapturePath` require per-session state in service worker memory | ⏳ |
| 6.4 | Inactivity timer — 45 s trigger | `inactivity_warning` message fires after 45 s idle | 🔴 48% | `chrome.alarms` minimum is ~1 min in background contexts; sub-minute timing via in-memory `Date` only works while service worker is awake — can miss the window | ⏳ |
| 6.5 | Inactivity dialogue in popup | Modal shows with Capture Now + Dismiss | 🟡 78% | Popup must be open to receive the message; if popup is closed, notification fallback is needed | ⏳ |
| 6.6 | Dialogue auto-dismisses after 30 s | Closes without user action; next cycle restarts | 🟡 75% | `setTimeout` inside popup works while popup is open; dismissed state must not bleed into next cycle | ⏳ |
| 6.7 | Timer resets on any capture event | 45 s countdown resets to 0 after capture | 🟢 90% | Simple: cancel alarm + restart on each capture event | ⏳ |
| 6.8 | Inactivity events logged to Firestore | `inactivity_events` doc written with `acknowledged` bool | 🟡 82% | Straightforward write; `acknowledged` must be updated when user clicks Capture Now or Dismiss | ⏳ |
| 6.9 | Admin Portal highlights inactivity gaps > 45 s | Activity timeline shows amber gap markers | 🟡 75% | Requires timeline UI component (new); gap detection is a simple timestamp diff; amber colour styling is easy | ⏳ |
| 6.10 | `chrome.alarms` used (not `setTimeout`) | Timer fires after screen lock for 60 s | 🔴 45% | `chrome.alarms` cannot fire more frequently than once per minute per Chrome policy; 45 s target is below this floor — mitigation requires hybrid approach with documented trade-offs | ⏳ |

---

## Sprint 7 — Analyst Engine: Efficiency & Progress Reports

**Goal:** An Analyst can generate structured reports from Firestore data, stored in GCS and viewable in the Admin Portal.

**Sprint-level probability of full completion: 🟠 55%**  
The Firestore-aggregation reports (7.2, 7.3) are straightforward. The GTM/GA4/Ads reports (7.5–7.8) depend on an OCR/vision pipeline against screenshots — accuracy is inherently probabilistic and the pipeline design is first-of-kind on this stack.

### Deliverables

| # | Task | Done when | P% | Risk note | Status |
|---|---|---|---|---|---|
| 7.1 | `POST /reports/generate` endpoint | Returns `{ reportId, status: "queued" }` within 200 ms | 🟢 93% | Async queue pattern is identical to video export pattern; well understood | ⏳ |
| 7.2 | Report: User Efficiency | captures/hour, inactivity rate, median session length → GCS JSON + HTML | 🟢 90% | Pure Firestore aggregation; no external dependencies | ⏳ |
| 7.3 | Report: Project Progress | Total captures, daily trend, active users, tools → GCS | 🟢 90% | Same pattern as 7.2; sparkline data is a simple array | ⏳ |
| 7.4 | Report: Executive Summary | Before/After narrative → Markdown + HTML | 🟡 72% | Narrative generation requires either manual template fill or an LLM call; LLM cost + latency must be defined before coding | ⏳ |
| 7.5 | Report: GTM Configuration Table | Tags/Triggers/Variables extracted from screenshots → Markdown table | 🔴 42% | Depends on OCR or vision-LLM accuracy against GTM UI screenshots; UI layout changes between GTM versions; high false-negative rate likely on first attempt | ⏳ |
| 7.6 | Report: GA4 Configuration | Measurement ID, custom events, cross-domain settings extracted | 🔴 45% | Same OCR/vision risk as 7.5; GA4 UI is dense and frequently updated | ⏳ |
| 7.7 | Report: Google Ads Setup | Conversion Linker, Tracking IDs, imported actions extracted | 🔴 45% | Same risk as 7.5/7.6; Google Ads UI has more visual noise than GTM | ⏳ |
| 7.8 | Report: Audit & Conflicts | Missing consent mode, poorly named tags, unlinked properties flagged with severity | 🟠 58% | Depends on 7.5–7.7 extraction quality; severity classification logic adds additional failure surface | ⏳ |
| 7.9 | Report metadata in Firestore `reports` collection | All 7 fields non-null per report doc | 🟢 92% | Simple write after report generation completes | ⏳ |
| 7.10 | Admin Portal Report Viewer renders all types | HTML in iframe; Markdown rendered; tables sortable | 🟡 78% | iframe sandbox CSP may block inline styles in generated HTML; table sort is a small JS utility | ⏳ |
| 7.11 | Analyst role enforced on `/reports/*` | Non-analyst → 403 | 🟢 93% | Middleware pattern from 5.13; straightforward role check | ⏳ |
| 7.12 | Async status polling | `GET /reports/:id/status` returns correct status enum | 🟡 85% | Firestore listener or polling on a status field; well-understood pattern | ⏳ |

---

## Sprint 8 — Instructional Designer Workspace

**Goal:** Cloud-based screenshot-to-video pipeline with storyboard sequencing, annotations, and PDF export.

**Sprint-level probability of full completion: 🟠 60%**  
The screenshot browser and annotation editor are high-confidence. The FFmpeg Cloud Run job (8.6) is a new pattern with burn-in subtitle complexity, and the drag-and-drop storyboard (8.2) has known touch/mobile edge cases.

### Deliverables

| # | Task | Done when | P% | Risk note | Status |
|---|---|---|---|---|---|
| 8.1 | Screenshot browser: grid view | Thumbnails load via signed URLs; sortable by timestamp | 🟡 85% | Signed URL batch-generation for 50+ thumbnails may hit GCS rate limits; paginate to 20/page | ⏳ |
| 8.2 | Screenshot sequencing: drag-and-drop storyboard | Sequence saved to Firestore `storyboards` | 🟠 65% | Drag-and-drop via Pointer Events is reliable on desktop; touch reorder on mobile is fragile; SortableJS CDN can de-risk | ⏳ |
| 8.3 | Per-slide annotation editor | Click → text editor → save; stored in storyboard doc | 🟡 85% | `<textarea>` debounce save; straightforward Firestore patch | ⏳ |
| 8.4 | Import Analyst report as narrative seed | Executive Summary pre-loaded into annotation editor | 🟡 78% | Requires 7.4 report to exist; text-to-slide mapping heuristic (by timestamp proximity) may mis-assign slides | ⏳ |
| 8.5 | `POST /export/video` endpoint | Returns `{ jobId }` within 200 ms | 🟢 92% | Async queue pattern established in 7.1 | ⏳ |
| 8.6 | FFmpeg job: screenshots → H.264 MP4 with subtitle burn-in | MP4 at 1280×720 with visible text overlays | 🟠 62% | FFmpeg `drawtext` filter with Unicode font in Docker image is achievable but first-time on this infra; cold start on large storyboards may exceed 30 s | ⏳ |
| 8.7 | Video stored in GCS `exports/` | Signed URL returned on completion | 🟢 90% | Identical to existing GCS upload pattern | ⏳ |
| 8.8 | Export status polling | `GET /export/video/:jobId/status` returns `progressPercent` | 🟡 80% | Progress from FFmpeg requires piping stderr output; parsing `time=` tokens adds complexity | ⏳ |
| 8.9 | Video preview + download | HTML5 `<video>` player + signed URL download | 🟡 82% | CORS header on GCS signed URL needed for `<video>` src; set `AllowedOrigins` on bucket CORS config | ⏳ |
| 8.10 | PDF export via `window.print()` | Paginated HTML doc with thumbnails + annotations | 🟡 75% | `window.print()` CSS (`@page`, `break-inside`) is fiddly across browsers; Chrome prints cleanly but Safari may reflow | ⏳ |
| 8.11 | Instructional Designer role enforced | Non-ID key → 403 on `/export/*` and storyboard writes | 🟢 93% | Same middleware as 5.13 / 7.11 | ⏳ |
| 8.12 | Admin views completed exports | Exports tab lists videos with timestamp + author | 🟡 83% | Reads `exports/` Firestore index; requires 8.7 to populate metadata | ⏳ |

---

## Sprint 9 — Hardening, Roles, & Integration Polish

**Goal:** Unified auth, integration tests, monitoring, and mobile-responsive portal.

**Sprint-level probability of full completion: 🟡 70%**  
Most tasks are consolidation and testing work — high confidence individually. The end-to-end smoke test (9.5) and integration suite (9.4) will surface failures from Sprints 5–8, so sprint-level completion depends on all prior work being clean.

### Deliverables

| # | Task | Done when | P% | Risk note | Status |
|---|---|---|---|---|---|
| 9.1 | Role-based API key system | `role` claim in Secret Manager; middleware enforces per-route | 🟡 80% | Storing structured metadata in Secret Manager is non-standard; alternative is a Firestore `api_keys` collection — pick one pattern and commit | ⏳ |
| 9.2 | Role assignment in Admin Portal | Role change reflects in Secret Manager within 10 s | 🟠 65% | Secret Manager has no native key-value metadata API; role storage strategy from 9.1 must be settled first | ⏳ |
| 9.3 | Rate limiting per role | Analyst: 10 req/hr; export: 5 req/hr; capture: 60 req/min | 🟡 82% | `express-rate-limit` with per-key store; `keyGenerator` by API key is straightforward | ⏳ |
| 9.4 | Integration test suite | `npm run test:integration` covers all 6 scenarios | 🟡 75% | Mock FFmpeg and LLM dependencies add setup complexity; requires Sprint 7–8 interfaces to be stable | ⏳ |
| 9.5 | End-to-end smoke test script | `smoke-test.ps1` exits 0; runs in CI | 🟡 72% | CI integration on Cloud Run deployment requires `gcloud` auth in CI env; secrets management for test keys | ⏳ |
| 9.6 | Cloud Monitoring: report failure alert | Fires when > 2 jobs fail in 10 min | 🟡 80% | Identical process to Sprint 4's 4.8 error rate alert; well understood | ⏳ |
| 9.7 | Cloud Monitoring: export queue depth alert | Fires when > 10 jobs queued > 5 min | 🟡 78% | Custom metric on Firestore `status == queued` count; requires a Cloud Function or log-based metric | ⏳ |
| 9.8 | GCS lifecycle rule for `exports/` | MP4s auto-deleted after 90 days | 🟢 95% | `gcloud storage buckets update` with lifecycle config JSON; same pattern as Sprint 0 bucket setup | ⏳ |
| 9.9 | Firestore security rules | Direct writes to protected collections blocked | 🟡 78% | Firestore rules are straightforward; testing them requires Firebase emulator — first-time setup | ⏳ |
| 9.10 | Admin Portal: consolidated dashboard | Live Firestore counts for 5 metrics | 🟡 75% | Live Firestore listeners (`onSnapshot`) are efficient but require WebSocket keep-alive handling on Cloud Run | ⏳ |
| 9.11 | Mobile-responsive Admin Portal | Usable at 375px; touch targets ≥ 44px | 🟡 80% | CSS Grid + media queries; tables-to-cards pattern is well-documented; requires manual test on real device | ⏳ |
| 9.12 | `lessons_learned.md` updated | ≥ 3 new lessons documented | 🟢 97% | Documentation task; no technical risk | ⏳ |

---

## Sprint-Level Probability Summary

| Sprint | Focus | Completion P% | Biggest risk |
|---|---|---|---|
| 5 | Admin Portal + Project/User CRUD | 🟡 78% | Extension migration off local storage (5.15) |
| 6 | Inactivity tracking + timestamps | 🟠 65% | `chrome.alarms` 45 s floor (6.4, 6.10) |
| 7 | Analyst reports (Firestore + OCR) | 🟠 55% | GTM/GA4/Ads OCR accuracy (7.5–7.7) |
| 8 | Instructional Designer workspace | 🟠 60% | FFmpeg subtitle burn-in + drag-and-drop (8.2, 8.6) |
| 9 | Hardening + integration tests | 🟡 70% | Smoke test CI auth + role storage strategy (9.1, 9.5) |
| **All sprints sequential** | Full platform | **🟠 ~17%** | Compounded — all five sprint gates must pass |

> **Note on sequential probability:** The ~17% full-platform figure assumes each sprint is a hard dependency gate. In practice, partial delivery of Sprints 6–8 (excluding the red-rated tasks) is a realistic and valuable outcome. Decoupling the 🔴 tasks (6.4, 6.10, 7.5–7.7) into a separate research spike sprint reduces compounded risk significantly.

---

## Sprint Completion Gates

A sprint is **not done** until all of the following are true:

| Gate | S5 | S6 | S7 | S8 | S9 |
|---|---|---|---|---|---|
| All tasks verified against Done When condition | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| No open TODO comments in committed code | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Previous sprint acceptance criteria still pass | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Role enforcement verified for all new routes | — | — | ⏳ | ⏳ | ⏳ |
| `lessons_learned.md` current | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |

---

## Risk Register (Sprint Plan 2)

| Risk | Severity | Mitigation |
|---|---|---|
| Firestore `session_events` writes race on Chrome shutdown | High | Use `chrome.runtime.onSuspend` + `keepAlive` port trick; flush session data synchronously before service worker dies |
| `chrome.alarms` minimum interval is 1 minute in MV3 (some contexts) | High | Use `chrome.alarms` with 1-minute granularity; supplement with an in-memory `Date` check on wake to determine if 45 s has elapsed |
| FFmpeg Cloud Run job cold start > 30 s for large storyboards | Medium | Pre-warm with `--min-instances 1` on the export service; set job timeout to 10 minutes |
| Signed URLs for screenshot thumbnails expire during long portal sessions | Medium | Admin Portal refreshes thumbnail signed URLs on visibility change or after 9 minutes |
| GTM/GA4 report accuracy depends on screenshot legibility | High | Require screenshots at ≥ 1280px viewport width; document screenshot quality guidelines in the extension popup |
| Analyst engine LLM/OCR costs exceed estimate | Medium | Process screenshots in batches; cache extracted text in Firestore to avoid re-processing the same image twice |
| Role-based API key leakage | High | Rotate keys quarterly; log all 401/403 events to Cloud Logging; alert on > 5 failed auth attempts per IP per minute |
| Storyboard drag-and-drop broken on touch devices | Low | Use Pointer Events API instead of Mouse Events; test on iPad Safari and Chrome Android |
| Video export produces garbled text overlays on non-Latin screenshots | Medium | Use FFmpeg `drawtext` with a Unicode-capable font (e.g., Noto Sans); bundle font in the Docker image |
| Inactivity dialogue shown when user is on a Chrome internal page (`chrome://`) | Low | Check active tab URL before firing inactivity warning; suppress dialogue on `chrome://` pages |

---

## Updated Backlog

The following items from the original backlog are superseded or promoted:

| Item | Disposition |
|---|---|
| Admin dashboard (Firestore-backed web app) | **Promoted → Sprint 5** |
| BigQuery export for usage analytics | Remains in backlog; depends on Sprint 7 report data model |
| Full-page scroll-and-stitch capture | Remains in backlog |
| Chrome Web Store public listing | Remains in backlog |
| Per-project GCS bucket isolation | Remains in backlog; evaluate after Sprint 5 data model is stable |
| Slack / Teams webhook on upload | Remains in backlog |
| Cloud Run `--min-instances 1` | **Promote for export service in Sprint 8** |
| OCR/Vision pipeline for GTM/GA4 screenshots | **Consider as standalone research spike before Sprint 7** |
