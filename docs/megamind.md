# Megamind — OSOT Index

This document provides a single-entry index of critical architectural topics and their corresponding **One Source of Truth (OSOT)** locations in the codebase. Reference this index when changing core configurations or adding new components.

---

## 1. System Topics & OSOT Index

| Topic / Concept | Purpose | OSOT Location |
| :--- | :--- | :--- |
| **User Roles & Hierarchy** | Enforces user permissions, valid role assignments, and minimum role levels for APIs. | [`backend/src/lib/roles.js`](../backend/src/lib/roles.js) |
| **Settings & Configuration Defaults** | Baseline default constants for global configurations and per-user settings. | [`backend/src/lib/defaults.js`](../backend/src/lib/defaults.js) |
| **Firestore Collections** | Centralized string constants for Firestore collections to prevent typos and ease renaming. | [`backend/src/lib/collections.js`](../backend/src/lib/collections.js) |
| **Vertex AI Client Setup** | Unified Google GenAI / Vertex AI client factory enforcing project ID resolution and region configurations. | [`backend/src/lib/vertex.js`](../backend/src/lib/vertex.js) |
| **Database Instance Singleton** | Bootstrapping point of Firebase Admin Firestore singleton shared across all routes. | [`backend/src/lib/firestore.js`](../backend/src/lib/firestore.js) |
| **Structured Logging** | Central JSON logger library formatting messages for automated GCP Cloud Logging ingestion. | [`backend/src/lib/logger.js`](../backend/src/lib/logger.js) |
| **Test Fixtures & Seeding** | Core helpers for database cleaning and user/project seeding across all unit and integration tests. | [`backend/tests/helpers/fixtures.js`](../backend/tests/helpers/fixtures.js) |
| **SSRF Webhook Validation** | Security check constants and protocols restricting outbound dispatch calls from hitting local or metadata IP scopes. | [`backend/src/index.js`](../backend/src/index.js#L260-L270) |
| **CORS Allowed Origins** | Domain whitelist restricting and authorizing secure API requests from Extension and Admin Portal. | [`backend/src/index.js`](../backend/src/index.js#L38-L43) |
| **Build & Deploy Pipeline** | Configuration for container builds, Jest emulator tasks, and multi-service Cloud Run deployment setups. | [`cloudbuild.yaml`](../cloudbuild.yaml) |
| **Local Dev context checking** | Deployment target context checks preventing cross-project deployments and validating credentials. | [`verify-gcp-env.ps1`](../verify-gcp-env.ps1) |
| **Test Environment & Timeouts** | Jest configuration for the backend suite: the hook timeout budget and the offline environment applied before any test module loads. | [`backend/jest.config.js`](../backend/jest.config.js) |
| **Extension Messaging Contracts** | Data structure schemas and actions used for content-script, popup, and service-worker messaging. | Comment blocks at the top of [`extension/service-worker.js`](../extension/service-worker.js) |
| **Developer Rules & History** | Directives, guardrails, and lessons learned from past sprint bugs and deployment hiccups. | [`lessons_learned.md`](../lessons_learned.md) |

---

## 2. Topic References & Details

### User Roles & Hierarchy
*   **Module:** [`backend/src/lib/roles.js`](../backend/src/lib/roles.js)
*   **Exports:** `ROLE_HIERARCHY` (tier mapping), `VALID_ROLES` (roles list).
*   **Usage:** Validates authorization levels in `requireAuth.js`, user routing profiles, and workspace allocations.

### Settings Defaults
*   **Module:** [`backend/src/lib/defaults.js`](../backend/src/lib/defaults.js)
*   **Exports:** `USER_PREFERENCES` (e.g. `inactivityTimerSeconds`), `CONFIG_DEFAULTS` (e.g. `maxFileSizeBytes`).
*   **Usage:** Sets base configurations for global profiles `/config` and test fixture generation.

### Firestore Collections
*   **Module:** [`backend/src/lib/collections.js`](../backend/src/lib/collections.js)
*   **Exports:** String references matching names in Firestore (e.g. `collections.USERS`, `collections.PROJECTS`).
*   **Usage:** Imports collections inside routers and database transactions to avoid copy-paste drift.

### Vertex AI Client Setup
*   **Module:** [`backend/src/lib/vertex.js`](../backend/src/lib/vertex.js)
*   **Exports:** `getAIClient()` helper, project fallback defaults, region targets.
*   **Usage:** Shared by reports and OCR background workers for vertex inference operations.

### SSRF Webhook Validation
*   **Module:** [`backend/src/index.js`](../backend/src/index.js#L260-L270)
*   **Exports:** Internal checks (`validateWebhookUrl`, `PRIVATE_IP_RE`).
*   **Usage:** Evaluated prior to server-side webhook dispatch requests to prevent computational metadata server attacks or local traversal breaches.

### CORS Allowed Origins
*   **Module:** [`backend/src/index.js`](../backend/src/index.js#L38-L43)
*   **Exports:** `ALLOWED_ORIGINS` array.
*   **Usage:** Restricts cross-origin resource access in production to registered admin portals and secure extension environments.

### Build & Deploy Pipeline
*   **Module:** [`cloudbuild.yaml`](../cloudbuild.yaml)
*   **Usage:** Controls step sequencing (emulating, building, local smoke-testing, deploying Cloud Run containers) during deployment cycles.

### Local Dev Context checking
*   **Module:** [`verify-gcp-env.ps1`](../verify-gcp-env.ps1)
*   **Usage:** Executed context validators ensuring correct active IAM account configuration and target project properties before deployment operations.

