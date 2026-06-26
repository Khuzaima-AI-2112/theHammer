# Walkthrough — Establishing One Source of Truth (OSOT)

This document provides a summary of the accomplishments, changes implemented, and validation results from consolidating the backend configuration, roles, database collections, and Vertex AI configurations.

## Summary of Changes

We established four distinct **One Source of Truth (OSOT)** modules in the backend, and updated the API middleware, routes, background workers, and test suite to use them instead of raw string literals or duplicate declarations.

### 1. New OSOT Modules Created
*   **Roles & Hierarchy:** [`backend/src/lib/roles.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/lib/roles.js) — Unified definition of roles and hierarchy permissions.
*   **Settings Defaults:** [`backend/src/lib/defaults.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/lib/defaults.js) — Holds baseline fallback defaults for global configs and user settings.
*   **Collection Registry:** [`backend/src/lib/collections.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/lib/collections.js) — Enlists standard strings for all Firestore collections.
*   **Vertex AI Client Factory:** [`backend/src/lib/vertex.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/lib/vertex.js) — Standardized constructor that enforces uniform regional configuration (`northamerica-northeast1`) and project fallback ID evaluation.

### 2. Integration Across Backend Components
*   **Middleware:** Integrated central role hierarchy and user preference fallbacks inside the authentication parser:
    *   [`backend/src/middleware/requireAuth.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/middleware/requireAuth.js)
*   **Routes:** Replaced raw Firestore collection targets, role arrays, and hardcoded fallbacks in all admin routes:
    *   [`backend/src/routes/admin/users.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/routes/admin/users.js)
    *   [`backend/src/routes/admin/projects.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/routes/admin/projects.js)
    *   [`backend/src/routes/admin/workspaces.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/routes/admin/workspaces.js)
    *   [`backend/src/routes/admin/me.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/routes/admin/me.js)
    *   [`backend/src/routes/admin/activity.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/routes/admin/activity.js)
    *   [`backend/src/routes/admin/dashboard.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/routes/admin/dashboard.js)
    *   [`backend/src/routes/admin/reports.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/routes/admin/reports.js)
*   **Core Entry Point:** Refactored uploads writing and tenant checks in the main server logic:
    *   [`backend/src/index.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/index.js)
*   **Workers:** Centralized Vertex AI constructor instantiations:
    *   [`backend/src/worker/reportsWorker.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/worker/reportsWorker.js)
    *   [`backend/src/worker/ocrWorker.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/worker/ocrWorker.js)

### 3. Test Fixtures Realignment
*   [`backend/tests/helpers/fixtures.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/tests/helpers/fixtures.js) was modified to seed database records referencing collection constants from `collections.js` and baseline configurations from `defaults.js`.

---

## Verification & Testing

### 1. Automated Test Suite
We executed the entire backend test suite (`45` individual tests across `5` execution suites) inside local Firestore Emulator containers. All test suites completed successfully.
```bash
Ran all test suites.
Test Suites: 5 passed, 5 total
Tests:       45 passed, 45 total
Snapshots:   0 total
Time:        10.671 s
```

### 2. Manual Verification
We launched the backend server on port `8081` connected to the Firestore Emulator. Pinging the health endpoint confirmed a successful connection:
```bash
curl -s http://127.0.0.1:8081/health
{"status":"ok","firestore":"connected"}
```
This validates that database routing, collection resolution, and schema wiring are functioning as expected.
