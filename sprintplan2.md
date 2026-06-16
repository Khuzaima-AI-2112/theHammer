# The Hammer — Sprint Plan 2

## Overview

Sprints 5–10 extend The Hammer from a screenshot-capture tool into a **multi-role cloud platform**: a cloud-hosted Admin Portal, per-user activity and inactivity tracking, an Analyst report engine, and a cloud-based Instructional Designer workspace. All new work builds on the Firestore `uploads` collection and Cloud Run backend established in Sprints 0–4.

### Four New Roles

| Role | What they do |
|---|---|
| **Admin** | Creates projects, admits users, assigns roles, reviews per-project/per-tool activity, reads analyst reports |
| **Analyst** | Generates user efficiency, project progress, GTM/GA4/Ads audit, and executive summary reports |
| **Instructional Designer** | Sequences screenshots into annotated storyboards, exports cloud-rendered MP4 videos and PDF instruction docs |
| **User** | Captures screenshots; session timestamps (first + last) auto-logged; prompted after 45 s of inactivity |

### Build Order

```
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

### Pre-flight
All Sprint 4 console items (M.1–M.4, I.1–I.4, A.1–A.2, C.1–C.4, F.1–F.3) verified ✅ before any Sprint 5 code is written.

### Backend — Express + Firestore

| # | Task | Done when | P% |
|---|---|---|---|
| 5.1 | Firestore data model: `projects`, `users`, `project_memberships` | Schema documented in `projectplan.md`; 3 example JSON docs written per collection | 🟢 96% |
| 5.2 | `POST /admin/projects` | Returns `201 { projectId, name, createdAt }`; doc visible in Firestore | 🟢 95% |
| 5.3 | `GET /admin/projects` | Returns array; each item includes `memberCount` via Firestore count query | 🟢 92% |
| 5.4 | `PATCH /admin/projects/:id` | Partial update; updated fields reflected in Firestore within 2 s | 🟢 93% |
| 5.5 | `DELETE /admin/projects/:id` | Project doc + all `project_memberships` subcollection docs deleted in a batched write; returns 204 | 🟡 84% |
| 5.6 | `POST /admin/projects/:id/members` | `project_memberships/{userId}` doc written; `role` field present | 🟢 94% |
| 5.7 | `DELETE /admin/projects/:id/members/:userId` | Membership doc deleted; `GET /admin/projects/:id` member count decrements | 🟢 95% |
| 5.8 | `GET /admin/projects/:id/activity` | Returns last 100 `uploads` docs for project; `?tool=` filter applies composite index on `projectId + tool + uploadedAt` | 🟡 87% |

### Admin Portal SPA

| # | Task | Done when | P% |
|---|---|---|---|
| 5.9 | Project list view | Table: project name, member count, last capture timestamp; create/delete buttons functional | 🟢 91% |
| 5.10 | Project detail — user roster | Admitted users listed with role badge; Admit and Remove buttons update Firestore and re-render without full page reload | 🟡 84% |
| 5.11 | Activity feed per tool | `?tool=` filter applied on click; screenshot thumbnails load via signed URLs; URLs auto-refreshed after 9 min | 🟡 79% |
| 5.12 | Report viewer tab (placeholder) | Panel fetches `reports` Firestore collection; renders "No reports yet" empty state; full render deferred to Sprint 7 | 🟢 93% |
| 5.13 | Auth guard | Missing or invalid `X-Api-Key` header → 401 on all `/admin/*` routes; copied from existing middleware | 🟢 96% |
| 5.14 | Deploy Admin Portal to Cloud Run | `curl $ADMIN_URL/health` → `{"status":"ok"}`; portal accessible in browser; added to `deploy.ps1` | 🟢 92% |

### Extension Migration

| # | Task | Done when | P% |
|---|---|---|---|
| 5.15 | Extension popup reads projects/users from backend API | Dropdown populates from `GET /admin/projects` within 5 s; falls back to last-cached `chrome.storage.local` value if fetch fails within 3 s | 🟠 67% |

> **5.15 mitigation:** implement cache-first pattern (`chrome.storage.local` as stale-while-revalidate) before attempting live fetch. If backend unreachable, popup works from cache — no capture-blocking regression.

---

## Sprint 6 — Session Timestamps & Inactivity Tracking

**Goal:** Log first/last capture timestamps per session; prompt user after 45 s of inactivity using a reliable timer strategy.

**Sprint P%: 🟡 74%** — Timestamp logging is high-confidence. Inactivity timer delivery depends on the findings of Sprint 6S (research spike). If 6S validates the hybrid `chrome.alarms` + `Date` approach, tasks 6.4 and 6.10 execute cleanly. If not, the fallback (1-minute alarm with UX copy adjusted to "about a minute") is the accepted done-when condition.

### Session Timestamps

| # | Task | Done when | P% |
|---|---|---|---|
| 6.1 | `sessionStart` logged on first capture | First `uploads` doc of each session has `isFirstInSession: true` and `sessionStart` ISO timestamp | 🟢 93% |
| 6.2 | `sessionEnd` logged on session close | `session_events` Firestore doc written with `sessionEnd`, `totalCaptures`, `sessionDurationMs` on `chrome.runtime.onSuspend` + `chrome.windows.onRemoved` double-flush | 🟡 72% |
| 6.3 | Session summary doc complete | `session_events` doc contains all 8 fields: `sessionId`, `projectId`, `userId`, `sessionStart`, `sessionEnd`, `totalCaptures`, `firstCapturePath`, `lastCapturePath` | 🟡 74% |

### Inactivity Timer

| # | Task | Done when | P% |
|---|---|---|---|
| 6.4 | 45 s inactivity timer fires reliably | `inactivity_warning` message fires within 5 s of the 45 s window — OR — fires at nearest `chrome.alarms` tick (≤ 60 s) if sub-minute confirmed infeasible by Sprint 6S | 🟡 71% |
| 6.5 | Inactivity dialogue in popup | Popup receives `inactivity_warning` and renders modal: "Still there? Ready to capture?" with **Capture Now** and **Snooze** buttons | 🟡 79% |
| 6.6 | Notification fallback when popup is closed | If popup is not open, `chrome.notifications.create` shows a system notification with "Capture" action button | 🟡 76% |
| 6.7 | Dialogue auto-dismisses after 30 s | Modal closes without action; next inactivity cycle starts fresh | 🟡 77% |
| 6.8 | Timer resets on every capture event | All three capture triggers (keyboard, toolbar, floating button) cancel and restart the alarm; verified across all three | 🟢 91% |
| 6.9 | Inactivity events logged to Firestore | `inactivity_events` doc: `triggeredAt`, `userId`, `projectId`, `acknowledged` (bool, updated on button press) | 🟡 83% |
| 6.10 | `chrome.alarms` used (not `setTimeout`) — verified post-suspend | After device screen lock for 60 s, alarm fires on resume; `setTimeout`-only implementation fails this test | 🟡 70% |

### Admin Portal: Inactivity Visibility

| # | Task | Done when | P% |
|---|---|---|---|
| 6.11 | Activity timeline highlights gaps > 45 s | Gaps between consecutive capture timestamps > 45 s rendered in amber on the activity feed | 🟡 76% |

---

## Sprint 6S — Research Spike

**Goal:** De-risk the two families of 🔴 tasks before they enter delivery sprints. Produces documented findings and a proof-of-concept — not production code.

**Sprint P%: 🟢 91%** — A spike produces a decision either way; it cannot fail in the traditional sense.

| # | Task | Done when | P% |
|---|---|---|---|
| S.1 | Validate `chrome.alarms` sub-minute timing | Test extension measures actual firing latency across 50 cycles; min/max/mean delay documented per Chrome version | 🟢 95% |
| S.2 | Document hybrid timer decision | "Sub-minute feasible via in-memory `Date` + 1-min alarm" or "target 60 s, update UX copy" — agreed by team, written in `projectplan.md` before Sprint 6 tasks 6.4/6.10 are coded | 🟢 95% |
| S.3 | OCR/Vision API evaluation | Google Cloud Vision vs GPT-4o vision vs Gemini 1.5 Pro tested on 10 real GTM screenshots; extraction accuracy for Tags/Triggers/Variables recorded per API | 🟠 68% |
| S.4 | OCR proof-of-concept | Single Cloud Run function accepts GCS screenshot path; returns GTM config JSON; accuracy ≥ 70% on test corpus = spike passes | 🟠 62% |
| S.5 | OCR cost model | Per-image cost at 150 captures/day; monthly ceiling at current team size; caching strategy documented | 🟢 90% |
| S.6 | Go/No-go decision on OCR reports | If S.4 accuracy < 70%: Sprint 7 tasks 7.8–7.11 replaced with CSV-import workflow; decision written in `projectplan.md` | 🟢 93% |

---

## Sprint 7 — Analyst Engine

**Goal:** Analyst generates structured reports stored in GCS + indexed in Firestore; Admin Portal Report Viewer functional.

**Sprint P%: 🟡 71%** — Firestore-aggregation reports are high-confidence. OCR reports (7.8–7.11) only enter this sprint if Sprint 6S S.4 passes; otherwise replaced by CSV-import workflow.

### Report Infrastructure

| # | Task | Done when | P% |
|---|---|---|---|
| 7.1 | `POST /reports/generate` | Accepts `{ projectId, reportType, dateRange }`; writes `reports` doc with `status: "queued"`; returns `{ reportId }` within 200 ms | 🟢 94% |
| 7.2 | `GET /reports/:id/status` | Returns `{ status: "queued" \| "processing" \| "done" \| "error", gcsPath? }` | 🟡 86% |
| 7.3 | Analyst role enforced on `/reports/*` | Non-analyst key → 403; analyst key → 200; verified for POST + GET | 🟢 94% |
| 7.4 | Report metadata in Firestore | Every completed report doc: `reportId`, `type`, `projectId`, `generatedBy`, `generatedAt`, `gcsPath`, `status` | 🟢 92% |

### Firestore-Aggregation Reports

| # | Task | Done when | P% |
|---|---|---|---|
| 7.5 | Report: **User Efficiency** | Captures/hour, inactivity rate, median session length per user; GCS JSON + HTML | 🟢 91% |
| 7.6 | Report: **Project Progress** | Total captures, daily trend array, active users, tools used; GCS JSON + HTML | 🟢 91% |
| 7.7 | Report: **Executive Summary** | Before/After narrative filled from Firestore data using a Markdown template; LLM fill is an optional enhancement, not required for done-when | 🟡 78% |

### OCR-Dependent Reports *(conditional on Sprint 6S S.4 passing)*

| # | Task | Done when | P% |
|---|---|---|---|
| 7.8 | Report: **GTM Configuration Table** | Screenshots → OCR → Tags/Triggers/Variables Markdown table; ≥ 80% field coverage on test corpus | 🟠 64% |
| 7.9 | Report: **GA4 Configuration** | Measurement ID, custom events, cross-domain settings → JSON + HTML | 🟠 62% |
| 7.10 | Report: **Google Ads Setup** | Conversion Linker, Tracking IDs, imported conversions → JSON + HTML | 🟠 60% |
| 7.11 | Report: **Audit & Conflicts** | Missing consent mode, poorly named tags, unlinked properties; severity `error` / `warning` / `info`; sortable table | 🟠 65% |

> **If Sprint 6S S.4 did not pass:** 7.8–7.11 are replaced with a CSV-import workflow (analyst uploads structured config CSV → engine formats to same output). CSV-import variant P%: 🟢 88%.

### Admin Portal — Report Viewer

| # | Task | Done when | P% |
|---|---|---|---|
| 7.12 | Report Viewer renders all types | HTML in sandboxed iframe; Markdown rendered as styled HTML; table reports client-side sortable | 🟡 79% |

---

## Sprint 8 — Instructional Designer Workspace

**Goal:** Cloud-only screenshot → storyboard → annotated MP4 + PDF pipeline.

**Sprint P%: 🟠 63%** — Screenshot browser and annotation editor are high-confidence. FFmpeg subtitle burn-in (8.6) and drag-and-drop sequencing (8.2) are the primary risk items.

### Screenshot Browser & Storyboard

| # | Task | Done when | P% |
|---|---|---|---|
| 8.1 | Screenshot grid view | GCS screenshots paginated 20/page; signed URLs batch-generated; sorted by `uploadedAt` ascending | 🟡 86% |
| 8.2 | Drag-and-drop storyboard sequencing | SortableJS (CDN) reorders slides; sequence JSON saved to Firestore `storyboards` on drop; works on desktop and touch | 🟠 66% |
| 8.3 | Per-slide annotation editor | Click thumbnail → `<textarea>` side panel opens; debounce-saved to storyboard doc (500 ms) | 🟡 86% |
| 8.4 | Import Analyst report as narrative seed | "Import Executive Summary" maps report paragraphs to slides by timestamp proximity; user can re-assign; pre-loaded text is editable | 🟡 77% |

### Cloud Video Export

| # | Task | Done when | P% |
|---|---|---|---|
| 8.5 | `POST /export/video` | Accepts `{ storyboardId, durationPerSlideMs, transitionMs }`; queues FFmpeg job; returns `{ jobId }` within 200 ms | 🟢 93% |
| 8.6 | FFmpeg job: screenshots → H.264 MP4 with subtitle burn-in | 1280×720 MP4; each slide held for `durationPerSlideMs` (default 3 s); annotation text via `drawtext` filter + bundled Noto Sans font | 🟠 63% |
| 8.7 | FFmpeg progress reporting | `GET /export/video/:jobId/status` returns `{ status, progressPercent }` parsed from FFmpeg stderr `time=` tokens | 🟡 79% |
| 8.8 | Video stored in GCS `exports/` | Path: `exports/{projectId}/{storyboardId}/{timestamp}.mp4`; 1-hour signed URL returned in status response | 🟢 91% |
| 8.9 | HTML5 video preview + download | `<video>` player loads via signed URL; CORS `AllowedOrigins` set on GCS bucket; "Download" triggers blob download | 🟡 82% |

### Document Export & Access Control

| # | Task | Done when | P% |
|---|---|---|---|
| 8.10 | PDF instruction export | "Export PDF" renders thumbnails + annotations via `@media print`; `window.print()` produces clean single-column document in Chrome | 🟡 76% |
| 8.11 | Instructional Designer role enforced | Non-ID key → 403 on `/export/*` and storyboard write routes | 🟢 94% |
| 8.12 | Admin sees completed exports | Exports tab: all MP4s listed with title, author, `createdAt`, signed URL download link | 🟡 84% |

---

## Sprint 9 — Hardening, Auth & Integration

**Goal:** Unified role-based auth, integration + smoke test suite, Cloud Monitoring expansion, Firestore security rules, mobile-responsive portal.

**Sprint P%: 🟡 73%** — Individual tasks are well-understood. Sprint-level risk is that integration tests (9.5, 9.6) surface bugs from Sprints 5–8; budget rework time.

### Role-Based Auth

| # | Task | Done when | P% |
|---|---|---|---|
| 9.1 | Role storage design decision | Team chooses (a) Secret Manager labels or (b) Firestore `api_keys` collection; decision recorded in `projectplan.md` | 🟢 96% |
| 9.2 | Role-aware API key middleware | Reads role from chosen store; enforces per-route role list; 403 on insufficient role; all 401/403 logged to Cloud Logging | 🟡 81% |
| 9.3 | Role assignment in Admin Portal | Admin can view and change user role; change propagates within 10 s; reflected on next API request | 🟠 66% |
| 9.4 | Per-role rate limiting | Analyst reports: 10 req/hr; video export: 5 req/hr; capture: 60 req/min (existing); verified by sending requests above threshold | 🟡 83% |

### Testing

| # | Task | Done when | P% |
|---|---|---|---|
| 9.5 | Integration test suite | `npm run test:integration` covers: project CRUD, user admission, capture → Firestore, report generation (mock OCR), video export (mock FFmpeg), inactivity logging; all pass in CI | 🟡 74% |
| 9.6 | End-to-end smoke test script | `scripts/smoke-test.ps1` exercises all 4 roles; exits 0; runs on push to `main` via GitHub Actions or Cloud Build | 🟡 71% |

### Cloud Monitoring

| # | Task | Done when | P% |
|---|---|---|---|
| 9.7 | Report failure alert | Alert fires when > 2 `reports` docs have `status: "error"` within 10 min; test email received | 🟡 81% |
| 9.8 | Export queue depth alert | Alert fires when > 10 export jobs `status: "queued"` for > 5 min; Cloud Function drives log-based metric | 🟡 77% |
| 9.9 | GCS lifecycle rule for `exports/` | `exports/` objects auto-deleted after 90 days; verified with `gcloud storage buckets describe` | 🟢 96% |

### Security & Polish

| # | Task | Done when | P% |
|---|---|---|---|
| 9.10 | Firestore security rules | Direct writes to `projects`, `users`, `reports`, `storyboards` blocked for non-admin SAs; tested with Firebase emulator | 🟡 77% |
| 9.11 | Admin Portal consolidated dashboard | 5 live metrics (active projects, active users today, screenshots today, pending reports, pending exports) via Firestore `onSnapshot` | 🟡 76% |
| 9.12 | Mobile-responsive Admin Portal | All views usable at 375px; tables → card lists; touch targets ≥ 44px; tested on real device | 🟡 81% |
| 9.13 | `lessons_learned.md` updated | ≥ 3 new lessons from Sprints 5–9 with root cause + resolution | 🟢 98% |

---

## Sprint-Level Summary

| Sprint | Focus | P% | Biggest single risk |
|---|---|---|---|
| 5 | Admin Portal + project/user CRUD | 🟡 79% | 5.15 — extension migration off `chrome.storage.local` |
| 6 | Session timestamps + inactivity timer | 🟡 74% | 6.2 — `sessionEnd` flush on Chrome shutdown |
| 6S | Research spike (alarms + OCR) | 🟢 91% | S.4 — OCR PoC accuracy on real GTM screenshots |
| 7 | Analyst report engine | 🟡 71% | 7.8–7.11 — OCR extraction accuracy (conditional on 6S) |
| 8 | Instructional Designer workspace | 🟠 63% | 8.6 — FFmpeg `drawtext` subtitle burn-in in Docker |
| 9 | Auth hardening + integration tests | 🟡 73% | 9.5/9.6 — integration + smoke tests expose upstream bugs |
| **All six sprints (sequential gates)** | Full platform | **🟠 ~19%** | Compounded — every gate must pass |

> **On the ~19% figure:** Completing Sprints 5 + 6 + 7 (Firestore reports only, no OCR) is a 🟡 ~41% outcome and delivers immediate value to Admin and Analyst. Treat 6S as mandatory gating before Sprint 7 OCR tasks.

---

## Sprint Completion Gates

| Gate | S5 | S6 | S6S | S7 | S8 | S9 |
|---|---|---|---|---|---|---|
| All tasks verified against Done When | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| No open TODO comments in committed code | ⏳ | ⏳ | — | ⏳ | ⏳ | ⏳ |
| Previous sprint acceptance criteria still pass | ⏳ | ⏳ | — | ⏳ | ⏳ | ⏳ |
| Role enforcement verified for new routes | — | — | — | ⏳ | ⏳ | ⏳ |
| Sprint 6S go/no-go decision recorded | — | — | ⏳ | — | — | — |
| `lessons_learned.md` current | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |

---

## Risk Register

| Risk | Severity | Sprint | Mitigation |
|---|---|---|---|
| `sessionEnd` write races Chrome process kill | High | 6 | Double-flush: `chrome.runtime.onSuspend` + `chrome.windows.onRemoved`; write is best-effort and logged |
| `chrome.alarms` fires no faster than 1 min in background | High | 6 | Sprint 6S S.1–S.2 gates this; fallback is 60 s timer + UX copy "about a minute" |
| OCR/vision accuracy < 70% on real GTM screenshots | High | 6S / 7 | Sprint 6S S.4 is the gate; if accuracy < 70%, OCR reports replaced with CSV-import workflow |
| FFmpeg cold start > 30 s on large storyboards | Medium | 8 | `--min-instances 1` on export service; job timeout 10 min; storyboard capped at 50 slides |
| Signed URLs expire mid-session in portal | Medium | 5 / 8 | Refresh on `visibilitychange` + proactive refresh after 9 min |
| Role storage in Secret Manager lacks metadata API | Medium | 9 | Sprint 9.1 decision sprint; Firestore `api_keys` collection is the recommended fallback |
| Drag-and-drop broken on touch devices | Low | 8 | SortableJS uses Pointer Events; test on iPad Safari + Chrome Android before sprint close |
| Inactivity prompt fires on `chrome://` pages | Low | 6 | Check `tab.url` before sending `inactivity_warning`; suppress on non-http/https tabs |
| LLM/OCR per-image cost exceeds estimate | Medium | 6S / 7 | Sprint 6S S.5 produces cost model; GCS-path deduplication avoids re-processing identical images |
| Integration tests surface Sprint 5–8 regressions | Medium | 9 | Budget 1–2 days rework in Sprint 9; mock FFmpeg and OCR from day one |

---

## Backlog

| Item | Disposition |
|---|---|
| Admin dashboard web app | **Delivered → Sprint 5** |
| BigQuery export for analytics | Backlog; depends on Sprint 7 report schema |
| Full-page scroll-and-stitch capture | Backlog |
| Chrome Web Store public listing | Backlog |
| Per-project GCS bucket isolation | Backlog; revisit post-Sprint 5 data model |
| Slack / Teams webhook on upload | Backlog |
| Cloud Run `--min-instances 1` on export service | **Promoted → Sprint 8** |
| OCR/Vision PoC | **Promoted → Sprint 6S** |
| LLM-assisted Executive Summary narrative | Optional enhancement for Sprint 7 task 7.7; not required for done-when |
