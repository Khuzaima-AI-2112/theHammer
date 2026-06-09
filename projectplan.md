# The Hammer — Project Plan

## Overview

A Chrome extension that captures a screenshot of the active tab and uploads it to Google Cloud Storage. The file is automatically named based on three user-configured fields: **project**, **tool used**, and **user name**. Captures can be triggered via a keyboard shortcut, the extension toolbar button, or an injected floating button on the page.

---

## Goals

- One-click / one-shortcut screenshot capture from any tab
- Automatic file naming: `{project}/{tool}/{yyyy}/{mm}/{dd}/{name}_{timestamp}.png`
- Upload to Google Cloud Storage with zero manual steps
- Lightweight backend on Google Cloud (Cloud Functions 2nd gen)
- Internal team use: 5 users, ~30 images/day each (~150/day total)
- Estimated cost: under $1/month

---

## Architecture

```
Chrome Extension (MV3)
  ├── Popup (set project / tool / name)
  ├── Service Worker (keyboard shortcut, toolbar button, message relay)
  ├── Content Script (floating page button)
  └── chrome.tabs.captureVisibleTab() → PNG data URL
         ↓
Cloud Functions 2nd Gen (Node.js / Express)
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
| Permissions | `activeTab`, `storage`, `scripting` | Minimum privilege; no install warning |
| Keyboard shortcut | `chrome.commands` API | Activates `activeTab` permission |
| Settings storage | `chrome.storage.local` | Persists across service worker restarts |
| Backend | Cloud Functions 2nd gen (Node.js) | Simple HTTP endpoint, serverless, ~$0 at this scale |
| Storage | Google Cloud Storage (Standard class) | ~$0.02/GB-month, object naming, lifecycle rules |
| Metadata (v2) | Firestore | Optional: upload history, per-project views |
| Auth | API key via `X-Api-Key` header + Secret Manager | Practical for small team; upgradeable to IAP |

---

## Object Naming Convention

```
{project}/{tool}/{yyyy}/{mm}/{dd}/{sanitized-name}_{ISO-timestamp}.png
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

---

## Three Trigger Methods

| Trigger | How it works |
|---|---|
| Keyboard shortcut | `chrome.commands.onCommand` in service worker → `captureVisibleTab()` |
| Toolbar button | `chrome.action.onClicked` in service worker → `captureVisibleTab()` |
| Floating page button | Content script injects button → `chrome.runtime.sendMessage` → service worker → `captureVisibleTab()` |

---

## Known Constraints

- `captureVisibleTab()` captures **visible area only** — not the full scrollable page
- Cannot capture `chrome://` system pages or the Chrome DevTools window
- Service worker shuts down after ~30 seconds idle (Chrome 110+); woken up on event
- Never store settings in `localStorage` — use `chrome.storage.local`
- Signed URL uploads (Phase 2) require V4 signing; V2 has a known CORS bug
- Cloud Functions 2nd gen cold starts are typically 500ms–2s; acceptable for internal tools

---

## Cost Estimate (5 users × 30 images/day)

| Component | Monthly cost |
|---|---|
| Cloud Functions 2nd gen compute | ~$0 (well within free tier) |
| Cloud Storage writes (4,500/month) | ~$0.02 |
| Cloud Storage data (30-day retention, ~4.5 GB) | ~$0.10 |
| Firestore (optional metadata) | ~$0 (within free tier) |
| **Total** | **~$0.10–$0.25/month** |

---

## Repo Structure

```
thehammer/
├── extension/
│   ├── manifest.json
│   ├── service-worker.ts
│   ├── popup.html
│   ├── popup.ts
│   ├── content.ts
│   └── icons/
├── backend/
│   ├── index.ts          ← Cloud Function entry point
│   ├── storage.ts
│   ├── naming.ts
│   └── package.json
├── infra/
│   └── deploy.sh         ← gcloud deploy commands
├── projectplan.md
└── sprintplan.md
```

---

## Distribution

Publish as **Unlisted** on the Chrome Web Store — accessible by direct link, no Google Workspace required, skips most review friction.
