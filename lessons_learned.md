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
