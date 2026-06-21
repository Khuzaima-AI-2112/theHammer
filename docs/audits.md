# LLM Codebase Audit Strategies for The Hammer

When using an LLM to audit a full-stack application like this (Chrome Extension + Node.js/Express Backend + Firebase/GCP), the biggest risks are **hallucinations**, **skipped details**, and **vague, generic advice**. 

To mitigate this, you must **constrain the LLM** by forcing it to evaluate one specific domain at a time, requiring it to output a strict checklist, and demanding exact code citations for every finding.

---

## 1. Types of Audits to Run

Do not ask the LLM to "Audit my app." Break the audit down into these specific domains:

### A. Security & Tenant Isolation Audit
* **Focus:** Authorization middleware, tenant data isolation (workspace/project boundaries), Firebase Auth token validation, rate-limiting, and Google Cloud Storage (GCS) Signed URL security.
* **Key Risk:** Cross-tenant data leakage or unauthorized screenshot uploads.

### B. Chrome Extension Architecture & Manifest V3 Audit
* **Focus:** Service worker lifecycle (suspension/wakeups), message passing security between content scripts and the background worker, `chrome.storage.local` security, and `manifest.json` permissions.
* **Key Risk:** Memory leaks in the service worker, overly broad host permissions, or content script injection vulnerabilities.

### C. Error Handling & Edge Case Audit
* **Focus:** Network failures, race conditions, offline handling in the popup, handling missing `X-Api-Key` headers, and cleanup of aborted multipart uploads in multer/Express.
* **Key Risk:** Silent failures when the backend is unreachable or when GCP storage limits are hit.

---

## 2. How to Structure the Audit Prompts

To guarantee comprehensive results, every prompt you feed to the LLM should follow this strict structure:

1. **The Persona:** Define exactly who the LLM is acting as (e.g., "Senior Cloud Security Architect").
2. **The Scope:** Explicitly state what files are provided and what they do.
3. **The Mandatory Checklist:** Provide a numbered checklist that the LLM *must* evaluate item by item.
4. **The Output Constraints:** Demand a specific format. Require the LLM to cite line numbers or exact code snippets to prove it isn't hallucinating. Tell it to output "N/A" if a checklist item doesn't apply, rather than skipping it.

---

## 3. Copy-Paste Audit Prompt Templates

Below are comprehensive prompt templates you can use. Paste the prompt, followed by the relevant code files.

### Prompt 1: Security & Tenant Isolation Audit

```markdown
Act as a Senior Cloud Security Architect and Node.js backend expert. I am providing you with the source code for my Express.js backend API (`index.js` and routing files). This API receives screenshots from a Chrome Extension and stores them in Google Cloud Storage. It uses Firebase Authentication.

Your task is to conduct a rigorous security audit. You MUST evaluate the code against the following strict checklist. Do not skip any items. 

**Mandatory Checklist:**
1. [ ] **Auth Validation:** Are Firebase tokens or API keys strictly verified before ANY logic executes on protected routes?
2. [ ] **Tenant Isolation:** Does every endpoint explicitly verify that the requesting user belongs to the `workspaceId` of the requested `projectId` before reading/writing database records or generating GCS URLs?
3. [ ] **Rate Limiting:** Are global and route-specific rate limits appropriately applied to prevent DoS attacks?
4. [ ] **Input Sanitization:** Are all user inputs (tool name, project IDs, URLs) sanitized before being used in file paths or database queries to prevent path traversal or injection?
5. [ ] **Signed URL Security:** Do the GCS signed URLs have strictly constrained expiration times (e.g., < 15 minutes) and proper action scopes (read vs. write)?

**Output Format Requirements:**
For each checklist item, you must output:
- **Status:** [Pass / Fail / Warning]
- **Finding:** A specific, non-vague explanation of the vulnerability or confirmation of security.
- **Evidence:** You MUST quote the exact code snippet or line number that proves your finding. If you cannot cite evidence, you must state "Insufficient context".
- **Remediation:** If Failed/Warning, provide the exact code change required.

Please read the following files to conduct the audit:
- `backend/src/index.js`
- `backend/src/middleware/requireAuth.js`
- `backend/src/routes/admin/projects.js`
- `backend/src/routes/admin/users.js`
```

### Prompt 2: Chrome Extension Manifest V3 & Background Worker Audit

```markdown
Act as a Senior Chrome Extension Developer specializing in Manifest V3. I am providing you with my `manifest.json`, `service-worker.js`, and `content.js` files. 

Your task is to conduct a rigorous architecture and lifecycle audit. You MUST evaluate the code against the following strict checklist. Do not skip any items.

**Mandatory Checklist:**
1. [ ] **Manifest Permissions:** Are the requested permissions (e.g., `activeTab`, `storage`, host permissions) strictly necessary, or are they overly broad?
2. [ ] **Service Worker Lifecycle:** Does the `service-worker.js` rely on any persistent global state (variables) that will be lost when the browser suspends the worker?
3. [ ] **Message Passing Security:** Does `chrome.runtime.onMessage` validate the sender before executing sensitive commands (like initiating a capture or uploading data)?
4. [ ] **Memory Management:** Are long-lived ports (`chrome.runtime.connect`) properly closed when no longer needed to prevent the service worker from being artificially kept alive indefinitely?
5. [ ] **Error Handling:** Are `chrome.runtime.lastError` checks properly implemented after every async Chrome API call?

**Output Format Requirements:**
For each checklist item, you must output:
- **Status:** [Pass / Fail / Warning]
- **Finding:** A specific, non-vague explanation.
- **Evidence:** You MUST quote the exact code snippet that proves your finding.
- **Remediation:** If Failed/Warning, provide the exact code change required.

Please read the following files to conduct the audit:
- `extension/manifest.json`
- `extension/service-worker.js`
- `extension/content.js`
```

### Prompt 3: Error Handling & Edge Case Audit

```markdown
Act as a Senior QA Engineer. I am providing the `popup.js` (UI) and `index.js` (backend) for my application. 

Your task is to audit how the system handles edge cases and failures. You MUST evaluate the code against the following strict checklist. Do not skip any items.

**Mandatory Checklist:**
1. [ ] **Backend Unavailability:** If the backend API is offline or returns a 502, does the extension gracefully handle the error and notify the user, or does it fail silently/crash?
2. [ ] **Incomplete Settings:** If `chrome.storage.local` is empty or missing expected keys on first launch, does the UI crash or fallback gracefully?
3. [ ] **File Size Limits:** If the user attempts to upload a payload larger than the multer limits (e.g., 10MB), does the backend catch the error and send a clean 4xx response, or does it crash the Node process?
4. [ ] **Race Conditions:** If the user clicks "Capture" or "Save" multiple times rapidly, are there safeguards (debouncing/disabling buttons) to prevent duplicate API requests?

**Output Format Requirements:**
For each checklist item, you must output:
- **Status:** [Pass / Fail / Warning]
- **Finding:** A specific explanation.
- **Evidence:** You MUST quote the exact code snippet that proves your finding.
- **Remediation:** If Failed/Warning, provide the exact code change required.

Please read the following files to conduct the audit:
- `extension/popup.js`
- `backend/src/index.js`
```
