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
