# Loop Engineering for The Hammer

This document outlines the feedback loops designed to optimize productivity, code safety, and system execution across three key domains: **AI Coding Agents**, **Developer Workflows (Coding)**, and the **Runtime Application (App)**.

---

## 1. Feedback Loops for AI Coding Agents (Agent Inner Loop)

AI agents require high-speed, high-fidelity feedback to parse, edit, and verify code without introducing hallucinations or syntax regressions.

### A. Fast Emulator Test Loop (Verification)
*   **Status:** **Active** (Fully operational)
*   **The Loop:** Code Modification $\rightarrow$ Run Emulator Suite $\rightarrow$ Observe Failures $\rightarrow$ Adjust Code.
*   **Benefit:** Rather than deploying to Cloud Build to verify integration success (which takes minutes), agents execute test suites against the local Firestore Emulator in under 11 seconds.
*   **Implementation:** The standard test run command:
    ```bash
    npx -y firebase-tools emulators:exec --only firestore --project demo-hammer "npm test"
    ```

### B. Anchored Knowledge Loop (Reasoning)
*   **Status:** **Active** (Fully operational)
*   **The Loop:** Parse Prompt $\rightarrow$ Query OSOT Index $\rightarrow$ Read Target Constraints $\rightarrow$ Formulate Plan.
*   **Benefit:** Prevents code drift and command trial-and-error by referencing static lookup registries ([`megamind.md`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/docs/megamind.md)) and historical gotchas ([`lessons_learned.md`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/lessons_learned.md)) before executing changes.

### C. Structured Logging Observability (Debugging)
*   **Status:** **Active** (Fully operational)
*   **The Loop:** Execute Server Process $\rightarrow$ Capture JSON Output $\rightarrow$ Self-Correct Stack Errors.
*   **Benefit:** Plaintext logs are difficult for agents to query programmatically. Consolidating output into structured JSON logs allows parsing code issues automatically in debug scopes.
*   **Implementation:** Enforced via [`backend/src/lib/logger.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/lib/logger.js) formatting.

---

## 2. Feedback Loops for Developer Workflows (Coding Inner Loop)

Human developer velocity hinges on reducing task context-switching and catching bugs at code-writing time rather than post-commit.

### A. Context Pre-Flight Validation (Pre-Commit Loop)
*   **Status:** **Requires Activation** (Setup is ready; requires action per developer workstation)
*   **The Loop:** Make Changes $\rightarrow$ Check GCP Account context locally $\rightarrow$ Run test suite against Emulator $\rightarrow$ Commit Code.
*   **Benefit:** Prevents build-time credential failures and target environment mismatches by checking configuration contexts locally.
*   **Activation Instructions:** Developers must run the installation script once to link the pre-commit hook into their local Git clones:
    ```powershell
    ./scripts/install-git-hook.ps1
    ```
    This links the validation script [`verify-gcp-env.ps1`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/verify-gcp-env.ps1) and emulator test runner to the `.git/hooks/pre-commit` workflow.

### B. Route Middleware Short-Circuiting (API Payload Loop)
*   **Status:** **Active** (Fully operational)
*   **The Loop:** Client Send Request $\rightarrow$ Middleware content check $\rightarrow$ Fast Error Reject / Success Pass.
*   **Benefit:** Rejecting invalid request types (e.g. non-multipart request formats) in pre-routing hooks, prior to buffer processing, prevents wasting memory and network bandwidth.
*   **Implementation:** Enforced in `requireMultipart` checks inside [`backend/src/index.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/index.js).

### C. Clean Local Emulator Isolation (Concurrence Loop)
*   **Status:** **Active** (Fully operational)
*   **The Loop:** Parallel Test Runs $\rightarrow$ Separate Test Database ID Allocation $\rightarrow$ Safe Teardown.
*   **Benefit:** Running concurrent tests against a single mock instance will result in data collisions if documents share IDs. Scoping document configurations natively prevents test teardowns from breaking running pipelines.
*   **Implementation:** Scoping document collections per test suite inside [`backend/tests/`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/tests/).

### D. Build-Time URL Injection Loop (Outer Loop Automation)
*   **Status:** **Requires Activation** (Code is ready; awaits the next deployment cycle)
*   **The Loop:** Code Push $\rightarrow$ Build Server boots $\rightarrow$ Query Backend URL dynamically $\rightarrow$ Inject into Portal client environment $\rightarrow$ Build Image.
*   **Benefit:** Eliminates hardcoded URL drifts between portals and backends by performing automated target API injection at image-build time.
*   **Activation Instructions:** Awaits trigger on the next Cloud Build deployment release cycle where the `inject-backend-url` build step in [`cloudbuild.yaml`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/cloudbuild.yaml) executes.

---

## 3. Feedback Loops for the Runtime Application (App Execution)

Runtime loops govern system robustness, tenant isolation, and interactive user flows.

### A. Active Inactivity Warning Loop (UX Engagement)
*   **Status:** **Active** (Fully operational)
*   **The Loop:** Inactivity Timer Expiry $\rightarrow$ extension triggers alert $\rightarrow$ user snoozes or captures.
*   **Benefit:** Reminds users to document visual work states after intervals, logging inactivity durations to Firestore to subtract from active time tracking correctly.
*   **Implementation:** Managed via service worker communications in [`extension/service-worker.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/extension/service-worker.js).

### B. Client Configuration Sync / Extension API URLs Loop (Synchronization)
*   **Status:** **Requires Activation** (Partially operational)
*   **The Loop:** Extension popup opens $\rightarrow$ Fetch GET `/config` with API key $\rightarrow$ Apply local settings adjustments.
*   **Benefit:** Synchronizes local retention settings, GCS upload thresholds, and user options with the central admin configurations, keeping client extensions aligned with the primary system definitions automatically.
*   **Activation Instructions:** The basic dynamic config synchronization is active inside [`extension/popup.js#L291`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/extension/popup.js#L291) (`loadConfig()`). However, fully automating the Extension's API endpoint setup requires adding Webpack/Build token replacement variables to compile the extension popup and service worker dynamically rather than keeping hardcoded API URLs.

### C. SSRF-Safe Webhook Dispatch (System Integration)
*   **Status:** **Active** (Fully operational)
*   **The Loop:** Event Occurs $\rightarrow$ Retrieve Webhook Target URL $\rightarrow$ Check Scope Allowlist $\rightarrow$ Safe POST Dispatch.
*   **Benefit:** Protects backend containers from server-side request forgery (SSRF) by validating outbound webhook destination targets against address allowlists before calling fetches.
*   **Implementation:** Enforced via `validateWebhookUrl()` inside [`backend/src/index.js`](file:///c:/Users/ChrisFro/Desktop/EmoGini/theHammer/backend/src/index.js#L173).
