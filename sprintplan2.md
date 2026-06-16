# The Hammer — Sprint Plan 2 (Feature Expansion)

## Overview

This plan extends The Hammer beyond its original screenshot-capture-and-upload core into a **multi-role cloud platform** with project administration, task & schedule tracking, analyst reporting, and instructional design tooling.

Four new roles are introduced: **Admin**, **Analyst**, **Instructional Designer**, and **User**. Sprints 5–9 deliver these capabilities incrementally on the existing GCP infrastructure (Cloud Run, Firestore, GCS), using the Firestore `uploads` collection already established in Sprint 4 as the foundation.

Every task has a **measurable pass/fail condition**. A sprint is only complete when every condition is verified.

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

### Pre-flight (carry over from Sprint 4)

All Sprint 4 pre-flight items (M.1–M.4, I.1–I.4, A.1–A.2, C.1–C.4, F.1–F.3) must be verified before Sprint 5 development starts.

### Deliverables

| # | Task | Done when | Status |
|---|---|---|---|
| 5.1 | Design Admin Portal data model in Firestore | Collections `projects`, `users`, `project_memberships` documented in `projectplan.md`; 3 example documents written | ⏳ |
| 5.2 | Extend Cloud Run backend: `POST /admin/projects` | Returns 201 with `{ projectId, name, createdAt }` | ⏳ |
| 5.3 | Extend Cloud Run backend: `GET /admin/projects` | Returns array of all projects with member count | ⏳ |
| 5.4 | Extend Cloud Run backend: `PATCH /admin/projects/:id` | Updated doc visible in Firestore within 2 s | ⏳ |
| 5.5 | Extend Cloud Run backend: `DELETE /admin/projects/:id` | Project and all memberships removed; returns 204 | ⏳ |
| 5.6 | Extend Cloud Run backend: `POST /admin/projects/:id/members` | Member doc written to `project_memberships`; role field present | ⏳ |
| 5.7 | Extend Cloud Run backend: `DELETE /admin/projects/:id/members/:userId` | Membership doc deleted; user no longer in project | ⏳ |
| 5.8 | Extend Cloud Run backend: `GET /admin/projects/:id/activity` | Returns last 100 uploads for project; supports `?tool=` filter | ⏳ |
| 5.9 | Admin Portal SPA: Project list view | Table shows all projects, member count, last activity timestamp | ⏳ |
| 5.10 | Admin Portal SPA: Project detail view — user roster | All admitted users shown with role badge; admit/remove buttons functional | ⏳ |
| 5.11 | Admin Portal SPA: Activity feed per tool | Clicking a tool name filters the activity table; screenshots thumbnail previews load via signed URL | ⏳ |
| 5.12 | Admin Portal SPA: Report viewer tab | Placeholder panel reads from `reports` Firestore collection; shows "No reports yet" on empty | ⏳ |
| 5.13 | Admin Portal: Auth guard | Portal is unreachable without valid `X-Api-Key`; 401 returned for missing/invalid key | ⏳ |
| 5.14 | Admin Portal: Deploy to Cloud Run | `curl $ADMIN_URL/health` → 200 `{"status":"ok"}`; portal loads in browser | ⏳ |
| 5.15 | Extension admin view reads from backend (not local storage) | Creating a project in the portal makes it appear in the extension popup dropdown within 5 s | ⏳ |

---

## Sprint 6 — User Inactivity Tracking & Timestamp Logging

**Goal:** Capture precise timestamps for user activity—especially **first and last screenshot per session**—and prompt the user with an inactivity dialogue after **45 seconds** of no interaction.

### Deliverables

| # | Task | Done when | Status |
|---|---|---|---|
| 6.1 | Log `sessionStart` timestamp on first capture of each session | Firestore doc for first capture has `isFirstInSession: true` and `sessionStart` ISO timestamp | ⏳ |
| 6.2 | Log `sessionEnd` timestamp on last capture before session close | On popup close / Chrome shutdown, service worker writes a `session_events` doc with `sessionEnd`, `totalCaptures`, `sessionDurationMs` | ⏳ |
| 6.3 | Session summary doc in Firestore | `session_events` collection doc contains `sessionId`, `projectId`, `userId`, `sessionStart`, `sessionEnd`, `totalCaptures`, `firstCapturePath`, `lastCapturePath` | ⏳ |
| 6.4 | Inactivity timer in service worker — 45 s | After 45 s with no capture event, service worker fires `chrome.runtime.sendMessage` with `type: "inactivity_warning"` | ⏳ |
| 6.5 | Inactivity dialogue in popup | Popup receives `inactivity_warning` and displays a modal: "You've been inactive for 45 seconds. Ready to capture?" with **Capture Now** and **Dismiss** buttons | ⏳ |
| 6.6 | Inactivity dialogue auto-dismisses after 30 s | If no user action, dialogue closes; another `inactivity_warning` fires after the next 45 s cycle | ⏳ |
| 6.7 | Timer resets on any capture event | After a capture (keyboard, toolbar, floating button), the 45 s countdown resets to 0 | ⏳ |
| 6.8 | Inactivity events logged to Firestore | Each inactivity prompt logs a `inactivity_events` doc with `triggeredAt`, `userId`, `projectId`, `acknowledged` (bool) | ⏳ |
| 6.9 | Activity feed in Admin Portal shows inactivity gaps | Activity timeline highlights gaps > 45 s between captures in amber | ⏳ |
| 6.10 | `chrome.alarms` used for inactivity timer (not `setTimeout`) | Timer survives service worker suspension; verified by locking screen for 60 s and confirming dialogue fires on resume | ⏳ |

---

## Sprint 7 — Analyst Engine: Efficiency & Progress Reports

**Goal:** An Analyst can generate structured reports from Firestore data. Reports are stored in GCS and indexed in Firestore. The Admin Portal's Report Viewer tab becomes functional.

### Deliverables

| # | Task | Done when | Status |
|---|---|---|---|
| 7.1 | `POST /reports/generate` endpoint (authenticated, analyst role) | Accepts `{ projectId, reportType, dateRange }` — returns `{ reportId, status: "queued" }` within 200 ms | ⏳ |
| 7.2 | Report type: **User Efficiency** | Computes captures/hour, inactivity rate, median session length per user per project; saves as JSON + HTML to GCS `reports/` prefix | ⏳ |
| 7.3 | Report type: **Project Progress** | Computes total captures, daily trend (sparkline data), active users, tools used; saves to GCS | ⏳ |
| 7.4 | Report type: **Executive Summary** | Narrative text block: "Before state" (baseline date range) vs "After state" (post-implementation date range); saved as Markdown + HTML | ⏳ |
| 7.5 | Report type: **GTM Configuration Table** | Accepts a set of screenshot GCS paths; pipeline extracts Tags, Triggers, Variables with names, types, and firing rules; output is a Markdown table | ⏳ |
| 7.6 | Report type: **GA4 Configuration** | Extracts Data Stream Measurement ID, custom events, cross-domain tracking settings from annotated screenshots; output is structured JSON + HTML | ⏳ |
| 7.7 | Report type: **Google Ads Setup** | Identifies Conversion Linker status, Conversion Tracking IDs, imported conversion actions from screenshots; output is structured JSON + HTML | ⏳ |
| 7.8 | Report type: **Audit & Conflicts** | Flags missing consent mode settings, poorly named tags, unlinked properties; severity levels: `error`, `warning`, `info`; output is a table | ⏳ |
| 7.9 | Report metadata written to Firestore `reports` collection | Each report doc: `reportId`, `type`, `projectId`, `generatedBy`, `generatedAt`, `gcsPath`, `status` | ⏳ |
| 7.10 | Admin Portal Report Viewer renders all report types | HTML reports load in an iframe; Markdown reports rendered as styled HTML; table reports sortable | ⏳ |
| 7.11 | Analyst role enforced on `/reports/*` routes | Non-analyst API key → 403; analyst key → 200 | ⏳ |
| 7.12 | Report generation async with status polling | `GET /reports/:id/status` returns `{ status: "queued" | "processing" | "done" | "error" }` | ⏳ |

---

## Sprint 8 — Instructional Designer Workspace

**Goal:** An Instructional Designer can browse screenshots per project, annotate them, sequence them into a narrative, and export a cloud-rendered video with voiceover-style captions.

> All work is done in the cloud — no local video editing software required.

### Deliverables

| # | Task | Done when | Status |
|---|---|---|---|
| 8.1 | Instructional Designer Portal: Screenshot browser | Grid view of all GCS screenshots for a project; thumbnails load via signed URLs; sortable by timestamp | ⏳ |
| 8.2 | Screenshot selection & sequencing | Drag-and-drop reorder of selected screenshots into a storyboard strip; sequence saved as JSON in Firestore `storyboards` collection | ⏳ |
| 8.3 | Per-slide annotation editor | Click a screenshot → text editor opens → save annotation; annotations stored in storyboard doc | ⏳ |
| 8.4 | Import Analyst report as narrative seed | "Import from Report" button — analyst's Executive Summary text is pre-loaded into the annotation editor per relevant slide | ⏳ |
| 8.5 | Cloud video export: `POST /export/video` | Accepts `{ storyboardId, fps, transitionMs }`; queues FFmpeg Cloud Run job; returns `{ jobId }` | ⏳ |
| 8.6 | FFmpeg job: screenshots → MP4 | Each screenshot held for `durationMs` (default 3000 ms); annotation text overlaid as subtitle burn-in; output is H.264 MP4 at 1280×720 | ⏳ |
| 8.7 | Video stored in GCS `exports/` prefix | GCS path: `exports/{projectId}/{storyboardId}/{timestamp}.mp4`; signed URL returned on job completion | ⏳ |
| 8.8 | Export status polling | `GET /export/video/:jobId/status` returns `{ status, progressPercent, gcsPath? }` | ⏳ |
| 8.9 | Portal: Video preview & download | Completed export shows an HTML5 `<video>` player; "Download" button fetches MP4 via signed URL | ⏳ |
| 8.10 | Instruction document export | "Export as PDF" button renders annotations + screenshot thumbnails as a paginated HTML doc → `window.print()` PDF | ⏳ |
| 8.11 | Instructional Designer role enforced | Non-ID API key cannot access `/export/*` or storyboard write routes | ⏳ |
| 8.12 | Admin can view completed exports | Admin Portal → Project detail → "Exports" tab lists all completed videos with timestamp and author | ⏳ |

---

## Sprint 9 — Hardening, Roles, & Integration Polish

**Goal:** Unify all four roles under a consistent auth model, harden the new endpoints, add end-to-end integration tests, and ensure the full platform is production-ready.

### Deliverables

| # | Task | Done when | Status |
|---|---|---|---|
| 9.1 | Role-based API key system | Each API key in Secret Manager carries a `role` claim (`admin`, `analyst`, `instructional_designer`, `user`); middleware enforces per-route role requirements | ⏳ |
| 9.2 | Role assignment in Admin Portal | Admin can assign/change a user's role; change reflects in Secret Manager within 10 s | ⏳ |
| 9.3 | Rate limiting scoped per role | Analyst report generation: 10 req/hour; video export: 5 req/hour; standard capture: 60 req/min (existing) | ⏳ |
| 9.4 | Integration test suite | `npm run test:integration` covers: project CRUD, user admission, capture → Firestore write, report generation (mock), video export (mock FFmpeg), inactivity logging | ⏳ |
| 9.5 | End-to-end smoke test script | `scripts/smoke-test.ps1` covers all 4 roles; exits 0 on success; runs in CI on every push to `main` | ⏳ |
| 9.6 | Cloud Monitoring: new alert for report generation failures | Alert fires when > 2 report jobs fail within 10 minutes | ⏳ |
| 9.7 | Cloud Monitoring: video export queue depth alert | Alert fires when > 10 jobs in `queued` state for > 5 minutes | ⏳ |
| 9.8 | GCS lifecycle rule for exports | MP4 files in `exports/` prefix auto-deleted after 90 days; verified with `gcloud storage buckets describe` | ⏳ |
| 9.9 | Firestore security rules | Non-admin service accounts cannot write to `projects`, `users`, or `reports` collections directly; all writes go through the backend API | ⏳ |
| 9.10 | Admin Portal: consolidated dashboard | Single landing page shows: active projects count, active users today, screenshots today, pending reports, pending exports — all with live Firestore listeners | ⏳ |
| 9.11 | Mobile-responsive Admin Portal | Portal is usable on 375px viewport; all tables collapse to card lists; touch targets ≥ 44px | ⏳ |
| 9.12 | `lessons_learned.md` updated | Document includes at least 3 new lessons from Sprints 5–9 | ⏳ |

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
| FFmpeg Cloud Run job cold start > 30 s for large storyboards | Medium | Pre-warm with a `--min-instances 1` on the export service; set job timeout to 10 minutes |
| Signed URLs for screenshot thumbnails expire during long portal sessions | Medium | Admin Portal refreshes thumbnail signed URLs on visibility change or after 9 minutes |
| GTM/GA4 report accuracy depends on screenshot legibility | High | Require screenshots at ≥ 1280px viewport width; document screenshot quality guidelines for users in the extension popup |
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
