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

## Firestore Data Model (Sprint 5.1)

Sprint 5 introduces three new top-level Firestore collections: `projects`, `users`, and `project_memberships`. This design preserves the existing flat `uploads` collection and adds a `projectId` field to `uploads` documents for project-scoped queries; no `uploads/{projectId}/...` subcollections are introduced.

All new Firestore document types created in Sprint 5 must include `schemaVersion: 1`. Timestamps are stored as Firestore timestamps in persisted documents and are shown as ISO 8601 strings in the examples below for readability.

### Collection layout

| Collection | Purpose | Document ID | Notes |
|---|---|---|---|
| `projects` | Admin-created project records used across portal, extension, and reporting | `projectId` (e.g. `proj_website_redesign`) | Stores summary fields including `memberCount` |
| `users` | Directory of people who can capture, administer, analyze, or design | `userId` (e.g. `user_alice_chen`) | Profile record; API keys live separately in Sprint 9 |
| `project_memberships` | Join table linking users to projects with a role | deterministic membership ID such as `{projectId}__{userId}` | Flat collection; not a subcollection under `projects` |
| `uploads` | Existing screenshot metadata collection | existing upload document ID | Remains flat; queried by `projectId`, `userId`, `tool`, `uploadedAt` |

### Schema — `projects`

Each project document represents one admin-managed project visible in the Admin Portal and selectable by assigned users.

| Field | Type | Required | Description |
|---|---|---|---|
| `projectId` | string | Yes | Stable identifier duplicated from the document ID for API responses |
| `name` | string | Yes | Human-readable project name |
| `description` | string | No | Optional admin-entered summary |
| `status` | string | Yes | Initial values: `active` or `archived` |
| `memberCount` | number | Yes | Denormalized count maintained transactionally |
| `createdAt` | timestamp | Yes | Creation timestamp |
| `createdBy` | string | Yes | Email or user ID of creator |
| `updatedAt` | timestamp | Yes | Last metadata update timestamp |
| `schemaVersion` | number | Yes | Must be `1` |

Example documents:

```json
{
  "projectId": "proj_website_redesign",
  "name": "Website Redesign",
  "description": "Capture redesign work across Figma, Jira, and QA.",
  "status": "active",
  "memberCount": 3,
  "createdAt": "2026-06-18T13:00:00Z",
  "createdBy": "admin@thehammer.io",
  "updatedAt": "2026-06-18T13:00:00Z",
  "schemaVersion": 1
}
```

```json
{
  "projectId": "proj_gtm_migration",
  "name": "GTM Migration",
  "description": "Migration from legacy tags to new GTM container structure.",
  "status": "active",
  "memberCount": 2,
  "createdAt": "2026-06-18T13:10:00Z",
  "createdBy": "admin@thehammer.io",
  "updatedAt": "2026-06-18T13:10:00Z",
  "schemaVersion": 1
}
```

```json
{
  "projectId": "proj_q4_enablement",
  "name": "Q4 Enablement",
  "description": "Instructional content and rollout assets for Q4 sales enablement.",
  "status": "archived",
  "memberCount": 1,
  "createdAt": "2026-06-18T13:20:00Z",
  "createdBy": "admin@thehammer.io",
  "updatedAt": "2026-06-18T13:45:00Z",
  "schemaVersion": 1
}
```

### Schema — `users`

Each user document stores the human profile used by the Admin Portal and future role-aware workflows. This collection represents people, not credentials.

| Field | Type | Required | Description |
|---|---|---|---|
| `userId` | string | Yes | Stable identifier duplicated from document ID |
| `email` | string | Yes | Primary email address |
| `displayName` | string | Yes | Human-readable display name |
| `defaultRole` | string | Yes | Initial values: `admin`, `user`, `analyst`, `instructional_designer` |
| `isActive` | boolean | Yes | Soft-activation flag |
| `createdAt` | timestamp | Yes | Creation timestamp |
| `updatedAt` | timestamp | Yes | Last profile update timestamp |
| `schemaVersion` | number | Yes | Must be `1` |

Example documents:

```json
{
  "userId": "user_alice_chen",
  "email": "alice@thehammer.io",
  "displayName": "Alice Chen",
  "defaultRole": "admin",
  "isActive": true,
  "createdAt": "2026-06-18T13:00:00Z",
  "updatedAt": "2026-06-18T13:00:00Z",
  "schemaVersion": 1
}
```

```json
{
  "userId": "user_ben_singh",
  "email": "ben@thehammer.io",
  "displayName": "Ben Singh",
  "defaultRole": "analyst",
  "isActive": true,
  "createdAt": "2026-06-18T13:05:00Z",
  "updatedAt": "2026-06-18T13:05:00Z",
  "schemaVersion": 1
}
```

```json
{
  "userId": "user_chloe_martin",
  "email": "chloe@thehammer.io",
  "displayName": "Chloe Martin",
  "defaultRole": "instructional_designer",
  "isActive": false,
  "createdAt": "2026-06-18T13:15:00Z",
  "updatedAt": "2026-06-18T13:40:00Z",
  "schemaVersion": 1
}
```

### Schema — `project_memberships`

`project_memberships` is a flat join collection, not a nested subcollection. This is intentional so membership queries work in both directions (`project -> users` and `user -> projects`) without introducing subcollection drift, while still supporting the Sprint 5.6 transaction requirement.

| Field | Type | Required | Description |
|---|---|---|---|
| `membershipId` | string | Yes | Stable identifier duplicated from document ID, recommended format `{projectId}__{userId}` |
| `projectId` | string | Yes | Foreign key to `projects.projectId` |
| `userId` | string | Yes | Foreign key to `users.userId` |
| `role` | string | Yes | User's role within that specific project |
| `createdAt` | timestamp | Yes | Membership creation timestamp |
| `createdBy` | string | Yes | Actor who admitted the member |
| `schemaVersion` | number | Yes | Must be `1` |

Example documents:

```json
{
  "membershipId": "proj_website_redesign__user_alice_chen",
  "projectId": "proj_website_redesign",
  "userId": "user_alice_chen",
  "role": "admin",
  "createdAt": "2026-06-18T13:01:00Z",
  "createdBy": "admin@thehammer.io",
  "schemaVersion": 1
}
```

```json
{
  "membershipId": "proj_website_redesign__user_ben_singh",
  "projectId": "proj_website_redesign",
  "userId": "user_ben_singh",
  "role": "analyst",
  "createdAt": "2026-06-18T13:06:00Z",
  "createdBy": "admin@thehammer.io",
  "schemaVersion": 1
}
```

```json
{
  "membershipId": "proj_gtm_migration__user_chloe_martin",
  "projectId": "proj_gtm_migration",
  "userId": "user_chloe_martin",
  "role": "instructional_designer",
  "createdAt": "2026-06-18T13:16:00Z",
  "createdBy": "admin@thehammer.io",
  "schemaVersion": 1
}
```

### Uploads compatibility note

The existing `uploads` collection remains flat. Sprint 5 queries and later reporting features depend on each upload document carrying a `projectId` field so records can be filtered by project without introducing `projects/{projectId}/uploads/*` subcollections.

Minimum `uploads` fields required for Sprint 5 compatibility:

```json
{
  "uploadId": "upl_01jxzexample",
  "projectId": "proj_website_redesign",
  "userId": "user_alice_chen",
  "tool": "figma",
  "uploadedAt": "2026-06-18T14:00:00Z"
}
```

### Transaction rule for memberships

Task 5.6 requires `POST /admin/projects/:id/members` to use a Firestore transaction that writes the `project_memberships` document and increments `projects.memberCount` atomically. This schema is designed for that exact pattern and avoids any need for a `projects/{projectId}/members` subcollection.

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
