# The Hammer — Project Plan

## Overview

A Chrome extension that captures a screenshot of the active tab and uploads it to Google Cloud Storage. The file is automatically named based on three user-configured fields: **project**, **tool used**, and **user name**. Captures can be triggered via a keyboard shortcut, the extension toolbar button, or an injected floating button on the page.

> **New requirement — session-scoped assignment:**
> At extension startup (or "login"), the user selects a **Project** and **User** from dropdowns populated by an admin-managed list. These selections apply to all captures in the current session. An admin can configure the available projects and users from a dedicated admin settings view.

---

## Goals

- One-click / one-shortcut screenshot capture from any tab
- Automatic file naming: `{project}/{tool}/{yyyy}/{mm}/{dd}/{name}_{timestamp}.png`
- Upload to Google Cloud Storage with zero manual steps
- Lightweight backend on Google Cloud (Cloud Run, min instances 0)
- Internal team use: 5 users, ~30 images/day each (~150/day total)
- Estimated cost: under $1/month
- **New:** Session-scoped assignment of **Project** and **User** via dropdowns, backed by an admin-managed configuration

---

## Architecture

```
Chrome Extension (MV3)
  ├── Popup (select session Project/User from dropdowns; set tool name)
  ├── Admin View (configure allowed Projects and Users)
  ├── Service Worker (keyboard shortcut, toolbar button, message relay)
  ├── Content Script (floating page button)
  └── chrome.tabs.captureVisibleTab() → PNG data URL
         ↓
Cloud Run (Node.js / Express — containerized)
  ├── POST /capture
  ├── Validate + sanitize metadata fields
  ├── Build object path
  └── Upload to Cloud Storage
         ↓
Google Cloud Storage
  └── {project}/{tool}/{yyyy}/{mm}/{dd}/{name}_{timestamp}.png
```

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Extension | Chrome MV3 (TypeScript) | MV2 fully deprecated as of Chrome 138 |
| Capture API | `chrome.tabs.captureVisibleTab()` | Returns PNG data URL of visible tab area |
| Permissions | `activeTab`, `storage`, `scripting`, `notifications` | Minimum privilege; no install warning |
| Keyboard shortcut | `chrome.commands` API | Activates `activeTab` permission on all 3 triggers |
| Settings storage | `chrome.storage.local` | Persists across service worker restarts |
| Admin config storage | `chrome.storage.local` (Projects/Users), optional Firestore later | Keeps all state inside extension for v1; can be centralized later |
| Backend | Cloud Run (Node.js 20 + Express, containerized) | HTTP endpoint, scales to zero, full control over runtime |
| Container registry | Artifact Registry | Standard GCP container storage |
| Storage | Google Cloud Storage (Standard class) | ~$0.02/GB-month, lifecycle rules |
| Auth | API key via `X-Api-Key` header + Secret Manager | Practical for small team; upgradeable to IAP |
| Metadata (v2) | Firestore | Optional: upload history, per-project views |

---

## Object Naming Convention

```
{project}/{tool}/{yyyy}/{mm}/{dd}/{sanitized-name}_{timestamp}.png
```

**Sanitization rules (applied server-side):**
- Lowercase all fields
- Replace spaces with underscores
- Strip characters outside `[a-z0-9_-]`
- Truncate each field to 64 characters
- Append `Date.now()` or `crypto.randomUUID()` suffix to prevent collisions

**Example:**
```
website-redesign/figma/2026/06/08/alice_1749430800000.png
```

### Session Assignment Rules (Dropdown behaviour)

- **Project** and **User** are **selected once per session** from dropdowns populated from an admin-managed list.
- The current selection is stored in `chrome.storage.local` under a `session` key:
  ```json
  {
    "session": {
      "projectId": "proj-website-redesign",
      "userId": "user-alice",
      "tool": "figma"
    }
  }
  ```
- If no Project/User is selected, capture is **blocked** and the popup shows a clear error prompting the user to choose before any screenshot can be taken.
- The extension **never lets ad-hoc strings bypass the dropdowns** in v1. Project and User must always come from the configured list; this avoids typos and inconsistent folder structures.
- A future v2 may allow a "Custom" entry that the admin can toggle on per project.

---

## Three Trigger Methods

| Trigger | How it works |
|---|---|
| Keyboard shortcut | `chrome.commands.onCommand` in service worker → verify session Project/User set → `captureVisibleTab()` → upload |
| Toolbar button | Opens popup → user presses `Capture Now` → same flow as keyboard shortcut |
| Floating page button | Content script injects button → `chrome.runtime.sendMessage` → service worker → verify session Project/User → `captureVisibleTab()` → upload |

If the session Project/User is not set, all three triggers show a notification and do **not** attempt capture.

---

## Cloud Run Configuration

| Setting | Value | Reason |
|---|---|---|
| Min instances | 0 | No idle cost; cold start ~500ms–2s, acceptable for internal tool |
| Max instances | 5 | Plenty for 5 users |
| Memory | 256 MiB | PNG processing is lightweight |
| CPU | 1 | More than enough |
| Timeout | 30s | Upload should complete well under 5s |
| Concurrency | 80 (default) | Fine for this traffic volume |
| Region | `northamerica-northeast1` (Montréal) | Proximity to users |
| Ingress | All | Extension calls over public HTTPS |
| Auth | `--allow-unauthenticated` + API key check in code | Validates `X-Api-Key` header against Secret Manager |

Cloud Run scales to zero when idle — no instance runs between sessions, so cost is effectively $0 for this traffic level. When a capture is triggered, the service wakes in under 2 seconds and stays warm for approximately 15 minutes of activity.

---

## Known Constraints

- `captureVisibleTab()` captures **visible area only** — not the full scrollable page
- Cannot capture `chrome://` system pages or the Chrome DevTools window
- Service worker shuts down after ~30 seconds idle (Chrome 110+); woken up on event
- Never store settings in `localStorage` — use `chrome.storage.local`
- Signed URL uploads (Phase 2) require V4 signing; V2 has a known CORS bug
- Cloud Run cold starts are typically 500ms–2s with a lightweight Node.js image; acceptable for internal tools
- Container image must be pushed to Artifact Registry before deploying to Cloud Run
- **New:** Admin-managed lists of Projects and Users live in the extension for v1; changing them requires access to the admin view (or editing storage via DevTools). Centralization via Firestore is explicitly a v2 concern.

---

## Cost Estimate (5 users × 30 images/day)

| Component | Monthly cost |
|---|---|
| Cloud Run compute (min 0, ~150 requests/day) | ~$0 (well within free tier) |
| Artifact Registry (container image storage) | ~$0.01 |
| Cloud Storage writes (4,500/month) | ~$0.02 |
| Cloud Storage data (30-day retention, ~4.5 GB) | ~$0.10 |
| Secret Manager (1 secret, minimal access) | ~$0 |
| Firestore (optional metadata) | ~$0 (within free tier) |
| **Total** | **~$0.10–$0.25/month** |

---

## Repo Structure

```
thehammer/
├── extension/
│   ├── manifest.json
│   ├── service-worker.ts
│   ├── popup.html         ← includes Project/User dropdowns
│   ├── popup.ts           ← reads Projects/Users config + session values
│   ├── admin.html         ← admin UI: manage Projects/Users
│   ├── admin.ts           ← CRUD for Projects/Users config
│   ├── content.ts
│   └── icons/
├── backend/
│   ├── src/
│   │   ├── index.ts        ← Express app entry point
│   │   ├── storage.ts      ← GCS upload logic
│   │   └── naming.ts       ← Object path builder + sanitizer
│   ├── Dockerfile
│   ├── .dockerignore
│   └── package.json
├── infra/
│   └── deploy.ps1          ← docker build + push + gcloud run deploy
├── projectplan.md
└── sprintplan.md
```

---

## Distribution

Publish as **Unlisted** on the Chrome Web Store — accessible by direct link, no Google Workspace required, skips most review friction.
