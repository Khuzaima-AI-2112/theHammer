# The Hammer — Lessons Learned

> **Purpose of this file**
>
> This is a living record of real mistakes made during development of The Hammer, and the
> rules derived from them. Every entry follows the same structure: what happened, why it
> happened, and the concrete rule that prevents it from happening again.
>
> **When to read it:** at the start of every sprint, before writing any code.
>
> **When to update it:** the moment a new mistake is identified — in the same PR as the fix,
> not after. A mistake without a lesson entry is a mistake waiting to recur.
>
> **What belongs here:** only real mistakes from this repo's own history. Do not add
> hypothetical risks or general best-practice advice. Every entry must have a "What happened"
> grounded in actual code that was committed.

---

## Lessons Learned

### 1. Content script response shape must be updated in lockstep with the service worker

**What happened:** `service-worker.js` changed its `sendResponse` payload from `{ ok, length }` (Sprint 1) to `{ ok, path }` (Sprint 2). `content.js` was not updated. It still logs `response.length`, which is now always `undefined`.

**Root cause:** The two files are tightly coupled through a shared message contract, but there was no single place that defined that contract. One side was updated; the other was missed.

**Rule going forward:**
- Define the message response shape as a comment block at the top of `service-worker.js` (the authoritative side) in the format: `// CAPTURE response: { ok: bool, path?: string, reason?: string, error?: string }`.
- When that contract changes, do a repo-wide search for all consumers (`content.js`, `popup.js`) before committing.
- Add an integration smoke test that asserts the floating button log output matches the current schema.

---

### 2. Dead middleware stubs mislead future readers and violate the spec

**What happened:** `validateRequiredFields` was written as a named middleware function, given a comment claiming it "runs before multer," and then: (a) never wired into the route, and (b) implemented as a plain `next()` call that does nothing. The spec explicitly required validation before multer to avoid buffering files for invalid requests. The code and the comments both claimed this was done.

**Root cause:** The constraint (can't read multipart body before multer) was encountered mid-implementation and worked around by moving validation post-multer — but the stub and the false comment were left in place rather than removed or corrected.

**Rule going forward:**
- If a constraint changes where something lives (pre- vs. post-middleware), update the comment at the same time. Never leave a comment that describes intent that differs from reality.
- Dead functions must be deleted, not left as stubs. If a function exists in the file, it must be wired into the execution path or clearly marked `// NOT USED — kept for reference` with an explanation.
- For this specific case: the honest solution is a pre-multer `Content-Type` check (reject non-multipart immediately) plus honest post-multer field validation. Document the tradeoff explicitly.

---

### 3. Timing-safe comparisons must not short-circuit on length before the safe comparison runs

*(Note: API Keys were deprecated in Sprint 23 in favor of Firebase Auth ID tokens, but this principle of constant-time comparison remains critical for any backend secret validation).*

**What happened:** The API key check performed `crypto.timingSafeEqual(expBuf, provBuf) && provided.length === expected.length`. The separate `provided.length === expected.length` check runs in non-constant time and reveals whether the attacker's key length matches the expected length, which narrows the brute-force space.

**Root cause:** The constant-time comparison was added, but a secondary length check was left alongside it without recognising that it leaks timing information.

**Rule going forward:**
- The canonical constant-time key comparison in Node is: derive a fixed-length HMAC of both sides using the same key and then compare the HMACs with `timingSafeEqual`. This way both buffers are always the same length and neither branch reveals length information.
- Never split a timing-safe check into a safe comparison plus a non-safe length check. Do it all inside one `timingSafeEqual` call on equal-length buffers.
- Reference implementation (now live in `backend/src/index.js`):

```js
function keysEqual(provided, expected) {
  const h = (s) => crypto.createHmac('sha256', 'hammer-key-check').update(s).digest();
  try {
    return crypto.timingSafeEqual(h(provided), h(expected));
  } catch (_) {
    return false;
  }
}
```

---

### 4. Placeholder default values that look like real URLs cause confusing 15-second hangs

**What happened:** `DEFAULT_CLOUD_RUN_URL` was set to `'https://YOUR_CLOUD_RUN_URL'`. If a user bypassed the guard, the extension made a real HTTPS fetch to that address, did a DNS lookup, and waited ~25 seconds before showing an error.

**Root cause:** The placeholder was copied from documentation style into production code without adding a corresponding guard.

**Rule going forward:**
- Placeholder values in production code must be the sentinel that triggers a guard, not a fake-but-valid-looking value. Use `''`, `null`, or a value that is explicitly checked.
- Any configuration value read from storage must have an explicit "not configured" check with an immediate user-facing notification before it is ever used in a network call.

---

### 5. Spec task descriptions with both a rule and a "done when" test must be cross-checked at implementation time

**What happened:** Task 2.3 had two statements: (a) *"Validation middleware runs before `multer`"* and (b) *"Valid upload → 200; missing `file` field → 400."* The implementation satisfied (b) but not (a). The summary written in the handoff said it was done, citing only the passing test case.

**Root cause:** "Done when" test cases are necessary but not sufficient. They test outcomes, not implementation constraints.

**Rule going forward:**
- Every sprint task has two things to verify: the **outcome test** (does it return 400?) and the **implementation constraint** (does the validation run before multer?). Both must be checked off explicitly.
- Add an architecture assertion to the test file when the constraint cannot be visually verified from the route definition alone.

---

### 6. The deploy script's Docker build step must match the actual project structure

**What happened:** The sprint brief specified `COPY dist/ ./dist/` (implying a TypeScript compile step). The project has no TypeScript; source lives in `src/`. The Dockerfile was correctly changed to `COPY src/ ./src/`, but the deviation was not documented, creating a re-introduction risk.

**Root cause:** The spec Dockerfile was treated as a template to copy verbatim rather than as a starting point to adapt to the actual project structure.

**Rule going forward:**
- When a spec artifact conflicts with the actual repo structure, adapt it and add a comment explaining the deviation.
- Document all deliberate deviations from the sprint brief in `sprintplan.md` under a "Deviations" subsection for the sprint.

---

### 7. `sprintplan.md` must be updated in the same commit as the code it tracks

**What happened:** The sprint plan was never updated to mark Sprint 2 tasks in-progress or complete. The file's SHA was identical before and after all Sprint 2 code was pushed.

**Root cause:** Plan updates were treated as optional documentation work rather than part of the definition of done.

**Rule going forward:**
- `sprintplan.md` is a required file in every sprint commit that changes a task's status.
- The completion gate for every sprint explicitly includes `sprintplan.md` being current.

---

### 8. Never write a Docker digest by hand — always fetch it from the registry

**What happened (Sprint 4, 2026-06-15):** Task 4.10 required pinning the Dockerfile base image to a digest (`FROM node:20-alpine@sha256:…`). The digest `sha256:b4f5ff13f7bb7ee9a07caf7f2df29c0f2c02f11b9f2d17a3aa8a0c4db7ef1b6d` was written into the Dockerfile without querying a registry. The value looked plausible (correct length, correct format) but was fabricated. A `docker build` would have failed immediately with "manifest unknown".

**Root cause:** A digest is a content-addressed hash of a specific image manifest. It cannot be guessed, derived, or approximated — it must be retrieved from the registry that holds the image. Writing it from memory or imagination produces a value that passes visual inspection but fails at build time.

**Rule going forward:**
- **Never write a digest by hand.** Always run one of the following before committing:
  ```sh
  # Option 1 — pull then inspect (requires Docker daemon)
  docker pull node:20-alpine
  docker inspect --format='{{index .RepoDigests 0}}' node:20-alpine

  # Option 2 — query the registry API without pulling
  crane digest node:20-alpine          # github.com/google/go-containerregistry
  skopeo inspect --format '{{.Digest}}' docker://node:20-alpine
  ```
- Add a comment in the Dockerfile with the date pinned and the re-pin command, so the next engineer knows exactly how to refresh it:
  ```dockerfile
  # Pinned 2026-06-15. To re-pin:
  # docker pull node:20-alpine && docker inspect --format='{{index .RepoDigests 0}}' node:20-alpine
  FROM node:20-alpine@sha256:<fetched-value>
  ```
- Re-pin every 90 days or after a CVE disclosure affecting the base image.
- This rule applies to **any** content-addressed identifier (OCI digests, git SHAs used as dependencies, npm `integrity` hashes). If you did not retrieve it from the authoritative source, do not commit it.

---

## Fix Plan

The following table maps each lesson to a concrete code fix, the file(s) to change, and the acceptance test that confirms it is resolved.

| # | Lesson | File(s) | Fix | Acceptance test |
|---|--------|---------|-----|-----------------|
| 1 | Response contract mismatch | `extension/content.js`, `extension/service-worker.js` | Add contract comment to `service-worker.js`; update `content.js` to log `response.path` | Trigger floating button capture; confirm console shows `path:` value, not `length: undefined` |
| 2 | Dead middleware stub | `backend/src/index.js` | Delete `validateRequiredFields` function; add pre-multer `Content-Type` check; update all comments | `curl` with non-multipart Content-Type returns 400 before file is read |
| 3 | Timing-safe key comparison | `backend/src/index.js` | Replace padded-buffer comparison with HMAC-based `keysEqual()` | Wrong key → 401; correct key → 200; one-byte-short key → 401 |
| 4 | Placeholder default URL | `extension/service-worker.js` | Set `DEFAULT_CLOUD_RUN_URL = ''`; add explicit empty-string guard | Capture with URL unset → instant notification, no network request |
| 5 | Spec constraint vs. outcome | `backend/src/index.js`, tests | Add pre-multer Content-Type middleware; add architecture-level test | New test `'rejects non-multipart before buffering'` passes |
| 6 | Spec Dockerfile deviation | `backend/Dockerfile` | Add deviation comment; verify `COPY src/` present, no `dist/` reference | `docker build ./backend` completes on a clean checkout |
| 7 | Stale sprint plan | `sprintplan.md` | Mark all Sprint 2 tasks complete; add "Deviations" subsection | `sprintplan.md` reflects current task status |
| 8 | Hallucinated Docker digest | `backend/Dockerfile` | Replace fabricated digest with value from `docker inspect` | `docker build ./backend` completes; `docker inspect` confirms correct digest |

---

## Sprint Pre-flight Checklist

Run this before starting any new sprint:

- [ ] All fix-plan items above are merged to `main`
- [ ] `node --test tests/**/*.test.js` passes with zero failures
- [ ] `curl $SERVICE_URL/health` returns `{ "status": "ok" }` on the deployed service
- [ ] All three capture triggers produce a GCS object within 5 seconds
- [ ] `sprintplan.md` previous sprint section is fully checked off
- [ ] This file (`lessons_learned.md`) has been read and is current
- [ ] Any new Dockerfile base-image digest was fetched from the registry, not written by hand
- [ ] This file (`lessons_learned.md`) is linked from `AGENTS.md` so future agent sessions are aware of it

---

## Sprint 3 Lessons Learned

### 9. PowerShell backtick continuations break silently with trailing whitespace

**What happened:** Running `infra/deploy.ps1` failed with confusing `Unexpected token '}'` and `The Try statement is missing its Catch` errors.
**Root cause:** PowerShell uses the backtick (`` ` ``) as a line continuation character. If a trailing space exists after the backtick, it acts as an escape for the space instead, breaking the continuation. This causes the next line to be parsed as a separate command, breaking the AST and triggering cascading syntax errors downstream.
**Rule going forward:**
- Avoid using backticks for line continuation in PowerShell scripts. Focus on natural line breaks (e.g. breaking after a pipe `|` or comma) or use splatting (`@params`) for long commands like `gcloud run deploy`.
- If backticks must be used, ensure your editor is configured to trim trailing whitespace automatically.

### 10. Deploy scripts should validate the active project environment

**What happened:** The deploy script relied on `$env:GCP_PROJECT_ID` being set. If the environment variable isn't set in the current shell session, the deployment would fail or target the wrong project environment.
**Rule going forward:**
- Rather than solely relying on environment variables, build fallback validation into scripts. Using commands like `gcloud config get-value project` to confirm the target matches the intention (`thehammer`) prevents deployment accidents.

### 11. Cloud Build inline bash scripts require escaped substitution variables ($$)

**What happened:** A Cloud Build deployment failed with `generic::invalid_argument: invalid value for 'build.substitutions': key in the template "BACKEND_URL" is not a valid built-in substitution`.
**Root cause:** Shell variables like `$BACKEND_URL` were used in an inline bash script within `cloudbuild.yaml`. Cloud Build evaluates anything starting with `$` as a Cloud Build substitution variable *before* passing the script to bash. Since `$BACKEND_URL` isn't a native substitution, Cloud Build aborted the build.
**Rule going forward:**
- Single dollar signs (`$`) should exclusively be used for Cloud Build built-ins (like `$PROJECT_ID` or `$COMMIT_SHA`) or explicitly defined custom substitutions.

---

## Sprint 5–9 Lessons Learned

### 12. Firestore Transactions Require All Reads Before Writes

**What happened:** During Sprint 9, an update to role synchronization in `backend/src/routes/admin/users.js` attempted to perform a `tx.update(userRef)` and then query `db.collection('api_keys')` within the same transaction using `tx.get(query)`. This caused a transaction failure.
**Root cause:** Firestore transactions strictly require all read operations (`get`) to be performed before any write operations (`set`, `update`, `delete`).
**Rule going forward:**
- Always structure Firestore transactions in two distinct phases: gather all required data via `tx.get()` first, process the business logic, and then apply all mutations via `tx.set()`, `tx.update()`, and `tx.delete()` at the very end.

### 13. Binary Authorization Blocks Ad-Hoc Developer Deployments

**What happened:** Task 9.12 called for enforcing Binary Authorization on the Cloud Run instances to ensure only images built by Cloud Build could be deployed. However, it was realized that this blocks the team's ability to run `gcloud run deploy` directly from a developer desktop.
**Root cause:** Binary Authorization works by requiring a cryptographic attestation (signature) from a designated attestor (e.g., Cloud Build) before an image can be deployed to the environment. Desktop-built images lack this attestation.
**Rule going forward:**
- When strict CI/CD enforcement is desired but ad-hoc deployments are still required for velocity or troubleshooting, Binary Authorization enforcement should be kept in "dry run" mode, or disabled entirely for the target environment, until the team is ready to fully deprecate laptop deployments.

### 14. Firebase Admin SDK Bypasses All Firestore Security Rules

**What happened:** When auditing `firestore.rules` for strict access control (Task 9.11), the rules were set to `allow read, write: if false;`, which appeared completely locked down. However, the backend Node.js application (using `firebase-admin` with Application Default Credentials) could still read and write freely.
**Root cause:** The Firebase Admin SDK operates with elevated service account privileges that bypass all client-side security rules by design.
**Rule going forward:**
- `firestore.rules` should only be relied upon to restrict untrusted client applications (web/mobile SDKs). 
- Any backend service using the Admin SDK must enforce its own strict authorization and role-based access control (RBAC) in its route handlers (e.g., `requireAdmin` middleware), because the database layer will not reject its requests.

### 15. Cloud IAP is Too Heavy for Small B2B SaaS Portals

**What happened:** During the Sprint 20 implementation to add Workspaces and B2B SaaS Multi-Tenancy, we tried to rely on Google Cloud IAP for identity. However, provisioning Cloud IAP required complex setups (OAuth Consent Screens, configuring Backend Services in the Load Balancer, and assigning GCP IAM roles to standard users). The user found this excessively "tricky" and lacked the permissions or desire to manage IAM roles for external end-users.
**Root cause:** Cloud IAP is fundamentally an enterprise zero-trust proxy designed for internal corporate applications where users already exist in a Google Workspace directory. It is not designed to be the customer-facing identity provider for a multi-tenant B2B SaaS application.
**Rule going forward:**
- Use Firebase Authentication for any customer-facing or B2B SaaS identity needs. It provides drop-in UI widgets, handles multi-provider sign-ins natively, and does not require touching GCP IAM or Load Balancer configurations.
- Reserve Cloud IAP exclusively for internal administrative tools or strict enterprise intra-company access.

### 16. Firebase Admin SDK Version 14 requires Node >= 22 and breaks Jest on Node 20

**What happened:** A routine package update bumped `firebase-admin` to `^14.0.0` in the backend. When Cloud Build triggered its test step using the `node:20-alpine` image, it immediately crashed with a fatal Jest error: `Jest's require(ESM) requires Node v24.9+ for synchronous vm module APIs`.
**Root cause:** `firebase-admin` v14 depends on a version of `jose` that is strictly ESM. While the application might run fine in production, Jest running on Node 20 struggles with synchronous ESM imports without experimental flags. Furthermore, the `firebase-admin@14.0.0` package officially dropped support for Node 20, requiring Node >= 22. Because our CI environments (`cloudbuild.yaml` and `Dockerfile`) were intentionally pinned to Node 20 (as documented in Lesson 8), there was a hard conflict between the updated package and the pinned runtime.
**Rule going forward:**
- Check runtime requirements before upgrading major versions of core libraries. If a package requires a higher Node version than what the deployment targets are pinned to, downgrade the package (e.g., to `^13.10.0`) to unblock the build unless upgrading the environment is explicitly scoped.
- If upgrading Node across the stack is desired, it must be planned carefully by repinning all `node:*` base images across `cloudbuild.yaml` and all `Dockerfiles` concurrently to avoid environment mismatch failures.

### 17. Path Sanitization must handle directory traversal sequences

**What happened:** A unit test verifying that adversarial inputs (`../../etc/passwd`) are correctly sanitized failed. The `sanitize` function replaced invalid characters with underscores (`_`), but since the period (`.`) was in the allowlist for file extensions, the output was `.._.._etc_passwd`, which still contained the directory traversal sequence `..`.
**Root cause:** Allowing periods without specifically guarding against consecutive periods (`..`) inadvertently preserves path traversal logic if those sanitized strings are later concatenated into file system or bucket paths.
**Rule going forward:**
- Explicitly strip or replace directory traversal sequences (`..`) in path sanitization logic before or after applying character allowlists. E.g., `.replace(/\.\./g, '_')`.

### 18. Cloud Build cross-container emulator communication requires a single step

**What happened:** A Cloud Build pipeline attempted to start the Firestore Emulator in a background step (`gcr.io/google.com/cloudsdktool/cloud-sdk`) and then run Jest tests in a subsequent step (`node:20-alpine`). The tests failed to connect to the emulator (`ECONNREFUSED 127.0.0.1:8080`) and ultimately crashed.
**Root cause:** Cloud Build executes each step in a separate, isolated Docker container. While steps share a workspace volume (`/workspace`), they do *not* share a `localhost` network stack by default. A service listening on `127.0.0.1` in one container is completely inaccessible from another container.
**Rule going forward:**
- If tests require a local emulator, run the emulator and the tests within the *same* Cloud Build step using `firebase emulators:exec`. Ensure the chosen container image has both the language runtime (Node.js) and the emulator dependencies (Java) installed.

### 19. Firebase Emulator Suite requires Java 21+

**What happened:** Cloud Build failed with `firebase-tools no longer supports Java version before 21` when attempting to start the Firestore Emulator.
**Root cause:** Recent versions of `firebase-tools` upgraded their underlying emulator binaries to require Java 21 or higher. Using older JDKs causes an immediate startup crash.
**Rule going forward:**
- When provisioning CI environments or Docker images for Firebase emulators, explicitly install `openjdk21-jre` (or higher), rather than relying on `default-jre` or older LTS versions. E.g., `apk add --no-cache openjdk21-jre`.

### 20. Global Backend Architecture changes require a full Test Suite audit

**What happened:** Several tests failed with `app.address is not a function`, `Value for argument "data" is not a valid Firestore document` and `401 Unauthorized`.
**Root cause:** The backend implementation was updated to export `{ app }` instead of `app`, enforce Tenant Isolation by expecting a `workspaceId` on both users and projects, and enforce `requireAuth('user')` on API routes. However, the test files were not updated in lockstep: they were still expecting the old `app` export, their mock users lacked `workspaceId` fields, and they were still sending `x-api-key` instead of valid mock Dev tokens.
**Rule going forward:**
- When introducing global or structural changes (tenant isolation, auth strategies, module exports), do not consider the work "done" until a full repo-wide search confirms no old patterns remain, and run the *entire* test suite locally. Mock data in `beforeAll` hooks must be meticulously updated to satisfy new database constraints.

### 21. `npm ci` strictly enforces OS-specific lockfiles, causing missing dependencies in Docker builds

**What happened:** A Cloud Build pipeline failed during `npm test` with `Missing: @emnapi/runtime@1.11.1 from lock file`. Later, after fixing the pipeline, the smoke test container crashed on boot with HTTP `000` (Connection Refused).
**Root cause:** The local developer machine (Windows) generated `package-lock.json` when installing `@google/genai`. This SDK has OS-specific native dependencies (like `@emnapi/runtime` for WebAssembly/C++). When the Docker build (using `node:20-alpine`) ran `npm ci`, it strictly enforced the Windows lockfile, completely skipping the download of the Alpine Linux binaries. When Node.js booted, it threw a `MODULE_NOT_FOUND` error for the missing binaries and crashed immediately.
**Rule going forward:**
- Use `npm install` instead of `npm ci` in cross-platform Dockerfiles (`alpine` / `debian`) if the `package-lock.json` is routinely generated on different host operating systems (like Windows). `npm install` gracefully evaluates the target OS and fetches the missing native binaries.

### 22. Cloud Build Smoke Tests must output Docker Logs before cleanup

**What happened:** A post-deployment smoke test hit the newly built container and instantly failed with HTTP `000` (Connection Refused). The build script simply logged `FAIL` and deleted the container.
**Root cause:** The container was crashing on boot due to a missing native dependency (Lesson 21), but because the smoke test script ran `docker rm` immediately after curl failed, all error logs were destroyed. There was zero observability into *why* the container failed to boot.
**Rule going forward:**
- In any shell script that runs a temporary Docker container for testing, always add a `docker logs <container-name>` output step in the failure branch *before* stopping and removing the container.

### 23. Concurrent Jest tests cause race conditions if they share Firestore document IDs

**What happened:** `admin.users.test.js` unexpectedly started failing with `401 Unauthorized` on its `DELETE` request, despite identical headers working perfectly on the preceding `POST` request.
**Root cause:** `admin.users.test.js` and `admin.projects.test.js` both hardcoded the exact same mock user (`test-admin-id` / `admin@test.com`) in their `beforeAll` hooks. Because Jest runs test files concurrently in separate processes that share the same Firestore Emulator instance, the `afterAll` hook of one test file deleted the shared admin user out from under the other test file, causing intermittent `401` errors during authentication.
**Rule going forward:**
- Always scope mock document IDs to the specific test file (e.g., `test-admin-id-users` and `test-admin-id-projects`). Never use generic shared IDs like `user-1` across multiple test files when running against a shared emulator database.

### 24. Cloud Build nested Docker containers are isolated from localhost

**What happened:** A local smoke test script in Cloud Build ran `docker run -d -p 8080:8080 "$IMAGE_URL"` and then attempted to `curl http://localhost:8080`. The curl command failed immediately with `HTTP 000` (Connection Refused), even though the Docker logs showed the server booting perfectly.
**Root cause:** Cloud Build steps run in their own Docker container attached to a custom bridge network (`cloudbuild`). When the step container spawns a *nested* container mapping port 8080, that port is exposed to the underlying VM host, NOT the step container's `localhost`.
**Rule going forward:**
- When running temporary Docker containers for testing within Cloud Build, attach them to the native Cloud Build network instead of mapping host ports: `docker run -d --name my-app --network cloudbuild "$IMAGE_URL"`. Then, ping the container by its name: `curl http://my-app:8080`.

### 25. Domain Restricted Sharing blocks public Cloud Run deployments

**What happened:** A final pipeline smoke test attempted to ping the newly deployed `thehammer-portal` and received a `403 Forbidden` error. The deployment logs showed: `Setting IAM policy failed, try "gcloud beta run services add-iam-policy-binding ... --member=allUsers"`.
**Root cause:** The Google Cloud Organization has "Domain Restricted Sharing" enforced by default, which categorically prevents any IAM bindings to `allUsers`. Consequently, new Cloud Run services default to Private, rejecting all unauthenticated requests.
**Rule going forward:**
- When smoke-testing Cloud Run services in a CI pipeline under DRS, you cannot rely on public access. You must pass an Identity Token in the `Authorization` header.
- To generate an Identity Token for a custom CI/CD service account, you must grant the SA the `roles/iam.serviceAccountTokenCreator` role on itself, and use `gcloud` to explicitly impersonate it (see Lesson 27):
  ```bash
  TOKEN=$(gcloud auth print-identity-token --impersonate-service-account="$SA_EMAIL" --audiences="$CLOUD_RUN_URL" --include-email)
  ```

### 26. Custom CI/CD Service Accounts cannot grant themselves IAM roles mid-build

**What happened:** Even after configuring the smoke test to use a valid Identity Token (Lesson 25), Cloud Run rejected the request with a `401 Unauthorized` error because the deployment SA lacked `roles/run.invoker`. We attempted to fix this by adding `gcloud run services add-iam-policy-binding ... --role="roles/run.invoker"` to the build script, but it crashed with `PERMISSION_DENIED: Permission 'run.services.setIamPolicy' denied`.
**Root cause:** When using a custom, least-privilege Service Account for CI/CD (e.g., `hammer-cicd-sa`), it has enough permission to deploy Cloud Run revisions (`roles/run.developer`), but it explicitly lacks IAM modification permissions. Therefore, the pipeline cannot dynamically grant itself the `run.invoker` role to ping the private service.
**Rule going forward:**
- If a CI/CD pipeline needs to run smoke tests against private Cloud Run services, do not attempt to manipulate IAM policies inside the pipeline.
- Instead, grant the `roles/run.invoker` role to the CI/CD Service Account permanently at the **project level**. This authorizes the pipeline to generate Identity Tokens that Cloud Run will accept for *any* service deployed in that project:
  ```bash
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:your-cicd-sa@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/run.invoker"
  ```

### 27. The Cloud Build Metadata Server ignores custom CI/CD service accounts

**What happened:** Even after granting `roles/run.invoker` to the custom CI/CD service account (Lesson 26), smoke tests were still failing with `401 Unauthorized` when generating Identity Tokens using `curl` against the metadata server.
**Root cause:** Cloud Build containers run on worker VMs. When you use `curl` against the VM's metadata server (`http://metadata.google.internal/...`), it ignores the custom identity configured in `gcloud` inside the container. Instead, it generates the Identity Token for the underlying VM's *default* Cloud Build service account. Since `run.invoker` was granted to the custom CI/CD SA and *not* the VM's default SA, Cloud Run rejected the token.
**Rule going forward:**
- **Never** use `curl` against the metadata server to generate identity tokens in a CI/CD pipeline if you are using a custom service account.
- Instead, grant the custom service account the `roles/iam.serviceAccountTokenCreator` role globally, and explicitly command `gcloud` to impersonate it:
  TOKEN=$(gcloud auth print-identity-token \
    --impersonate-service-account="$SA_EMAIL" \
    --audiences="$URL" --include-email)

### 28. Frontend Authentication Pages Cannot Reside on the Backend API URL

**What happened:** When building the Chrome extension's OAuth login flow, the sign-in URL was derived by simply appending `/auth-ext.html` to the `cloudRunUrl` setting (which points to the backend API, `https://thehammer-backend-.../api`). Users who clicked "Sign In" were met with a silent failure and an invisible 404 error because the backend does not serve frontend HTML pages.
**Root cause:** The extension conflated the *Backend API URL* (where it sends data) with the *Portal URL* (where the frontend authentication UI is hosted). The `auth-ext.html` file lives in the Portal, not the Backend.
**Rule going forward:**
- Explicitly separate `BACKEND_API_URL` and `PORTAL_URL` constants in any architecture where the frontend and backend are deployed as distinct services. 
- Never attempt to derive an HTML auth flow URL from a REST API URL.
