# The Hammer — Lessons Learned & Fix Plan

> Sprint 2 retrospective. Every item here was identified by auditing the live code in the repo
> post-sprint. The goal is to never repeat these classes of mistake in Sprint 3 or beyond.

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

**What happened:** The API key check performs `crypto.timingSafeEqual(expBuf, provBuf) && provided.length === expected.length`. The `&&` short-circuits: if `timingSafeEqual` returns `false`, JavaScript never evaluates the length check — which is fine. But the length check appears *after* the safe comparison, so it doesn't leak via short-circuit in that direction. However, `provBuf` is zero-padded to `expBuf.length` using `Buffer.alloc`, so a short key passes through `timingSafeEqual` without throwing — but will return `false` due to the zero padding. The real problem is that the separate `provided.length === expected.length` check runs in non-constant time (standard integer comparison) and reveals whether the attacker's key length matches the expected length, which narrows the brute-force space.

**Rule going forward:**
- The canonical constant-time key comparison in Node is: derive a fixed-length HMAC of both sides using the same key and then compare the HMACs with `timingSafeEqual`. This way both buffers are always the same length and neither branch reveals length information.
- Never split a timing-safe check into a safe comparison plus a non-safe length check. Do it all inside one `timingSafeEqual` call on equal-length buffers.
- Reference implementation to use in Sprint 3+:

```js
function keysEqual(provided, expected) {
  // Both sides hashed to a fixed 32-byte digest before comparison.
  // Length difference is fully hidden.
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

**What happened:** `DEFAULT_CLOUD_RUN_URL` was set to `'https://YOUR_CLOUD_RUN_URL'`. If a user somehow bypasses the API key guard (e.g., they set an API key but forget to set the URL), the extension makes a real HTTPS fetch to `https://YOUR_CLOUD_RUN_URL/capture`, which will do a DNS lookup, fail after the OS timeout (~10 s), and then hit the `AbortController` timeout at 15 s — 25 seconds of silent waiting before showing an error.

**Root cause:** The placeholder was copied from documentation style into production code without adding a corresponding guard.

**Rule going forward:**
- Placeholder values in production code must be the **sentinel that triggers a guard**, not a fake-but-valid-looking value. Use `''`, `null`, or a value that is explicitly checked:

```js
const DEFAULT_CLOUD_RUN_URL = ''; // deliberately empty — forces the guard below to fire
```

- Any configuration value read from storage must have an explicit "not configured" check with an immediate user-facing notification before it is ever used in a network call.
- Document the sentinel value and its check in a comment so future editors don't "fix" the empty string.

---

### 5. Spec task descriptions with both a rule and a "done when" test must be cross-checked at implementation time

**What happened:** Task 2.3 had two statements: (a) *"Validation middleware runs before `multer`"* and (b) *"Valid upload → 200; missing `file` field → 400."* The implementation satisfied (b) but not (a). The summary written in the handoff said it was done, citing only the passing test case.

**Root cause:** "Done when" test cases are necessary but not sufficient. They test outcomes, not implementation constraints. The route-architecture constraint in the task description was silently dropped.

**Rule going forward:**
- Every sprint task has two things to verify: the **outcome test** ("does it return 400?") and the **implementation constraint** ("does the validation run before multer?"). Both must be checked off explicitly, not just the outcome.
- Add an architecture assertion to the test file: for task 2.3, a test that sends a request with valid fields but a 15 MB file (over the limit) should fail faster than multer's stream timeout — proving validation is pre-buffer. If it can't be tested, the constraint must be noted as a known gap.

---

### 6. The deploy script's Docker build step must match the actual project structure

**What happened:** The sprint brief specified `COPY dist/ ./dist/` in the Dockerfile (implying a TypeScript compile step). The project has no TypeScript; source lives in `src/`. The Dockerfile was correctly changed to `COPY src/ ./src/`, but the original spec was followed partially — a future engineer reading the spec and not the actual Dockerfile could re-introduce a `dist/` step that breaks the build.

**Root cause:** The spec Dockerfile was treated as a template to copy verbatim rather than as a starting point to adapt to the actual project structure.

**Rule going forward:**
- Specs are inputs, not oracles. When a spec artifact (Dockerfile, script snippet) conflicts with the actual repo structure, adapt it and add a comment explaining the deviation:

```dockerfile
# Note: no TypeScript build step — source is plain JS in src/.
# Spec template used dist/; adjusted to src/ to match actual layout.
COPY src/ ./src/
```

- Document all deliberate deviations from the sprint brief in `sprintplan.md` under a "Deviations" subsection for the sprint.

---

### 7. `sprintplan.md` must be updated in the same commit as the code it tracks

**What happened:** The sprint plan was never updated to mark Sprint 2 tasks in-progress or complete. The file's SHA was identical before and after all Sprint 2 code was pushed.

**Root cause:** Plan updates were treated as optional documentation work rather than part of the definition of done.

**Rule going forward:**
- `sprintplan.md` is a required file in every sprint commit that changes a task's status. It is not optional documentation.
- The completion gate for every sprint explicitly includes `sprintplan.md` being current. If the plan is out of date, the sprint is not done.
- Use a simple checkbox convention in the plan: `- [ ]` → `- [x]` when complete, `- [~]` when in-progress.

---

## Fix Plan

The following table maps each lesson to a concrete code fix, the file(s) to change, and the acceptance test that confirms it is resolved.

| # | Lesson | File(s) | Fix | Acceptance test |
|---|--------|---------|-----|-----------------|
| 1 | Response contract mismatch | `extension/content.js`, `extension/service-worker.js` | Add contract comment to `service-worker.js`; update `content.js` to log `response.path` | Trigger floating button capture; confirm console shows `path:` value, not `length: undefined` |
| 2 | Dead middleware stub | `backend/src/index.js` | Delete `validateRequiredFields` function; add pre-multer `Content-Type` check; update all comments to accurately describe post-multer field validation | `curl` with non-multipart Content-Type returns 400 before file is read; send request missing `projectId` → 400 with field name in body |
| 3 | Timing-safe key comparison | `backend/src/index.js` | Replace padded-buffer comparison with HMAC-based `keysEqual()` function (see Lesson 3 reference implementation) | Wrong key → 401; correct key → 200; key that is one byte shorter than expected → 401 |
| 4 | Placeholder default URL | `extension/service-worker.js` | Set `DEFAULT_CLOUD_RUN_URL = ''`; add explicit empty-string guard with immediate notification | Capture with URL unset → instant notification "Cloud Run URL not set", no network request made |
| 5 | Spec constraint vs. outcome | `backend/src/index.js`, `backend/tests/validation.test.js` | Add pre-multer Content-Type middleware (satisfies the architecture constraint); add test that oversized non-multipart request is rejected before multer streams it | Test file: new test `'rejects non-multipart before buffering'` passes |
| 6 | Spec Dockerfile deviation | `backend/Dockerfile` | Add deviation comment; verify `COPY src/` is present and no `dist/` reference exists | `docker build ./backend` completes without error on a clean checkout |
| 7 | Stale sprint plan | `sprintplan.md` | Mark all Sprint 2 tasks complete; add "Deviations" subsection noting the `dist/` → `src/` Dockerfile change and the post-multer validation tradeoff | `sprintplan.md` reflects current task status; reviewed at sprint close |

### Execution order

Fix items in this sequence to avoid re-work:

1. **Item 2 + 5 together** — the pre-multer Content-Type check resolves both the dead stub (item 2) and the architecture constraint (item 5) in one edit to `backend/src/index.js` and `backend/tests/validation.test.js`.
2. **Item 3** — isolated to the `requireApiKey` function in `backend/src/index.js`; no other files touched.
3. **Item 4** — one line change in `extension/service-worker.js` + one guard block.
4. **Item 1** — update `content.js` log; add contract comment to `service-worker.js`.
5. **Item 6** — add comment to `Dockerfile`; no logic change.
6. **Item 7** — update `sprintplan.md` last, after all code fixes are confirmed.

---

## Sprint 3 Pre-flight Checklist

Before starting Sprint 3 implementation, verify:

- [ ] All 7 fix-plan items above are merged to `main`
- [ ] `node --test tests/**/*.test.js` passes with zero failures (including new pre-multer test)
- [ ] `curl $SERVICE_URL/health` returns `{ "status": "ok" }` on the deployed service
- [ ] All three capture triggers produce a GCS object within 5 seconds
- [ ] `sprintplan.md` Sprint 2 section is fully checked off
- [ ] This file (`lessons_learned.md`) is linked from `AGENTS.md` so future agent sessions are aware of it
