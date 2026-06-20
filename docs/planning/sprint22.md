# The Hammer — Sprint Plan 22 (Deferred)

## Sprint 22 — Instructional Designer Workspace

**Goal:** Cloud-only screenshot → storyboard → annotated MP4 + PDF pipeline.

**Sprint P%: 🟠 63%** — Screenshot browser and annotation editor are high-confidence. FFmpeg subtitle burn-in (22.6) and drag-and-drop sequencing (22.2) are the primary risk items.

> **FFmpeg decision resolved:** `hammer-export` is a **Cloud Run Job** (not a Service), triggered via Cloud Tasks. `--task-timeout 1800s`. 50-slide hard ceiling is non-negotiable and must be enforced before FFmpeg starts; requests above the limit should be rejected with HTTP 400 before enqueue. Job SA is `hammer-export-sa` with `roles/storage.objectAdmin` on `hammer-exports-{PROJECT_ID}` bucket only.

### Screenshot Browser & Storyboard

| # | Task | Done when | P% |
|---|---|---|---|
| 22.1 | Screenshot grid view | GCS `hammer-screenshots-{PROJECT_ID}` screenshots paginated 20/page; V4 signed URLs (15-min lifetime) batch-generated; sorted by `uploadedAt` ascending | 🟡 86% |
| 22.2 | Drag-and-drop storyboard sequencing | SortableJS (CDN) reorders slides; sequence JSON saved to Firestore `storyboards` on drop; storyboard doc has `schemaVersion: 1`; works on desktop and touch (SortableJS Pointer Events API) | 🟠 66% |
| 22.3 | Per-slide annotation editor | Click thumbnail → `<textarea>` side panel opens; debounce-saved to storyboard doc (500 ms) | 🟡 86% |
| 22.4 | Import Analyst report as narrative seed | "Import Executive Summary" maps report paragraphs to slides by timestamp proximity; user can re-assign; pre-loaded text is editable | 🟡 77% |

### Cloud Video Export

| # | Task | Done when | P% |
|---|---|---|---|
| 22.5 | `POST /export/video` | Accepts `{ storyboardId, durationPerSlideMs, transitionMs }`; storyboard capped at 50 slides (enforced here before enqueue, reject > 50 with HTTP 400); enqueues Cloud Tasks task targeting `hammer-export` Cloud Run Job; returns `{ jobId }` within 200 ms | 🟢 93% |
| 22.6 | FFmpeg job: screenshots → H.264 MP4 with subtitle burn-in | Cloud Run Job (`hammer-export`); 1280×720 MP4; each slide held for `durationPerSlideMs` (default 3 s); annotation text via `drawtext` filter + bundled Noto Sans font; `--task-timeout 1800s` | 🟠 63% |
| 22.7 | FFmpeg progress reporting | `GET /export/video/:jobId/status` returns `{ status, progressPercent }` parsed from FFmpeg stderr `time=` tokens; job state persisted in Firestore | 🟡 79% |
| 22.8 | Video stored in GCS `hammer-exports-{PROJECT_ID}` | Path: `exports/{projectId}/{storyboardId}/{timestamp}.mp4`; 24-hour V4 signed URL returned in status response; bucket lifecycle: Day 30 → NEARLINE, Day 90 → delete | 🟢 91% |
| 22.9 | HTML5 video preview + download | `<video>` player loads via signed URL; CORS `AllowedOrigins` set on `hammer-exports-{PROJECT_ID}` bucket to `https://app.thehammer.io`; "Download" triggers blob download | 🟡 82% |

### Document Export & Access Control

| # | Task | Done when | P% |
|---|---|---|---|
| 22.10 | PDF instruction export | "Export PDF" renders thumbnails + annotations via `@media print`; `window.print()` produces clean single-column document in Chrome | 🟡 76% |
| 22.11 | Instructional Designer role enforced | `sha256(req.headers['x-api-key'])` asserted as `role == 'instructional_designer'` from `api_keys` collection; non-ID key → 403 on `/export/*` and storyboard write routes | 🟢 94% |
| 22.12 | Admin sees completed exports | Exports tab: all MP4s listed with title, author, `createdAt`, 24-hour signed URL download link | 🟡 84% |
