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

### 29. Dynamic Glassmorphism and CSS Custom Properties

**What happened:** When upgrading the Admin Portal to a premium glassmorphism aesthetic, we initially attempted to use `rgba(22, 22, 22, 0.7)` for the `.topbar` and `.sidebar` backgrounds. However, this hardcoded RGBA value broke the UI when switching between Light and Dark themes, as it forced a dark, semi-transparent background on a light surface.
**Root cause:** Hardcoded transparency values do not respect dynamic theme tokens (CSS Custom Properties like `--color-surface`). Attempting to manually declare `rgba` variants for every theme token causes CSS bloat and maintenance overhead.
**Rule going forward:**
- Use the modern `color-mix()` CSS function to derive translucent variations directly from existing CSS variables.
- Example for applying glassmorphism that automatically adapts to both Light and Dark themes:
  ```css
  .glass-panel {
    background: color-mix(in srgb, var(--color-surface) 80%, transparent);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
  }
  ```

### 30. Internal Worker Endpoints Must Be Authenticated

**What happened:** During the SRE audit, `/worker/reports` and `/worker/ocr` (which trigger Vertex AI inference) were found to have zero authentication — only a rate limiter. Any caller who knew the Cloud Run URL could trigger unbounded AI spend.
**Root cause:** Worker endpoints were added quickly as internal fire-and-forget triggers. The assumption was "nobody knows the URL," which is security by obscurity, not a real control.
**Rule going forward:**
- All internal trigger endpoints must use `requireAdmin` middleware, even if they are intended to be called only by other internal services.
- For service-to-service calls (e.g., a Cloud Task calling the worker), use a shared internal secret header verified against Secret Manager, or use Google-signed OIDC tokens.

---

### 31. Never Include `localhost` Unconditionally in a Production CORS Allowlist

**What happened:** `http://localhost:3000` was hardcoded in the `ALLOWED_ORIGINS` array in `backend/src/index.js` without any environment gate. In production, this would allow any attacker running a local dev server to issue credentialed cross-origin requests to the live API.
**Root cause:** The origin was added during initial local development and never guarded before going to production.
**Rule going forward:**
- Always gate local dev origins behind `process.env.NODE_ENV !== 'production'`:
  ```javascript
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
  ```
- Treat the CORS allowlist as a security boundary, not a convenience list.

---

### 32. SSRF Risk in Server-Side Webhook Dispatch

**What happened:** The `dispatchWebhook()` function read a `webhookUrl` from a Firestore project document and passed it directly to `fetch()`. An admin could set this to `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token` to steal the service account's access token via SSRF.
**Root cause:** Admin-controlled string input was used directly as a network target without validation.
**Rule going forward:**
- Any URL used in a server-side `fetch()` that originates from user/admin input must be validated before use.
- Block private IP ranges (RFC 1918), loopback, link-local, and named metadata endpoints:
  ```javascript
  const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|127\.|169\.254\.|::1$|fc00:|fd)/;
  if (parsed.protocol !== 'https:' || PRIVATE_IP_RE.test(parsed.hostname)) {
    // reject
  }
  ```

---

### 33. Plaintext Console Logs Are Invisible to Cloud Logging Alerts

**What happened:** We used standard `console.log` and `console.error` everywhere in the Node.js backend. In GCP Cloud Logging, these showed up as generic text logs, making it impossible to set up log-based metrics or alerts based on `severity` (e.g. triggering an alert for `ERROR` but ignoring `INFO`).
**Root cause:** Node's default console functions output strings to stdout/stderr. Cloud Logging expects structured JSON payloads to correctly map fields like `severity`, `jsonPayload.message`, and timestamps.
**Rule going forward:**
- Never use raw `console.log()` in the backend.
- Always use a structured JSON logger (e.g., `logger.info()`, `logger.error()`) that writes stringified JSON objects to stdout/stderr so the Google Cloud Logging agent can automatically parse and index them.

---

### 34. Chrome Extensions Cannot Use External Font CDNs

**What happened:** The Chrome Extension popup loaded the Inter font from `https://fonts.googleapis.com`. This violates strict Content Security Policies (CSP) often required for extensions, and it leaks the user's IP and timing data to Google every time they open the popup.
**Root cause:** Copy-pasting standard web development practices (using CDNs) into a Chrome Extension environment.
**Rule going forward:**
- Extensions must be fully self-contained.
- Download all required web fonts (`.woff2`) and store them in the extension's local `fonts/` directory.
- Reference them via standard `@font-face` blocks pointing to local relative paths.

---

### 35. Circular Imports in Express Route Configurations

**What happened:** In the main API server entrypoint `index.js`, we defined and exported `analystReportLimiter`. However, we imported `backend/src/routes/admin/reports.js` before exporting this limiter. Because `reports.js` required `index.js` to access `analystReportLimiter`, Node.js's circular dependency mechanism resolved the required object as empty `{}`, leading to a runtime crash when the route tried to reference the limiter.
**Root cause:** Requiring modules that import properties from the requiring file before those properties are defined and exported.
**Rule going forward:**
- Reusable middleware (including authentication, validation, and rate limiters) must be declared in separate, dedicated files inside a `middleware/` folder rather than exported from the main entrypoint file.
- Keep the entrypoint (`index.js`) exclusively as a bootstrap/wire-up layer.

---

### 36. Webhook and Log Payload references must be updated in tandem with Request Schema changes

**What happened:** We refactored `POST /upload-url` to remove the client-provided `name` body property (resolving user identity server-side using the Firebase token as `req.hammerUser.id`). However, the Slack webhook integration block later in the same route handler still referenced the deleted `name` variable, throwing a `ReferenceError` that crashed the upload pipeline at runtime.
**Root cause:** Modifying request input structures without auditing all references to those variables later in the execution flow (e.g. notifications, logging, webhook builders).
**Rule going forward:**
- When deprecating, renaming, or removing body properties, perform a full file-level (or repository-level) search for the deleted parameter variables.
- Update downstream dependencies (such as logs, Slack webhooks, database objects) to use server-resolved fallback values (e.g., `req.hammerUser.displayName || req.hammerUser.email || req.hammerUser.id`).

---

### 37. PowerShell curl alias maps to Invoke-WebRequest and hangs non-interactive background tasks

**What happened:** When verifying the API server's health status via a background `run_command` task in PowerShell, the command `curl http://127.0.0.1:8081/health` hung indefinitely, failing to return output until the task was manually terminated.
**Root cause:** In Windows PowerShell, `curl` is a default alias for the `Invoke-WebRequest` cmdlet rather than the native system `curl.exe`. `Invoke-WebRequest` attempts to establish progress streams and wraps response text in rich HTML/JSON objects, which can block or hang execution when run inside non-interactive background shells expecting raw text.
**Rule going forward:**
- Always call `curl.exe` explicitly rather than `curl` when running network tests or checks in PowerShell scripts or background commands on Windows, ensuring the native utility is executed and raw text is returned.

---

### 38. Git hooks on Windows run in Git Bash and require explicit path/shell configurations for PowerShell execution

**What happened:** When setting up the local pre-commit hook using `scripts/install-git-hook.ps1`, the hook script written to `.git/hooks/pre-commit` failed to invoke the powershell scripts correctly because Windows Git executes hooks inside a Git Bash/MinGW environment.
**Root cause:** Git on Windows automatically uses a bash shell environment to interpret hook scripts. Calling powershell command lines from a bash script requires invoking `powershell.exe` explicitly, bypassing execution policies (`-ExecutionPolicy Bypass`), and handling path translations correctly between Unix/Windows styles.
**Rule going forward:**
- When scripting hooks that call PowerShell from Git Bash on Windows, format the call explicitly: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts/verify-gcp-env.ps1"`.
- Use relative paths from the repository root when running files from git hooks, as Git runs hooks from the workspace root.

---

### 39. Validate OCI base image digests are exactly 64 hexadecimal characters long

**What happened:** A Cloud Build deployment failed on the portal build step due to an `invalid checksum digest length` error. The Dockerfile contained a 70-character hash (`2f2a1065645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10`).

**Root cause:** During copy-paste or a merge conflict resolution, a local 6-character short image ID prefix (`2f2a10`) was accidentally prepended to the actual 64-character SHA-256 hash (`65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10`). Because it visually looked like a long hash, it was committed without verifying its character length.

**Rule going forward:**
- Always verify that any SHA-256 base image digest in a Dockerfile is exactly 64 characters long (excluding the `sha256:` prefix).
- Test build images locally (e.g. run `docker build`) or dry-run pull the exact pinned tag+digest reference before pushing changes to the remote branch to catch checksum errors early.

---

### 40. Jest's default 5s hook budget is too tight for emulator-backed setup

**What happened:** On a clean machine `npm test` reported 38 of 45 tests passing. All seven failures were in `admin.users.test.js`, every one of them `Exceeded timeout of 5000 ms for a hook`. The suite looked like it had seven product defects. It had none — the same suite passed 7/7 in isolation once the timeout was raised.

**Root cause:** The suite had no Jest config file at all, so Jest's 5s default applied. `beforeAll` in the emulator-backed suites clears the whole emulator database over HTTP and then seeds fixtures, which comfortably exceeds 5s against a cold emulator. A warm emulator finishes inside 5s, so the failure only appears on the first run after a machine starts — which is exactly when a new developer meets it.

**Rule going forward:**
- Any suite whose hooks do network or emulator work needs an explicit `testTimeout`; do not rely on the Jest default.
- Treat a whole-suite failure that is entirely `Exceeded timeout ... for a hook` as a harness problem until proven otherwise, not as a product defect.
- Reproduce timing failures on a cold emulator. A green run proves nothing if a previous run left the emulator warm.

---

### 41. The Cloud Storage credential probe keeps Jest alive, and `--detectOpenHandles` cannot name it

**What happened:** After every test run, Jest printed `Jest did not exit one second after the test run has completed`. In CI this hangs the job until it times out. `--detectOpenHandles` reported no handles at all, and using that flag even made the warning disappear, because it changes teardown timing.

**Root cause:** `backend/src/index.js` constructs `new Storage()` at module scope. Requiring the app therefore builds an auth client, which resolves Application Default Credentials by probing the GCE metadata server. On a developer machine nothing answers that address, so the connection never settles. It is not a libuv handle Jest tracks, which is why `--detectOpenHandles` is blind to it; `process.getActiveResourcesInfo()` named it as `ConnectWrap` and `TCPSocketWrap`.

**Rule going forward:**
- When `--detectOpenHandles` reports nothing but Jest still will not exit, use `process.getActiveResourcesInfo()` in an `afterAll` instead, and bisect by running each suite alone.
- Set `METADATA_SERVER_DETECTION=none` for any offline suite so the credential probe never starts.
- Be aware this is a workaround for an import-time side effect: a module-scope client construction runs on every `require` of the app, including in tests that never touch it. Prefer lazy construction for clients that need credentials.

---

### 42. Replying early to a large upload resets the socket, and the client never sees the status

**What happened:** A new pre-multer guard on `POST /capture` correctly refused a 12MB upload with 413, and the test failed with `read ECONNRESET`. The server was right and the client still could not read the answer.

**Root cause:** Answering while the client is still uploading ends the response before the request body has been consumed. Node then tears down the socket, so the client sees a connection reset rather than the 413. For theHammer this is worse than a cosmetic problem: `AGENTS.md` Rule 4 makes a lost Capture non-negotiable, and the extension's retry logic would re-send an oversized Capture three times, never learning why it failed.

**Rule going forward:**
- When rejecting a request before its body is read, drain the remainder and answer on `end`. Draining discards bytes as they arrive; it does not buffer them, so the memory protection is unchanged.
- Cap the drain. `Content-Length` is attacker-controlled, so draining without a ceiling lets one request cost the server an arbitrary amount of reading. Past the budget, destroy the request and accept that the client loses its answer.
- Treat `ECONNRESET` in a test that asserts an error status as evidence about *when* the server replied, not as flakiness.
- multer 2.x drains for its own errors: it waits for the request before calling `next(err)`, with a source comment naming EPIPE as the reason. Two things this does **not** give you. It cannot cover a guard that runs *before* multer, which is why the pre-multer guard drains for itself. And multer own drain has no ceiling, so a rejected upload with no `Content-Length` is read in full before the client is answered — the guard's budget does not apply to it.

---

### 43. `Content-Length` measures the multipart envelope, not the file

**What happened:** A pre-multer size guard compared `Content-Length` against the 10MB file ceiling. A legitimate Capture at the ceiling was refused, because the request carries more than the file.

**Root cause:** `Content-Length` covers the whole multipart body: every part header, every boundary, and the other form fields, as well as the file. Comparing it against a per-file limit therefore refuses valid files near that limit.

**Rule going forward:**
- Give a header-based size guard an explicit envelope allowance above the per-file limit, and leave the parser's own per-file limit as the exact check.
- Accept what this leaves open, and write it down: a body between the file limit and the limit plus the allowance, and a chunked request carrying no `Content-Length` at all, both reach the parser. Neither can grow memory past the per-file limit, which is what the guard exists to protect.

---

### 44. A deletion is not proven by a test that was already passing

**What happened:** Issue #4 removed a retired API key surface. Two of the tests written to prove the removal passed *before* a single line was deleted, and would have been committed as evidence of work that had not happened yet.

**Root cause:** Both tests could be satisfied by something other than the deletion.

- `expect(() => require('../src/worker/keyRotationWorker')).toThrow({ code: 'MODULE_NOT_FOUND' })` was green while the file was still on disk. The worker's own `require('../../lib/firestore')` pointed at a path that does not exist, so loading it threw `MODULE_NOT_FOUND` for a reason that had nothing to do with the file being deleted. `require()` cannot distinguish "this module is gone" from "this module is present and broken".
- `expect((await db.collection('api_keys').get()).empty).toBe(true)` was green because that suite never seeds a key. The assertion held vacuously, and would have gone on holding no matter what the route wrote.

**Rule going forward:**
- To assert a module is gone, use `require.resolve`, which only consults the filesystem, never the module body.
- To assert a write no longer happens, seed the document the write would have touched and assert it is *unchanged*. An empty-collection assertion in a suite that seeds nothing proves nothing.
- Run every new test against the *un*changed code first and read which ones pass. A test that is green before the fix is either testing the wrong thing or testing nothing; a deletion ticket makes this easy to miss, because "the behaviour is absent" is also true of behaviour that was never exercised.
- Where a test is unavoidably green on arrival — a regression guard around code the change must not break — prove it can fail by mutating the code under test and watching it go red. The Firebase ID token test in `tests/auth.firebase-token.test.js` was verified this way.

---

### 45. Deleting a test can break the test after it

**What happened:** Issue #4 deleted the integration test asserting that role updates sync to `api_keys`. The next test in the file, which checks that an analyst may generate reports, then failed: its comment read `// Analyst (user is currently analyst)`.

**Root cause:** The deleted test had promoted the user to `analyst` as a side effect, and the following test read that role instead of establishing its own. The dependency was invisible in the passing suite and only surfaced when the earlier test was removed.

**Rule going forward:**
- Before deleting a test, check what state it leaves behind and grep the rest of the file for tests that consume it. A comment describing state the test never set is the tell.
- Fix such a test by giving it its own setup rather than by preserving the deleted one. Order-dependent tests pass in file order and fail under `--shuffle`, `.only`, or any future deletion.

---

### 46. Retiring an auth mechanism leaves incident-response procedures that fail silently

**What happened:** Issue #4 removed the last of the API key surface from the backend. `docs/runbook.md` §3, "Revoke Compromised API Key", still instructed the on-call operator to open the Firestore Console, find the `api_keys` collection, and set `isActive: false` on the user's keys — then tell the user to generate a new Personal API Key from the Admin Portal.

**Root cause:** The runbook was written against the old mechanism and nothing tied it to the code. Every step is individually plausible and the whole procedure is inert: the collection does not exist, so filtering it returns nothing, and an operator following the steps sees no error. Under a live credential compromise they would conclude the credential was revoked when nothing had been revoked at all. A stale comment misleads a reader; a stale runbook misleads an operator during an incident.

**Rule going forward:**
- When removing an authentication or authorisation mechanism, grep `docs/runbook.md` and any other operational procedure for it in the same PR. Code and tests are not the whole surface of an auth change.
- A procedure that silently does nothing is worse than one that errors. Prefer steps that fail loudly when their assumptions no longer hold.
- State revocation latency explicitly. `requireAuth` calls `verifyIdToken(token)` without `{ checkRevoked: true }`, so `revokeRefreshTokens(uid)` stops new tokens being minted but leaves an already-issued ID token accepted until it expires — up to an hour. A runbook that omits this implies an immediacy the system does not provide.

---

### 47. State that only one code path advances can be replaced without ever being written down

**What happened:** `sessionOnCapture()` in `extension/service-worker.js` started a new Session whenever the project changed, by overwriting `activeSession` in `chrome.storage.session`. The only function that writes a `session_events` document, `sessionFlush()`, was called from `onSuspend` and `windows.onRemoved` and from nowhere else. So every project switch destroyed a Session that had never been recorded, and the hour of work it represented never reached any report. Nothing failed, nothing logged, and the `uploads` documents were all written normally — the screenshots were there and only the time was missing.

**Root cause:** The Session was treated as a variable rather than as a record with a lifecycle. Writing the record was attached to two lifecycle events of the *worker*, while the state itself was mutated by a third path that was not one of them. The gap is invisible in review because both halves read correctly on their own.

**Rule going forward:**
- Where a piece of state stands for a record that must be persisted, every path that replaces or clears it must go through the same write. Enumerate the writers of the state, then check each one against the list of places that persist it; if the two lists differ, that difference is a defect.
- Be most suspicious where the loss is silent by construction. This one could not surface as an error because the losing path never intended to write anything.
- A test that captures against one project and then another, asserting *two* documents, is the cheapest guard and did not exist. `extension/tests/session.test.js` now holds it.

---

### 48. A ticket that paraphrases its source can quietly describe a different feature

**What happened:** Issue #11 was titled "Action icon states (ACT-01 to ACT-05)" and its body described an icon reflecting what the Session is doing. The Testing Plan, which is where `ACT-01` to `ACT-05` are actually defined, files them under "Priority 5 — the three-way action icon" and they cover screenshot mode, snip mode region select, snip on a restricted page, changing project mid-session, and the menu being open while a capture is queued. Only `ACT-04` had anything to do with Sessions. Acting on the ticket as written would have built a Session indicator and closed an issue whose other four cases — an entire unbuilt capture-mode feature — had not been touched.

**Root cause:** The ticket restated its source from memory instead of quoting it, and the source is a `.docx` in `deliverables\` that no grep over the repo will find. The identifiers `ACT-01` to `ACT-05` appear nowhere in the codebase, so the paraphrase had nothing to contradict it.

**Rule going forward:**
- When a ticket cites test-case identifiers, open the document that defines them and quote the rows into the ticket before working on it. Identifiers are not self-explanatory and a plausible expansion of one is worth nothing.
- Treat a `Done when` that cannot be traced back to its source as unstarted work. AGENTS.md rule 1 makes the condition absolute; that is only meaningful if the condition is the real one.

### 49. A silent fallback turns a wrong URL into no symptom at all

**What happened:** Both hard-coded API base URLs in the extension ended in `/api`, and the backend serves every route the extension calls at the root. `/api/config`, `/api/me/projects`, `/api/upload-url` and `/api/session-events` are all 404. On a fresh install nothing works: projects do not load, screenshots exhaust their retries into the offline queue, and `session_events` are never written. Nobody noticed, for two reasons. `loadConfig()` catches its own failure and falls back to cached settings by design, so the only trace is a `console.warn` in a popup nobody has open. And a profile that already held a good cached `cloudRunUrl` kept working, so the developer machines were the least likely to see it.

**Root cause:** The constant was never exercised by anything. No test named it, and the only code path that reads it on a healthy machine is the one that never runs, because storage already has a value. A fallback that is only reached in a state nobody is in is a fallback nobody has tested.

**Rule going forward:**
- Assert the shape of an outbound URL in a test, not just that a request was made. `extension/tests/api-base.test.js` pins the path so the prefix cannot come back from the constant or from a cached settings value.
- When a `catch` exists to keep a feature working offline, make sure it cannot also hide a permanently broken configuration. "Falls back to cache" and "has never once succeeded" look identical from the outside.
- A cached value that fixes itself is not fixed. Changing the constant alone would have left every existing profile 404ing, because storage wins over the constant.

### 50. A stub missing one global turns a success path into a silent failure path

**What happened:** The service worker drains its offline queue at load, inside a top-level IIFE. The first `ACT-05` test seeded two queued captures, ran a snip, and asserted the queue was untouched — it came back empty, and the two captures had moved to `failed`. Nothing had gone wrong with the snip. The drain had run, and every item in it had thrown `ReferenceError: atob is not defined`, because `extension/tests/sw-harness.js` builds its own `vm` sandbox and `atob` was not among the globals it provided. The worker's own `try/catch` treated that as an upload failure and gave up on both captures, exactly as it would for a dead network.

**Root cause:** Two things compounding. The sandbox is an allow-list of globals, so anything not listed is missing rather than wrong, and the missing thing only surfaces on a path the earlier tests never took. The worker then catches every error from that path identically, so an environment defect and a real upload failure are indistinguishable from the outside.

**Rule going forward:**
- When adding a test that reaches a new code path in the sandboxed worker, check the path's globals against the harness before trusting a failing assertion. A capture pipeline reaches for `atob`, `Blob`, `FormData`, `AbortController` and `XMLHttpRequest`, and none of them are in a bare `vm` context.
- Do not write "state is unchanged" assertions against a module that does work at import time. Assert what the work should have achieved — here, that every queued capture was uploaded and none were given up on — which is what `ACT-05` was asking anyway.

### 51. A double-quoted shell string runs the backticks in your markdown

**What happened:** A comment explaining the `/api` prefix was posted to the Customer's pull request with `gh pr comment --body "…"`. The body was markdown and contained `` `/api` `` in code spans. The shell expanded the backticks as command substitution before `gh` ever saw the string, so `/api` was executed as a command, produced nothing, and the text was posted with the phrase silently absent. The comment read as a confident explanation with the subject of the sentence missing. It was published to the Customer's repository in that state and had to be repaired afterwards with a `PATCH` on the comment.

**Root cause:** Markdown's inline-code delimiter and `sh`'s command-substitution delimiter are the same character, and the failure is silent in both directions. The shell does not warn that it ran something; `gh` cannot know a word was removed before it arrived; and command substitution deletes the text rather than mangling it, so the result is still valid prose. Nothing between the keystroke and the Customer's inbox had any reason to object. Writing a body that happens to contain no backticks — which is most of them — makes the trap invisible until the one message that does.

**Rule going forward:**
- Never pass markdown to `gh` through a double-quoted string. Use a quoted heredoc, `--body-file - <<'EOF'`, so the shell performs no expansion at all, or write a real file and pass `--body-file`. The quotes around `EOF` are the part that matters.
- This applies to every argument carrying prose, not just `--body`: `--title`, `--notes`, `gh issue create`, `gh release create`. Backticks, `$`, `!` and `\` are all live inside double quotes.
- Read back anything published outside this repository. `gh pr view --comments` costs one command, and the Customer's repository is the worst place to discover a formatting habit.

### 52. The backend's envelope is not the shape the caller destructures

**What happened:** `GET /me/projects` answers `{ projects, total }` and names each project's id `id`. The popup's `populateProjectSelect` is documented as taking an array of `{ projectId, name }`, and `loadProjects` handed it the envelope. `projects.forEach` threw inside `loadProjects`' own `try`, whose `catch` set the dropdown to "Could not load projects" and logged `GET /me/projects failed`. The request had returned **200**. Every capture failed too, because `service-worker.js` refuses to capture without `session.projectId` and the dropdown it is chosen from never populated. Two sessions went into the sign-in bridge instead, because all three visible symptoms pointed at auth.

**Root cause:** Nothing pinned the contract on either side — no backend test names `/me/projects` at all, and the extension had no test that decoded a real response body. The mismatch survived review because both halves read correctly alone: the route returns a sensible envelope, the renderer takes a sensible array. Only the join is wrong, and no artefact in the repo describes the join. The error message then actively misdirected — "GET /me/projects failed" for a request that succeeded.

**Rule going forward:**
- Assert against a literal copy of the body the server actually sends, not a hand-written fixture of what you assume it sends. `extension/tests/projects-dropdown.test.js` builds its input with `backendProjects()`, mirroring `backend/src/routes/admin/me.js`.
- Decode once, at the boundary. `normaliseProjects()` is the single place the wire format is converted, so the renderer keeps a contract worth testing against.
- Refuse a body in an unrecognised shape. Coercing it to `[]` renders "no projects assigned" and hides the fault as a normal outcome.
- A `catch` wrapping both the fetch and the render cannot tell a network failure from a decode failure. Name the causes apart in the message. This is lesson 49 a second time, one layer up: 49 was the request path, 52 is the response shape.

### 53. A `vm` sandbox is a separate realm, so `instanceof` and `deepStrictEqual` lie

**What happened:** `extension/tests/popup-harness.js` runs `popup.js` inside a `vm` context, as `sw-harness.js` does for the service worker. Two assertions failed against correct code. `assert.deepStrictEqual(popup.normaliseProjects(null), [])` reported *"Values have same structure but are not reference-equal"* — comparing `[]` with `[]`. Later, `assert.throws(fn, (e) => e instanceof Error && ...)` rejected an error that had genuinely been thrown, printing that very error in the failure output.

**Root cause:** Every value the sandboxed code constructs carries the sandbox's prototypes, not the test's. `deepStrictEqual` compares prototypes and `instanceof` walks the test realm's chain, so both read a structurally identical cross-realm value as a mismatch. The failure output is the trap: it prints the value, the value looks right, and the natural next move is to doubt the code that is actually correct.

**Rule going forward:**
- Never assert `instanceof` on a value that crossed the `vm` boundary. Check what you actually care about — `e.message`, or `Array.isArray(x)`.
- Map sandbox values into the test realm before `deepStrictEqual`: `out.map((x) => x.name)` builds a test-realm array, `out` does not. Asserting on `.length` also works.
- This applies to every return value from `sw-harness.js` and `popup-harness.js`, not just the two that bit here.

### 54. Storing a refresh token is not the same as spending one

**What happened:** A Firebase ID token is valid for one hour. The portal captured one inside `onAuthStateChanged` into a module-level `let idToken` and reused that string for the life of the page; the extension wrote one into `chrome.storage.local` at sign-in and read it back on every call thereafter. Both worked perfectly for an hour and then failed completely. The portal's New Project dialog returned 401 `unauthenticated: invalid token` with no hint that a page reload would fix it. The extension's dropdown emptied and every capture stopped. The extension had been storing `firebaseRefreshToken` and `firebaseApiKey` at every sign-in since the flow was written — the exact two values needed to renew — and nothing in `extension/` had ever read either of them.

**Root cause:** The sign-in flow was built and tested in the minutes after signing in, which is the one window in which the bug cannot appear. Nothing in the codebase said "this value expires", and the shape of the code actively suggested otherwise: a token stored in `settings` next to `cloudRunUrl` and `notify` reads as configuration, and configuration does not go stale. Storing the refresh token made it look handled. It was the *appearance* of a renewal mechanism with none of the substance, which is worse than not storing it at all — a missing value would have prompted the question.

**Rule going forward:**
- Any credential with a lifetime needs a named thing that renews it, and a test that proves the renewal happens. `extension/tests/token-refresh.test.js` drives a 401 through `authedFetch` and asserts the retry carries the new token; `portal/tests/token-freshness.test.js` asserts `apiFetch` reads the token per call rather than once.
- Trigger the renewal on the **401 the server actually sends**, not on a clock you keep yourself. It costs one wasted request, needs no assumption about expiry, and catches a token revoked early as well as one aged out.
- Refresh once, then stop. A second 401 after a successful renewal is an authorisation problem, and retrying it turns a clear error into a loop.
- Test anything auth-shaped at a point in time it was not written at. Every bug in this class is invisible for the first hour.

### 55. A lesson only covers the code you actually audited

**What happened:** Lesson 52 was written after `GET /me/projects` answered `{ projects, total }` and the extension destructured it as an array. Within the same session, the admin portal failed the same way on `GET /admin/users`: `allUsers = await apiFetch(url)` assigned `{ users, total, nextCursor }`, `updateUserStats` called `.filter()` on it, and the resulting `TypeError` was caught by the caller and reported to the user as **"Failed to load users. Check API connectivity."** on an HTTP **200**. `activityFeed` had it too. `reports` did not, having been written to read `data.reports`. So the same defect existed in three of four places, and the lesson written hours earlier prevented none of them.

**Root cause:** The lesson was filed against the code that produced it. Nothing carried it across the boundary to the other consumer of the same API, and the two live in different directories with different test setups, so neither the fix nor its test had any reason to touch the portal. The defect is a property of the *contract* — a paginated envelope every caller must unwrap — but it was recorded as a property of one caller.

**Rule going forward:**
- When a bug turns out to be about a shared contract, grep for every consumer of that contract before closing it. `grep -n "await apiFetch" portal/app.js` against the backend's `res.json({` sites would have found both remaining cases in a minute.
- Fix it in one named place per codebase and route every call site through it, so a new call site has an obvious right way to be written. `normaliseProjects()` in the extension and `unwrapList()` in the portal are the same fix on both sides of the same boundary.
- A `catch` that reports a transport problem for a decode failure will send the next reader to check the network. Distinguish them, or the error message becomes the thing that costs the time.

### 56. A Firestore query with no index works perfectly until there is data

**What happened:** `GET /admin/projects` returned 500 the moment the Workspace contained its first Project: `9 FAILED_PRECONDITION: The query requires an index`. The query — `where('workspaceId','==',x).orderBy('createdAt','desc')` — had never had a composite index, and `firestore.indexes.json` had never listed one. It had been shipped, reviewed and deployed, and every environment it ran in had been empty, so it had never once failed. Auditing the rest found four of eight index-requiring queries with no index and a fifth with the wrong sort direction. The repo also carried two index files: `firebase.json` deploys the root one, and `infra/firestore.indexes.json` was deployed by nothing and had already drifted, defining a `reports` index on `generatedAt` when the code orders by `createdAt`.

**Root cause:** The failure mode is invisible in exactly the conditions under which features get built. A fresh Firestore has no documents, an empty result needs no index, and the endpoint returns 200 with `[]`. The index requirement only appears in front of a user with real data — which, on this project, meant the first person to create a Project. Nothing in the code says a query needs an index, so nothing in review prompts the question, and the index file sits far enough from the routes that changing one never suggests changing the other.

**Rule going forward:**
- Every `.where(...).orderBy(...)` needs an entry in `firestore.indexes.json`. `npm run test:indexes` now reads the queries out of `backend/src/routes` and fails when one has no match, so this cannot be shipped again by not noticing.
- Seed data before believing an endpoint works. An empty collection exercises none of the query planner.
- Adding an index is additive and cannot break an existing query, so when an audit is uncertain, add it. **Removing** one is the dangerous direction: `firebase deploy --only firestore:indexes` deletes any index not in the file, so an entry that looks unused may be serving something the audit missed.
- Keep exactly one copy of any config a deploy consumes. Two files that disagree guarantee the inert one eventually gets the careful edit.

### 57. Refreshing once is only half the fix: the caller still has to say which failure it was

**What happened:** #39 gave the extension a working token renewal. `authedFetch` spends the refresh token on a 401, retries once, and hands the original 401 back when the renewal fails — correct in isolation, and tested. But nothing downstream could tell that 401 apart from a dead network. `withRetry` caught it like any other error and retried three more times over seven seconds of backoff, and the capture path then reported **"No connection — will retry when online."** to someone whose session had simply expired. The ticket's third `Done when` said a 401 surviving one refresh must report that sign-in is required rather than retrying or reporting a generic failure; the first two thirds shipped and the last third did not.

**Root cause:** The renewal was designed as a self-contained concern — one function, one file, its own tests — and it succeeded at being that. What it could not do alone was change what its callers *say*. The error crossing that boundary was a bare `Error` carrying a formatted message and nothing a caller could branch on, so every caller treated all failures identically, which they had always done. Fixing the mechanism did not fix the message, and the message is the whole of what the user experiences.

**Rule going forward:**
- An error that crosses a module boundary must carry something machine-readable — here `err.status` — not just a human sentence. A caller that has to regex a message will not bother, and will report the wrong cause.
- Retry logic must be told which failures are worth retrying. A blanket `catch` retries the fatal ones too, and the wasted attempts always end on a message about the transport.
- When a ticket's `Done when` has a clause about *what the user is told*, that clause needs its own test. `extension/tests/auth-expiry.test.js` asserts the expired-session notice does **not** mention the connection.
- This is lessons 52 and 55 a third time: one message standing in for two different causes is what costs the next person the afternoon.

### 58. Writing the rule in the same commit is not the same as applying it

**What happened:** The commit that fixed #41 added lesson 55, whose third rule reads: *"A `catch` that reports a transport problem for a decode failure will send the next reader to check the network. Distinguish them, or the error message becomes the thing that costs the time."* That same commit left `Failed to load users. Check API connectivity.` hardcoded in the users table and the activity table, and `Failed to load — check API connectivity` in the projects table. `unwrapList` threw a precise decode error and all three call sites threw it away. The review that caught it found the same defect independently on both of its axes, which is how obvious it was from outside.

**Root cause:** The lesson was written at the end of the work, as a summary of what had been understood, and understanding it felt like discharging it. Nothing tied the sentence to the code it described: the rule named a shape (`catch` conflating two causes) rather than a location, and no test asserted it, so the file could be committed with the rule and the violation touching each other in the same diff.

**Rule going forward:**
- When you add a rule to this file, grep the diff you are about to commit for the thing the rule forbids, before you commit it. The commit that names a defect is the most likely place to still contain it.
- Prefer a rule that a test can hold down. `portal/tests/list-envelopes.test.js` now asserts the string "Check API connectivity" survives in exactly one place, and that every error row asks `listFailureMessage()` for its text. That is enforceable in a way the prose was not.
- Errors that cross a boundary carry a flag, not a sentence: `err.isDecodeFailure` in the portal, `err.status` in the extension (lesson 57). A caller that has to read English to decide what happened will guess.

### 59. Clearing an inline style is not the same as making something visible

**What happened:** The extension popup's History tab showed a blank panel. `switchTab` revealed a panel with `historyPanel.style.display = isCapture ? 'none' : ''`, and `popup.html` carried `#history-panel { display: none; }`. Assigning `''` removes the inline declaration rather than setting a value, so the element fell back to the stylesheet and stayed hidden. Clicking History hid the capture controls and revealed nothing — not even `refreshHistory()`'s "No uploads yet." empty state, because the element holding that message was inside the hidden panel. Three captures had uploaded successfully and were confirmed in Firestore while the tab that exists to show them had never worked.

**Root cause:** The same line worked for the sibling panel purely by accident: nothing in the stylesheet hides `#capture-panel`, so falling back to the cascade landed on `display: block`. Two panels written identically, one correct and one not, with the difference living in a CSS file the JavaScript never mentions. The absent empty state was the tell and was misread as "there is no history", which sent the investigation at the recording of captures rather than the display of them.

**Rule going forward:**
- Assign the value you mean. `style.display = 'block'` and `'none'`, never `''`. A toggle that needs to know what the stylesheet says in order to be correct will break the next time the stylesheet changes.
- When a panel renders nothing at all — not even its own empty state — suspect the container before the data. An empty list and a hidden list look identical from outside and have opposite causes.
- A stub DOM has no stylesheet, so `''` and `'block'` are indistinguishable in `popup-harness.js` unless the assertion names the expected value. `extension/tests/history-tab.test.js` asserts the explicit string and rejects `''` for exactly that reason. Where the real bug lives in the cascade, the test has to pin what the cascade never sees.

### 60. A test suite that cannot run looks exactly like a suite nobody has broken

**What happened:** The backend suite failed 66 of its 87 tests on this machine, and had been in that state long enough that nobody noticed. Neither cause was in the code under test. `initializeApp()` resolves a project id from the environment, and with no Application Default Credentials present it threw *"Unable to detect a Project Id"* on every request. Port 8080 — the Firestore emulator's default — was occupied by an unrelated local Node app, so any test that got past the first fault was talking to an ad server instead of a database. Meanwhile three consecutive handoffs quoted extension, portal and index counts as the project's health; backend was never in those numbers, and nobody noticed the omission because the totals looked healthy. #47 was then found by reading the route, not by a failing test — and the suite that should have caught it had been dark since before that route was written.

**Root cause:** A red suite nobody runs and a green suite are indistinguishable in a status report, because both produce silence. This failure lived in the harness rather than the product, so it tracked no feature, appeared in no diff, and never got worse — it sat still while every other signal stayed healthy. The two causes also masked each other: fixing the project id alone still left the tests addressing an ad server, whose replies were wrong in no obvious way, and the genuine error arrived buried under a wall of OpenTelemetry stack frames.

**Rule going forward:**
- Quote per-suite counts and name any suite you did not run. "backend 89, extension 52, portal 26, indexes 4" is a claim that can be checked; "all tests passing" is not falsifiable, and it hid this for weeks.
- A suite with an external dependency must fail with a sentence naming that dependency. Nothing starts the Firestore emulator for you, and without it the run dies inside an auth library's stack trace where the words "no emulator" appear nowhere.
- Never let two places hold the same address. `tests/helpers/fixtures.js` now derives both the emulator's host:port and its project id from the environment, so the app under test and the thing that wipes it cannot drift into different namespaces.
- Default ports belong to whatever else the machine happens to run. When a suite behaves as though the database holds the wrong contents, confirm what is actually answering before suspecting the data.

### 61. `undefined` does not stay undefined once it reaches the DOM

**What happened:** The backend serialises a Project's identity as `id`. `portal/app.js` read `p.projectId`, at sixteen separate sites. That property was undefined on every Project the portal had ever loaded, and had been since the portal was written — but nothing about the symptom pointed at it. `option.value = undefined` is not left empty: the DOM coerces it, so `select.value` reads back as the *string* `"undefined"`, which is truthy. It therefore walked straight past `if (!projectId) { ...show "Select a project"...; return; }`, a guard written for precisely this case, and the Activity tab requested `/admin/projects/undefined/activity` on open — unprompted, because the tab auto-selects the first project — and the backend correctly answered 404. Six of the sixteen sites had already been patched with `p.id || p.projectId` by people who hit the symptom in front of them. Those six worked, which is exactly why the other ten survived.

**Root cause:** One field with two names, and no boundary that settled which. Each defensive `p.id || p.projectId` repaired one call site and destroyed the evidence that anything was wrong, so nobody followed the cause back; the sixth fallback made the seventh look reasonable. The DOM's coercion supplied the cover: a fault that would have been loud as a literal `undefined` in the UI instead became a plausible 404 against a route that genuinely does not exist, which reads as a backend problem. The mismatch was recorded during the #41 review as "the Activity tab 404s" — the symptom — and stayed open as a symptom for two more issues.

**Rule going forward:**
- Settle a field's name once, where the response is decoded, and let exactly one name reach the rest of the file. `unwrapList` (lesson 52) does this for a list's *shape*; `normaliseProject` now does it for a Project's *identity*. A decoded record should carry one id field, not two.
- A fallback reading two names for one field is evidence of an unsettled contract, not a fix. Write it at the boundary or not at all — and when you find one, treat it as a report that the boundary is missing rather than as prior art to copy.
- Refuse a missing identity instead of rendering it. `"undefined"` in a URL is indistinguishable from a legitimate 404 at the other end, so the guard has to be at the point of decode, where the record is still an object and the fault is still local.
- Truthiness is not a null check once a value has been through the DOM. `value`, `dataset`, and `getAttribute` all hand back strings; `"undefined"`, `"null"`, `"NaN"` and `"0"` are all truthy. Guard on the shape you decoded, not on what the DOM gives back.
- Match the spelling already in the file. The repo says `normalise` (`normaliseApiBase`, `normaliseProjects`); this fix first shipped a `normalizeProject` thirty lines below a comment pointing at `normaliseProjects()` as "this same fix on the other side". Two spellings of one concept is how the next grep misses half the sites — which is the same failure as two names for one field, one level up.

### 62. A ticket that explains why a bug is invisible can be wrong about the compensation

**What happened:** #46 reported that `GET /admin/users` ignores the `projectId` query parameter the portal sends, and framed it as a performance and honesty problem: *"The filter appears to work only because the portal filters again on the client."* That second clause is false. `filterUsers()` in `portal/app.js` filters by search text and by role, and by nothing else; there is no client-side project filter anywhere in the file, and `grep -n "membership\|filterUsers" portal/app.js` finds no site that ever narrowed `allUsers` to a Project. Selecting a Project on the Users tab therefore listed every User in the Workspace, each with a "Remove from project" button naming a Project they were not members of. The ticket's prescribed cleanup — "drop the redundant client-side pass in `renderUsers`" — was work on code that does not exist, and the handoff carrying the ticket forward had costed the change on the assumption that it did.

**Root cause:** The ticket was written from the wire, not from the screen. The parameter was observed going out, the full list was observed coming back, and the screen was known to look plausible — from which a client-side filter was inferred rather than found. The inference was reasonable and wrong, and once written down it read as an observation, so the next two documents inherited it as fact. It also inverted the severity: a redundant client filter would have made this a bandwidth issue that no user could see, which is how it was prioritised, while the absence of one made it a wrong-data-on-screen bug. `renderUsers` reading `u.membership.admittedAt` — a field nothing in the portal ever populated — was standing evidence that the filtered path had never worked end to end, and it sat one line below the code the ticket quoted.

**Rule going forward:**
- Verify the compensating control, not just the defect. A ticket saying "this is harmless because X covers it" is making two claims, and X is the one nobody re-checks. Grep for X before you cost the work, because its absence usually raises the severity rather than lowering it.
- Cost a cleanup only after finding the code to clean. "Remove the now-redundant Y" is a scope estimate resting on Y's existence; here it was a third of the predicted blast radius and it was zero.
- A read of a field nothing writes is a dead path, and it names the feature that has never worked. `u.membership` was consumed in `renderUsers` and produced by no one — the same shape of tell as lesson 54's stored token that nothing spends, and worth grepping both directions when a filter looks implemented on one side only.
- Repeat the evidence, not the conclusion, when carrying a finding across documents. This claim survived from #41's body into #46 into a handoff without anyone re-reading `filterUsers`, because each copy looked like a citation of the last.

### 63. A comma-delimited flag cannot carry a comma-delimited value

**What happened:** `EXTENSION_ID` had to grow from one Chrome extension id to two, because `manifest.json` declares no `"key"` and each unpacked copy therefore has its own id. The obvious encoding — `EXTENSION_ID=id-a,id-b` — is silently wrong in `cloudbuild.yaml`. `gcloud run deploy --set-env-vars` separates `KEY=VALUE` pairs with commas, so it would have read `EXTENSION_ID=id-a` and then tried to parse `id-b` as a pair of its own. Production would have come back trusting one extension, with no error anywhere: the deploy succeeds, the service starts, and the only symptom is a CORS preflight returning no `access-control-allow-origin` to one developer. The fix was a space between the ids and a `split(/[\s,]+/)` that accepts either.

**Root cause:** Two layers claimed the same delimiter, and only one of them got to use it. Nothing in the toolchain reports the collision — `gcloud` cannot know that a value was meant to contain a comma, and the receiving code cannot know its input was truncated before it arrived. The same shape sits in every delimiter-joined flag: `--set-secrets`, `--update-labels`, and Cloud Build's own `--substitutions`.

**Rule going forward:**
- Before putting a list in an environment variable, check what delimiter the thing that *sets* it already uses, and pick a different one. `gcloud`'s `KEY=VALUE` flags own the comma; a space costs nothing and collides with nothing.
- Accept more separators than you emit. `split(/[\s,]+/)` with a `.filter(Boolean)` takes commas, spaces, padding and empty entries, so the next person writing the value by hand in the console cannot get it wrong.
- Assert the parse, not the string. A one-line script that splits the `--set-env-vars` argument the way `gcloud` will and prints the pairs it yields turns "looks right" into "is right", and costs one command.
- A config fault that deploys cleanly is worse than one that fails the build. This one would have surfaced as a broken capture loop on one machine — read as an extension bug, not a deploy bug, and debugged in the wrong repository.

### 64. A harness missing a real API fails a different way than the code it is testing

**What happened:** Writing the tests for #72's queued-upload refusal, every scenario that reached the offline queue path threw `ReferenceError: FileReader is not defined` — not from `capture()`, from `sw-harness.js`'s sandbox, which had never defined `FileReader`. Testing the popup's Capture Now button the same session hit an identical shape: `progressBar.setAttribute is not a function`, because `popup-harness.js`'s stub DOM element had no `setAttribute`. Neither gap was in the code under test. Both had been sitting there since before this session — nobody had written a test that reached `blobToBase64()` or clicked Capture Now with a scripted response, so nothing had ever exercised the missing method.

**Root cause:** This is lesson 60's failure mode at the level of one API rather than one suite: a stub environment that is *missing* something the real runtime has fails loud and immediate, with an error naming a completely unrelated identifier — never a clue that the fault is in the harness, not the fix. It is also the mirror of #70 (lesson 6 in this same file's numbering scheme, XMLHttpRequest): #70 was a harness *more* capable than production, which let broken code pass; this is a harness *less* capable than production, which cannot run good code at all. Both are silent about which one they are — the error just looks like the test is wrong.

**Rule going forward:**
- `FileReader` and `setAttribute` are both real in the environments they stand in for (Worker-scope File API; any DOM element) — the harness was incomplete, not the runtime overreaching. Check which direction a `ReferenceError` or `TypeError` from *inside a harness file* is pointing before assuming the fix is at fault.
- A code path nobody has ever driven a test through is exactly where a stub is most likely to be missing something, because nothing has needed it yet. The first test to reach `blobToBase64()` or a real click handler is also the first test that can discover the harness never supported doing so.
- Fix the harness gap in the harness, not around it in the test. A minimal polyfill (`HarnessFileReader` in `sw-harness.js`; a no-op `setAttribute`/`getAttribute` in `popup-harness.js`) benefits every future test that needs the same call, the way `putFails` and `captureVisibleTabResult` already do for their own sites.

### 65. A field's own name is the assertion nobody wrote

**What happened:** `queueAdd()` stored `blobToBase64(blob)` under a field named `blobBase64`. `blobToBase64` returned `FileReader.readAsDataURL()`'s result verbatim — a full data URL, `data:image/png;base64,iVBORw0KG...` — not base64. The drain loop then called `atob(item.blobBase64)` directly on it. `atob()` rejects the `data:image/png;base64,` prefix outright (`:`, `/`, `;` and `,` are not base64 characters), so every decode threw, on every item, unconditionally, and the item was moved into a `failed` array that nothing in the codebase ever reads back — no retry, no History entry, no UI surface. `queueAdd` has existed since Sprint 4; the offline queue had likely never successfully drained a single item in production. Found by hand, verifying #72's `queued` reason: two real queued items, reloaded to force a drain, both failed with the same decode error, live, in Chrome.

**Root cause:** The name was the whole bug. `blobBase64` is a claim about the value's shape, and nothing checked the claim — not a test, not a type, not the one line that would have caught it (`assert(!value.startsWith('data:'))`). This is lesson 7's family (`lastActiveAt`, `u.path`, `u.size`) one level lower: those were fields whose *meaning* outran the code; this is a field whose *encoding* did. `extension/tests/` had full coverage of #72's queueing path — an item reaching `queue` was asserted repeatedly — and zero coverage of draining it, so the one call that would fail was also the one call nothing ever made.

**Rule going forward:**
- When a field's name asserts a format (`Base64`, `URL`, `ISO`, `Id`), write the one-line test that the value actually has that format, at the point it's produced. It costs a `startsWith`/`match` and it is the cheapest possible regression guard against exactly this shape of bug.
- Reaching a queue, a cache, or a store is not the same as leaving it. A write-side test proves data goes in; only a read-side test proves it can come back out the way something else expects to consume it. Test the drain, not just the add.
- A `failed` (or `dead`, `skipped`, `errors`) array that nothing reads is a second silent grave next to the first. If a fallback path can itself fail, either surface that failure somewhere a person will see it, or don't build the fallback — a silently-failing safety net is worse than none, because it looks like coverage.

### 66. Fake data was hiding a missing authorization check

**What happened:** `reportsWorker.js` hardcoded its four metrics behind the comment `Mock data aggregation logic since full implementation requires detailed queries`. Separately, `POST /admin/reports/generate` accepted a `projectId` from the request body and never checked that the Project belonged to the caller's Workspace — the only project-scoped route in the backend without that check, which `projects.js`, `exports.js` and `storyboards.js` all make. The two faults were harmless *only in combination*: an Analyst in one Workspace could request a report for another Customer's Project, and got invented numbers back. Implementing #8's real aggregation without touching the route would have converted a dormant authorization gap into a live cross-Customer leak — real Capture counts, Monitored User counts and Session timings — in the very commit that "fixed" the reports. Found while reviewing the change, not while writing it. Also surfaced: `executive_summary`, the third report type in the portal's own dropdown, had no metrics object at all, so the prompt read `The metrics are: undefined` and the model improvised an executive narrative from the word "undefined".

**Root cause:** the fake data was acting as an accidental access control. Nobody had to decide who may read a Project's numbers, because there were no numbers. A missing check produces no symptom while the output is meaningless, so no test, no review and no incident ever pointed at it. The guard was absent for as long as it was unnecessary, and became necessary in a change whose ticket was about arithmetic.

**Rule going forward:**
- **When an output becomes real for the first time, re-ask who is allowed to see it.** Placeholder data suppresses the consequences of a missing authorization check; making it real is the moment those consequences land. Diff the route's guards against a sibling route that already serves real data, rather than assuming the endpoint was ever reviewed for it.
- **A comment admitting the code is mocked is an unfiled defect report.** `Mock data aggregation logic`, `MVP`, `for now`, `In a full implementation`, `in a real scenario` — all of these sat in shipped code through every review of those files. Grep for them; each one is a ticket nobody wrote. `ocrWorker.js` still carries several.
- **Check every branch a caller can actually reach, not just the ones the ticket names.** #8 named four hardcoded metrics. The report type with *no* metrics at all was worse, was reachable from the portal's own dropdown, and went unmentioned in the issue.

### 67. A guard that is added one call site at a time is absent everywhere nobody looked

**What happened:** #7 asked for twelve tests proving one Workspace cannot reach another's data. Four of the twelve were red on the first run, against code that had been shipped for months. `GET /admin/projects/:id/activity` returned another Customer's Capture rows, file names and 15-minute signed URLs to the images. `GET /admin/users/:id` and `PATCH /admin/users/:id` read and wrote any Monitored User in any Workspace, and `updates` on that PATCH carries `role`. `POST /admin/projects/:id/members` checked that the *Project* was the caller's and never that the *Monitored User* was. Two more disclosures fell out of the same file while fixing those: the unscoped roster listed every Customer's Monitored Users to any Admin, and `POST /admin/users` answered an email held in another Workspace with that user's whole record. None of this was new; the isolation check had simply been written at each call site as somebody noticed it — `projects.js`, `exports.js`, `storyboards.js`, `reports.js` (#94), and `index.js`'s four extension routes all have it, in five slightly different spellings — and the sites nobody noticed never got one.

**Root cause:** `requireAdmin` proves the caller is an Admin, not that they are an Admin *here*, and a route that reads `req.hammerUser` for the role while taking the record id from the URL looks complete at a glance. The suite could not tell the difference either: every one of the 45→233 tests authenticated inside the single Workspace its own fixtures created, so a route that checked ownership and a route that did not produced identical output for every test that existed. The guarantee the whole multi-Customer model rests on was the one thing nothing exercised, and the boundary is invisible until a test stands on the other side of it. `POST /admin/users` compounded it by writing users with no `workspaceId` at all — a record that belongs to no tenant cannot be scoped by any check, so the missing field and the missing checks each hid the other.

**Rule going forward:**
- **A tenancy check is a property of a route family, not of a route.** When you add one, grep the whole family for `req.params.id`, `req.query.*Id` and `req.body.*Id` and fix every sibling in the same change, or the next audit finds the ones you skipped. Six call sites of the same three lines is the smell, and lesson 66 named the same fault on `reports/generate` a ticket earlier.
- **Write the negative test in the fixture, not in the assertion.** These four holes were invisible to 233 passing tests because no fixture ever created a second Workspace. A suite whose data all sits on one side of a boundary cannot fail on that boundary, however many cases it has.
- **A missing scope field and a missing scope check are the same defect.** `POST /admin/users` never stamped `workspaceId`; every ownership check therefore had nothing to compare against for the users it created. When adding a scope check, confirm every writer of that collection sets the field it reads — and note that records written before it did are now unreachable and need a backfill.
- **Refuse a record that carries no tenant.** `workspaceId` absent has to read as "belongs to nobody", never as "belongs to whoever asked". The permissive reading turns every legacy row into a shared one, which is the hole rather than a migration convenience.

### 68. Nothing deploys Firestore indexes, and a deployed index is not yet a working one

**What happened:** #7 added two composite indexes on `users` (`workspaceId,email` and `workspaceId,role,email`) because the newly scoped `GET /admin/users` needs them. `npm run test:indexes` was green the whole time, and the ticket was reviewed, committed and closed on that basis. But `cloudbuild.yaml` has no Firestore index step at all — it runs the suite, builds the two images, deploys backend and portal to Cloud Run and smoke-tests `/health`, and never touches indexes. Pushing to the client remote would therefore have deployed a route that returns `FAILED_PRECONDITION` the moment any Workspace has users, with a green build and a passing index audit either side of it. Deploying them by hand with `firebase deploy --only firestore:indexes` printed `Deploy complete!` within seconds — and a probe issuing the actual query shape at that moment still got `FAILED_PRECONDITION` from both. They only began serving about fifteen seconds later.

**Root cause:** two gaps that look like one because they fail identically. `npm run test:indexes` audits `firestore.indexes.json` against the queries in the code; it says nothing about the live project, so it is equally green whether or not the index exists in production — the audit and the deployment share no fact. Separately, the CLI's success message reports that Firestore *accepted* the index definition, not that the index is *built*, and a `Building` index behaves in every observable way like an absent one: same error, same status code. So the two checks a reasonable person would make — the repo's own audit, and the deploy tool's own output — are both green at the exact moment the query is still broken.

**Rule going forward:**
- **An index never ships with a push.** Nothing in the pipeline creates one. A ticket that adds an index is not done at merge; it carries a manual `firebase deploy --only firestore:indexes --project <project>` and is only finished once that has run against the live project.
- **Verify an index with the query, not with the console or the CLI.** Issue the exact `where`/`orderBy` shape the route uses against production and check it returns instead of throwing. `Deploy complete!` and a green console row are both compatible with a broken route for the next few seconds to few minutes.
- **Diff live against the file before deploying, not after.** `firebase firestore:indexes` prints what is live; comparing it to `firestore.indexes.json` shows both what will be created and what the CLI may offer to *delete*. An index live but absent from the file triggers a deletion prompt, and answering it carelessly removes an index some other route depends on.
- **An audit that reads only the repo cannot report on production.** When a check's name suggests it covers deployment (`test:indexes` does), say in its output what it actually compares, or the next reader will trust it for something it never did.

### 69. A metric nobody could see was wrong, because the code that hid it was the code that produced it

**What happened:** the Dashboard's `pendingExports` tile counted the `exports` collection for Reports-style `queued`/`processing` rows. Nothing in the system has ever written that collection: `GET /admin/projects/:id/export` streams from `uploads` and returns, recording no job. Two references to the name existed in the whole backend — the entry in the collection map, and this read. So the tile had shown a hardcoded `0` since the day it shipped, and #98's audit only noticed because the collection was being examined for a *different* reason: whether it needed a `workspaceId`. It did not need one, because it does not exist.

**Root cause:** the query sat inside its own `try`/`catch` whose comment read "Collection might not exist or be used yet", swallowing every error and falling back to the `0` the variable was already initialised to. That is a fallback that cannot fail, wrapped around a query that cannot succeed, reporting a number that cannot be anything but zero — and the three facts hide each other. The catch means a wrong collection name, a missing index and an empty collection all render identically. And zero is the one value a count can take that looks like a healthy answer rather than a broken one: nobody files a bug because their export queue is empty. An Admin was being told a queue was clear by a system that had no queue.

**Rule going forward:**
- **A `catch` that produces a plausible value is a `catch` that deletes evidence.** If a query failing and a query returning nothing must be distinguishable — and for anything shown to a Customer as a fact, they must be — then the failure has to reach the response or the logs, not a default that reads as success.
- **A collection name in a constants map is not evidence the collection exists.** Before scoping, indexing or migrating a collection, grep for its *writers*. Zero writers means the feature was never built, and the fix is to delete the reader, not to scope it.
- **Check that a metric has ever been non-zero.** A tile that has only ever displayed `0` in production is indistinguishable from a tile that is not wired up, and it will survive every code review, because the code is correct — it is the premise that is missing.
- **Name the thing before counting it.** `CONTEXT.md` now separates Report (generated, queued, waited for) from Export (produced and returned by the request that asks for it). An Export has no status, so "pending Exports" was never a quantity. A glossary entry would have refused the tile before it was written.

### 70. An audit's blind spot is shaped like the thing it is auditing

**What happened:** #101 scoped two Dashboard counts to the caller's Workspace, which turned them into `where('workspaceId','==',X).where('memberCount','>',0)` — an equality plus an inequality, and a query Firestore refuses without a composite index. The ticket's own acceptance criterion said "the audit in `infra/tests/firestore-indexes.test.js` passes", and it did, immediately and without the indexes existing. The audit collects queries by looking for an `orderBy`; neither new query has one, so neither was ever in the set being checked. The criterion was satisfied by an empty intersection.

**Root cause:** the audit was written for #43, where every missing index was on an ordered query, and its collection step encoded that accident as its definition of "a query that needs an index". Both shapes fail identically at runtime — `FAILED_PRECONDITION`, only once the collection has rows — so nothing downstream distinguished them. And the emulator serves both shapes without any index at all, so the whole local suite is green either way. Three independent checks, all green, none of them looking at these two queries: the audit skipped them, the emulator does not need the index, and the build deploys no indexes (lesson 68).

**Rule going forward:**
- **Prove a check can fail before believing it passed.** The fix here was verified by deleting one index and watching the audit go red, then restoring it. A check that has never been observed failing is a check with no evidence behind it — the same argument as lesson 44, one level up: there, a test that passed before the fix; here, an audit that passes over the empty set.
- **When a ticket's acceptance criterion names an existing check, confirm the check can see the new work.** "The audit passes" is worth nothing if the audit's collection step filters the new case out. Read what it collects, not what it asserts.
- **Widen the check in the same change that reveals the gap.** The extension cost about thirty lines and is what makes #102 and #103's index criteria mean anything; deferring it would have left two more tickets with the same vacuous criterion.
- **An emulator that accepts every query is not evidence about indexes.** It has no opinion on them. Only the live project does, and only under the real query shape (lesson 68).

### 71. An auth check joined by "or" is only as strong as its weaker half

**What happened:** #104 found `POST /worker/reports` and `POST /worker/ocr` taking a `projectId` and a `reportId` from the request body and passing both to report generation with no ownership check. They looked exempt: they are internal worker endpoints, called by `reports/generate` with a shared secret, and internal callers legitimately have no Workspace to scope against. But `requireWorkerAuth` reads `secret matches` **or** `requireAdmin(...)`, so every one of them is also a normal authenticated Admin route — and on that path the caller does have a Workspace, and was never asked whether the ids named it. An Admin could pair another Customer's `projectId` with their own `reportId`, and #8's real metrics — Capture counts, Session timings, Monitored User counts — were computed over the foreign Project and attached to an artifact the caller owns. The worker writes back only `status` and `gcsPath`, never `projectId`, so `GET /admin/reports/:id/status` then answered it as the caller's own.

**Root cause:** the route was reasoned about under the identity it was designed for, not under every identity its middleware admits. "Internal endpoint" described the intended caller; the `||` described the actual one. The same reasoning hid a second defect in the mirror: only the `projectId` looked like the untrusted input, so the `reportId` — the other end, and the one that decides where the answer lands — went unexamined.

Confirmed while checking this: `INTERNAL_SECRET` is set nowhere. `cloudbuild.yaml`'s `--set-env-vars` does not name it and the deployed `thehammer-backend` revision has no such variable, so production runs on the literal `'dev-secret'` in the code's own fallback. Filed separately rather than fixed here (AGENTS.md §2), as #105 — since closed: the literal is gone from both call sites, an unset `INTERNAL_SECRET` refuses the internal path in production instead of accepting a known value, and `infra/add-internal-secret.ps1` plus a `--set-secrets` entry provision the real one. No second lesson was written for that fix; it is this one's other half.

**Rule going forward:**
- **Enumerate every identity a middleware admits, then check the route against the weakest one.** A guard written as `A || B` is a route with two callers. Exempting it because of `A` leaves `B` unguarded, and `B` is usually the one an attacker already has.
- **A default credential in code is a production credential until something is proven to override it.** `process.env.X || 'dev-secret'` never fails, never logs, and never looks wrong locally. Check the deployed environment rather than the line that reads it.
- **When a request names two records, both are untrusted.** The id that selects the data and the id that receives the result are the same defect seen from either end; checking one and not the other closes half of it (lesson 67).

### 72. A script that carries on after a failed call publishes whatever the variable held

**What happened:** `infra/add-internal-secret.ps1` generates the worker secret rather than asking for one, using `[System.Security.Cryptography.RandomNumberGenerator]::Fill($BYTES)`. That method is .NET Core 3.0+; Windows PowerShell 5.1 runs on .NET Framework, where it does not exist. The call threw `MethodNotFound`. The script had `$ErrorActionPreference = 'Continue'` — copied from `add-shotstack-secret.ps1`, where it is right, because there it keeps a non-zero `gcloud` exit from aborting the run — so execution continued with `$BYTES` still holding the zeroed array `[byte[]]::new(32)` returns. The hex encoding of that is sixty-four `0` characters, and it was created as version 1 of `internal-worker-secret` in Secret Manager. The script then printed `[OK] Secret stored` in green.

**Root cause:** the failure and the success path shared a variable that was valid-looking in both. A zeroed buffer is a perfectly good byte array; nothing downstream could tell it apart from a generated one, and every subsequent step — the write, the IAM grant, the summary — behaved identically. `Continue` was inherited from a script whose risky operation was an external command, into a script whose risky operation was in-process value generation, where "carry on with what you have" means "publish it". The error text scrolled past above four screens of green success output.

Caught by reading the value back (`gcloud secrets versions access 1`) rather than by trusting the script's own report. Fixed with `RNGCryptoServiceProvider`, which both editions have, plus a check on the generated value — length, and more than eight distinct characters — that throws before any write. Version 2 holds a real secret; version 1 was destroyed.

**Rule going forward:**
- **Read back what a provisioning script claims it wrote.** The script is not evidence about the value; the value is. One `versions access` call is the difference between a secret and sixty-four zeros. Same shape as lesson 70: a check that has never been observed failing has nothing behind it.
- **`$ErrorActionPreference = 'Continue'` is a decision about one specific risky call, not a file-level default to copy.** Where the risky thing produces a value the rest of the script consumes, `Continue` converts a loud failure into a silent wrong answer. Scope it, or use `Stop` and catch what you actually mean to tolerate.
- **Validate a generated credential before publishing it, not after.** The check costs three lines and is indifferent to which API failed or which PowerShell edition is running — it would have caught this, and will catch the next generation bug that has nothing to do with `Fill()`.
- **PowerShell 5.1 is .NET Framework.** Anything documented as .NET Core 3.0+ or .NET 5+ is absent here. This machine runs 5.1 (see also lesson 63 on its other quirks).

### 73. A BOM is part of the secret, and every signal said the secret was fine

**What happened:** #105's whole point was to put a real `INTERNAL_SECRET` in Secret Manager. It went in, the deploy verified it on the revision, the issue was closed — and report generation was still broken. Asking the live service for a report returned `202 queued` and then sat at `queued` forever. The only log line was `[Reports] Failed to trigger worker:` with no cause attached.

The stored secret was 67 bytes for a 64-character value. `[System.IO.File]::WriteAllText($f, $v, [System.Text.Encoding]::UTF8)` writes a three-byte BOM (`EF BB BF`), and a secret is bytes rather than a text document, so `U+FEFF` became the first character of the value. `add-shotstack-secret.ps1` has the same line, so `SHOTSTACK_API_KEY` has carried a BOM in production since #90 — every Shotstack call sending a corrupted key.

**Root cause:** the failure mode is uniquely quiet, because a BOM-prefixed secret is still *truthy*. Nothing fails at startup. `resolveInternalSecret()` returns a value, so `reports/generate` passes its "is it configured" check and answers 202 exactly as it should. The value is simply never equal to a clean secret — and `U+FEFF` is not a legal HTTP header character, so `fetch` throws while *building* the request. That rejection lands in a `.catch` that logs a message and discards the error, because `logger.error(msg, err)` spreads an Error into `{}` and an Error has no own enumerable properties. So: a wrong value that looks configured, a request that never leaves, and a log line with the cause deleted. Three layers, each of which independently hid it.

Every check made in #105 passed and none of them looked at the bytes: the script said `[OK] Secret stored`, `gcloud run services describe` confirmed `INTERNAL_SECRET` was on the revision, and the deploy's smoke test does not generate a report. "The variable is present" was mistaken for "the value is right".

**Rule going forward:**
- **Write secrets with `New-Object System.Text.UTF8Encoding($false)`, never `[System.Text.Encoding]::UTF8`.** The latter is the BOM-emitting one. This is not a PowerShell trivia point: it silently corrupts every credential this repo provisions.
- **Assert the stored byte count, not the write.** Both scripts now read the value back from Secret Manager and compare its length to the string they meant to store. Three bytes is the entire bug, and length is enough to catch it. Same rule as lesson 72, one layer further out: the script's report is not evidence, and neither is the deployment's.
- **`logger.error(message, err)` throws the error away.** The logger spreads its payload, and `{...new Error('x')}` is `{}`; a string payload spreads into `{"0":"F","1":"i",...}`, which is where those character-indexed log entries come from. Pass `{ error: err.message, stack: err.stack }` until the logger is fixed.
- **A deployed env var proves presence, not correctness.** The only test that would have caught this is the one that exercises the feature end to end against production. #105's acceptance criteria stopped one step short, at `describe`.

### 74. One symptom can have three sufficient causes, and a graceful fallback hides them one at a time

**What happened:** #107 found the Vertex client built as `new GoogleGenAI({ vertexai: { project, location } })` when `vertexai` is a boolean and the other two are its siblings. That was filed as *the* reason no report had ever carried a narrative. It was not. Behind it, `aiplatform.googleapis.com` had never been enabled on `thehammer` at all — a direct probe returned `403 SERVICE_DISABLED` — and the backend service account held only `roles/datastore.user`. Behind *that*, the model every call names, `gemini-1.5-flash`, was withdrawn from projects with no prior usage on 2025-04-29 and is now off Google's deprecation list entirely. A project that never enabled the API has no prior usage by definition, so it does not qualify for the legacy access that kept existing users running.

Three independent causes, each sufficient on its own. Fixing the first and enabling the API would have moved the failure from "Authentication is not set up" to a 404 on the model, and nobody would have seen the difference — because #8's graceful degradation catches every one of them identically: status `done`, real metrics, a `summary` field reading "LLM generation failed. Showing raw metrics only."

**Root cause:** a fallback that converts any failure into the same successful-looking output destroys the information that distinguishes causes. Once one is found it is natural to stop, because the found cause *is* a real cause and it fully explains the symptom. It just does not exhaust it. The only reason the second and third were found is that the environment was checked before the fix was deployed, rather than after.

**Rule going forward:**
- **Before spending an infrastructure change on a fix, verify the rest of the chain it depends on.** The API, the credential, the permission, the model, the region. A code fix that lands into a broken environment reports success and changes nothing observable.
- **When a fallback makes all failures look alike, treat the first cause you find as one of an unknown number.** Ask what the *next* error would be if this one were fixed, and go and check. That question is what turned #107 into #107 plus #108.
- **A model id is a dependency with an expiry date, not a constant.** Pin the check, not just the string: every provider retires models, and the failure arrives as a 404 long after the code was last touched.

### 75. A test that asserts a double's output is measuring the double

**What happened:** two of them, found in one session.

`worker-routes-tenancy.test.js` asserted that `POST /worker/ocr` drove its report to `done` with an artifact at a known path. It passed for months. It passed because `generateOcrReport` never called the model at all — it returned two hardcoded findings and wrote them to GCS (#96). The assertion was satisfied entirely by the fabrication it should have exposed.

Separately, every suite mocks `@google/genai` wholesale through `helpers/genaiMock.js`, which replaces the constructor. So the malformed options object in #107 was never handed to anything that could reject it, and no test could have caught the defect no matter how many were written.

**Root cause:** in both, the value under test was supplied by the test's own scaffolding. The OCR test asserted an outcome the production code invented; the Vertex mock swallowed the only argument that mattered. A test like this is a tautology wearing the shape of a check — and worse than no test, because it reports coverage over exactly the place where none exists.

**Rule going forward:**
- **Ask what would have to be true for this assertion to fail.** If the answer is "the mock would have to return something else", the test is measuring the mock. The OCR test could not fail while the mock existed.
- **When a double replaces a constructor, assert on the arguments it received.** `GoogleGenAI.mock.calls[0][0]` was available the whole time; nobody looked at it. That single assertion is what closed #107, and it needs `jest.resetModules()` rather than a cleared mock because the client memoises.
- **A green suite over a mocked boundary says nothing about the boundary.** Say so in the test's header, so the next person knows which side of the seam is actually covered.

### 76. A verification script that asserts the old decision keeps confirming it

**What happened:** ADR 0010 fixed the answer at "captures are kept indefinitely". Three things went on saying otherwise. `infra/lifecycle.json` declared a 90-day Delete rule; `setup.sh` and `setup.ps1` applied it; and `verify.sh` and `verify.ps1` carried a check named `Bucket has lifecycle rule` that **passed** when the rule was there. So a green verify run was certifying the opposite of what the product had decided, and reading it as reassurance was reasonable — it said PASS.

Two further layers sat underneath. The bucket all of it named, `thehammer-screenshots`, has been deleted; every reader and writer of captures uses `thehammer-storage-2026`. The next `setup.sh` run would therefore have created the dead bucket back into existence and applied the delete rule to it, against a name nothing reads. And the Settings panel offered a Retention (days) field whose value was stored, validated as a positive integer, reported back by `GET /config` — and read by nothing that deletes. Three contradictory values for one number, none of which did anything.

**Root cause:** a decision was recorded in an ADR and never chased into the scripts that assert it. A check is not neutral about a decision it names — it *is* the decision, restated in a place that runs. Inverting the product's answer while leaving the check alone gives you a check that actively defends the discarded answer, and there is nothing in a passing run to tell you which side it is on.

**Rule going forward:**
- **When a decision changes, grep for its assertions, not just its implementations.** Removing the code that deletes is half the job; the check that demands deletion is the half that will still be there in a year saying PASS.
- **Fail closed when the tool cannot answer.** `! gcloud ... | grep -q rule` reports "no rule" for a bucket you are not authenticated against, because an error prints nothing and nothing does not match. Capture the output and require the command to have succeeded before judging what it said — both verify scripts do this now, and `infra/tests/bucket-lifecycle.test.js` asserts they still do.
- **A control that stores and validates a value nobody reads is worse than no control.** It tells an Admin something untrue about their data, and it survives review precisely because it looks complete.

### 77. A cascade written from the read paths misses whatever nothing reads

**What happened:** deleting a Project removed the Project document and its memberships and nothing else. Every read path resolves a Capture through its Project, so the Captures, Reports, Sessions and Storyboards filed under it did not become deleted — they became *unaddressable*. Nobody could list, export or report on them, and nobody was told they were still there. Five Projects deleted in June and August left 17 records and 26 objects that way, found three weeks later during unrelated work on a different ticket (#109). The confirmation modal had been saying so the whole time — *"Uploads in GCS are not affected"* — a sentence `git log -S` traces to the original portal sprint, describing what the code happened to do rather than anything anyone decided.

Writing the cascade, six collections carry a `projectId`. Five of them are obvious because something reads them by `projectId`. The sixth, `inactivity_events`, is only ever queried by `sessionId` — so enumerating "what does the system read for a Project?" produces five, and the sixth survives the Purge silently, exactly as the seventeen survived the delete.

**Root cause:** the set of things a Project *owns* and the set of things the code *reads through* a Project are different sets, and the second is the one that is easy to enumerate — you can find it by grepping the read paths. The first can only be found by asking what carries the foreign key. Anything owned but unread falls in the gap, and nothing observable marks its absence from the cascade, because unread data produces no symptom when it is wrongly kept and none when it is wrongly deleted either.

**Rule going forward:**
- **Build a cascade from the schema, not from the read paths.** Ask which collections carry the id, not which queries use it. `inactivity_events` is the one this project has; the next one will have its own.
- **Order a cascade so the pointer dies last.** Children first, the Project document last: while it survives, everything under it is still reachable, so a run that dies halfway is one you repeat. The old route deleted the Project document in the same batch as the memberships, which is precisely why the leftovers were unreachable rather than merely orphaned. The sweep that clears them obeys the same rule from the other end — objects before the record that names their prefix, because the record is the only thing that knows the prefix.
- **A UI sentence nobody decided is still a specification.** That modal accurately described a defect for months and made it look intentional. When behaviour changes, the sentence describing it is part of the change; when you find a sentence no ADR or ticket accounts for, treat it as a claim under test, not as documentation.


### 78. A blocker recorded once is believed forever unless someone re-derives it

**What happened:** #36 — the extension's id being derived from its folder path, so the backend could only trust one developer at a time — sat open for weeks with a written reason not to fix it. `docs/for-chris/DEPLOYMENT-NOTES.md` told the client the fix was *"deferred because it also changes the sign-in redirect address and would break portal sign-in until the OAuth client is updated in the same window."* That sentence is what made the ticket look expensive: a coordinated change against an external OAuth configuration, inside a window where sign-in is broken. #54's list-of-ids mitigation was built instead, and it is the thing that grew one entry per developer and could never be pruned.

There is no such OAuth client. The extension calls `chrome.identity.launchWebAuthFlow` against **our own** `portal/auth-ext.html`, and that page validates the `chromiumapp.org` redirect against `ALLOWED_EXTENSION_IDS`, injected at build time from the same `_EXTENSION_IDS` substitution in `cloudbuild.yaml` that feeds the backend's CORS allowlist. Both halves are one value with two consumers, and they move together in a single deploy. Nothing external whitelists the redirect, so there was never a window to coordinate. The whole change is a manifest key, one substitution, and a re-load of the extension.

**Root cause:** the deferral was reasoned about at the level of the *name* — "OAuth redirect URI" sounds like Google's console, because for most extensions it is — rather than by following the call. #36's own body had already flagged the redirect as "currently self-consistent per machine and **not believed to be broken**"; the note in the client-facing doc hardened that hedge into a stated blocker, and after that nobody re-opened the question, because the answer was written down. A recorded reason is indistinguishable from a verified one once it is a sentence in a document, and this one was quoted to the client as fact.

**Rule going forward:**
- **A deferral needs the same evidence as a fix.** "We are not doing this because X breaks" is a claim about the system, and it decides how much work gets built around the gap. #54 exists because of this one. Verify it the way you would verify a bug report, and record what you actually checked.
- **Follow the call, not the vocabulary.** `getRedirectURL()` and "OAuth redirect" name a Google-console concept in most codebases and a page we ship in this one. Grep for who *reads* the value before assuming who owns it.
- **Re-derive a blocker before repeating it to a client.** Once it is in a for-chris doc it is being relied on for planning, and the cost of it being wrong is no longer internal.
- **When the blocker turns out to be false, delete the mitigation's justification too.** The list in `EXTENSION_ID` is still parsed — deliberately, for the separator reason in lesson 63 — but nothing should still describe it as the way new developers are onboarded.

### 79. `os.homedir()` does not read `HOME` on Windows, so a sandboxed check writes to the real path

**What happened:** while verifying that the key-regeneration command documented in `DEVELOPER_GUIDE.md` actually runs, it was executed with `HOME` pointed at a throwaway directory. Node's `os.homedir()` ignores `HOME` on Windows — it reads `USERPROFILE` — so the command resolved `~/.thehammer/` to the real one and overwrote `thehammer-extension-key.pem`, the private key the manifest's committed public key had been derived from minutes earlier. The extension id changed underneath the change that was introducing it. Recovery was cheap only because nothing external depended on the old key yet; had this been run a week later, the committed `key` and the on-disk `.pem` would have silently disagreed, and packing or publishing the extension would have been impossible without regenerating every id again.

**Root cause:** two failures that only combine on Windows. `HOME` is the POSIX variable and does nothing here, so the sandbox was never in effect; and the command itself writes unconditionally, with no check for an existing file and no prompt — a generator whose failure mode is destroying the thing it generates. Running it "just to see that it works" is therefore not a read-only act, which is exactly how it was being treated.

**Rule going forward:**
- **On Windows, override `USERPROFILE`, not `HOME`** — or better, give the script an explicit output path argument and pass a temp directory. Do not trust an env var to sandbox a filesystem write.
- **A command that writes a key must refuse to overwrite one.** Check for the file and stop; make replacing it a deliberate flag. `DEVELOPER_GUIDE.md` carries the warning, which is the weaker half of the fix.
- **Verifying a documented command is a write, not a read.** Run it somewhere disposable, and work out what it touches before running it rather than after.

### 80. A fire-and-forget write outlives the test that started it, and fails the next one

**What happened:** #62 added `stampLastCapture`, deliberately never awaited — AGENTS.md rule 4 says nothing may block the capture loop, and the Capture is already recorded by the time it runs. The full suite was green locally, twice, including a run through `firebase emulators:exec` against a cold emulator, which is exactly what Cloud Build does. It was pushed and the build failed:

```
FAIL tests/capture-visible-loop.test.js
  ● Test suite failed to run
    Cannot read properties of undefined (reading 'options')
```

with, further up the log and against a *different* file:

```
ReferenceError: You are trying to `require` a file after the Jest environment
has been torn down. From tests/signed-url.test.js.
    at new GoogleErrorDecoder (google-gax/src/googleError.ts:169:28)
```

Every one of the 397 tests passed. One suite failed to *run*. The un-awaited Firestore write from `signed-url.test.js` was still waiting on gRPC when Jest destroyed that file's environment; the response arrived afterwards, google-gax tried to load a module to decode it, and the wreckage was reported against `capture-visible-loop.test.js` — the suite that happened to run next and had done nothing wrong. A retry failed identically, because retrying re-runs the same code.

**Root cause:** two things that only bite together. Jest gives each test file its own module registry and tears it down the instant the last test resolves, so anything still in flight is running against a dead environment; and a fire-and-forget write is by definition something nothing waits for. The suite that *leaks* is not the suite that *fails*, so the stack trace names an innocent file, and the timing depends on how quickly the emulator answers — which is why a slower CI container failed where a developer machine did not. The local run had no diagnostic power against this defect at all, and looked like it did.

**Rule going forward:**
- **An un-awaited write needs somewhere to be waited for.** `src/lib/pendingWrites.js` registers each one and `tests/setup/drain-pending-writes.js` drains them in a global `afterAll`, wired through `setupFilesAfterEnv` so every suite gets it — including suites written later by someone who has never heard of this. A per-suite hook is one somebody forgets, and the failure lands on a file they were not editing.
- **Read the whole log, not the failing suite.** The named suite was innocent. The evidence was forty lines earlier, attributed to a different file, and the fix belonged to neither — it belonged to the code both of them call.
- **A green local run is not evidence about teardown races.** Reproducing the container is not enough when the variable is timing. This one survived `emulators:exec` against a cold emulator locally and still failed in Cloud Build.
- **Retrying a build tests nothing.** Same commit, same code, same result — a retry is only ever informative about genuine flakes, and treating it as a fix costs an approval and a deploy slot.
