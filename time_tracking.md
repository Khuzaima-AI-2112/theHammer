# Time & Activity Tracking

This document defines how The Hammer measures time and activity for users, how those signals roll up into reporting metrics for Analysts and Admins, and what the user is told when they start using the extension.

The goal is to make the model:
- **Technically sound** — reflects what the browser and OS can realistically tell us.
- **Interpretable** — Analysts and Admins can trust and explain the numbers.
- **Transparent** — users clearly understand that screenshots are uploaded and time is being tracked.

---

## 1. Raw Signals

The system combines several low‑level signals:

1. **Session events (extension → `/session-events`)**
   - Written by the extension service worker via `sessionFlush()`.
   - Fields:
     - `sessionId` — UUID per browser session.
     - `projectId` — current project in the extension.
     - `sessionStart` — ISO string when the session started.
     - `sessionEnd` — ISO string when the session ended or was flushed.
     - `totalCaptures` — number of screenshots in this session.
     - `firstCapturePath` / `lastCapturePath` — GCS paths for first/last capture.
     - `schemaVersion` — currently `1`.
     - `deleteAfter` — `sessionStart + 365 days` (Firestore TTL).

2. **Uploads timeline (`uploads` collection)**
   - One document per uploaded screenshot.
   - Relevant fields:
     - `projectId`
     - `uploadedAt` — capture timestamp.
     - `sessionId` (optional, but recommended) — to correlate with `session_events`.
     - `tool`, `stage`, and other capture metadata.

3. **Inactivity events (extension → `/inactivity-events`)**
   - Emitted when the inactivity timer fires while the user has the feature enabled.
   - Fields:
     - `triggeredAt` — ISO timestamp when the prompt was raised.
     - `userId` — resolved server‑side from API key.
     - `projectId`
     - `acknowledged` — `true` if the user clicked **Capture Now** or **Snooze**.
     - `inactiveDurationMs` (optional) — duration of that idle stretch, if available.
     - `schemaVersion` — currently `1`.
     - `deleteAfter` — `triggeredAt + 365 days` (Firestore TTL).

4. **Idle / focus signals (optional enhancements)**
   - **Chrome Idle API** (`chrome.idle`) — reports `active` vs `idle` vs `locked` for the device.
   - **Tab/window focus** (Chrome tabs & windows APIs) — track when the Hammer tab is the active tab in a focused Chrome window.
   - **Page visibility & focus** (`document.visibilityState`, `document.hasFocus()`) — track when the page is visible and focused in the browser.

The first three are mandatory and already wired into Sprints 6 and 7. Idle/focus signals are optional layers to refine calculations without changing reports’ public contract.

---

## 2. Core Time Metrics

All metrics are computed on the backend (not in the extension) from the signals above.

### 2.1 Session duration

Per `session_events` document:

- `sessionDurationMs = sessionEnd - sessionStart`
- `sessionDurationMinutes = sessionDurationMs / 60_000`

This is **wall‑clock** session length for the Hammer extension in that browser profile.

### 2.2 Inactive time in session

Two compatible strategies are supported.

#### A. Event‑based (preferred when `inactiveDurationMs` is populated)

For a given session `S`:

- Collect all `inactivity_events` where `sessionId == S.sessionId`.
- For each event with `inactiveDurationMs`:
  - `inactiveTimeInSessionMs += inactiveDurationMs`

This yields total idle time in that session based on the timer and user acknowledgement behavior.

#### B. Gap‑based (fallback / cross‑check)

For a given session `S`:

- Fetch all `uploads` where `sessionId == S.sessionId` ordered by `uploadedAt`.
- For each adjacent pair of captures `(t_i, t_{i+1})`:
  - `gap = t_{i+1} - t_i`
  - If `gap > inactivityThresholdMs` (e.g., 45_000):
    - `inactiveTimeInSessionMs += (gap - inactivityThresholdMs)`

This treats the first 45 seconds of any gap as potentially “still working between captures,” and only counts the excess as inactive.

### 2.3 True active time (session‑level)

Per session `S`:

- `trueActiveMs = sessionDurationMs - inactiveTimeInSessionMs`
- `trueActiveMinutes = trueActiveMs / 60_000`

This is the primary metric we use to represent “time the user was likely working in a Hammer session.” It is **session‑scoped**, not page‑scoped, and includes short periods where the user may be copying from other tools into the Hammer project.

### 2.4 Focus‑constrained active time (optional secondary metric)

If idle/focus signals are implemented, we can derive a stricter metric:

- `focusedAndActiveMs` — intersection of:
  - device **active** (Chrome Idle API: `state == 'active'`), and
  - Hammer tab **focused & visible** (tabs/windows + Visibility API), and
  - within the session window `[sessionStart, sessionEnd]`.

Then:

- `focusedActiveMinutes = focusedAndActiveMs / 60_000`

This gives a conservative lower bound on “time actually looking at a Hammer tab,” which is helpful for forensic/diagnostic use but may undercount valid work (e.g., time spent in a spreadsheet copying values into Hammer).

---

## 3. Report‑Level Metrics (Analyst & Admin)

The following metrics are made visible to both Analysts and Admins in the **User Efficiency** report (Sprint 7.5) and selected Admin Portal views.

### 3.1 User Efficiency report (Sprint 7.5)

For a given user, project, and date range:

- **Total sessions** — count of `session_events` in range.
- **Total session time (minutes)** — sum of `sessionDurationMinutes`.
- **True active time (minutes)** — sum of `trueActiveMinutes` across sessions.
- **Inactive time (minutes)** — `Total session time - True active time`.
- **Active ratio** — `True active time / Total session time`.
- **Captures per active hour** — `Total captures / (True active time in hours)`.
- **Optionally:** Focused active time (if implemented) — `focusedActiveMinutes`, with the caveat that this is a stricter measure.

All of these are rolled up per user and per project, and can be filtered by date range. Analysts see them in the JSON & HTML report; Admins see the same metrics rendered in the Portal’s report viewer.

### 3.2 Admin Portal surfaces

- **Activity timeline (Sprint 6.11):**
  - Uses `uploads` + `session_events` to highlight gaps > 45 seconds in amber.
  - Hovering a gap can display the estimated inactive duration for added context.

- **Per‑user panel:**
  - Shows, for a selected period (e.g., last 7 or 30 days):
    - `Total session time`.
    - `True active time`.
    - `Active ratio`.

- **Dashboard (Sprint 9.15):**
  - May surface:
    - “Active users today” — users whose `trueActiveMinutes` exceeds a configurable threshold.
    - Aggregate `True active time` per project.

Analyst and Admin views are intentionally aligned so they can speak about the same metrics without translation.

---

## 4. Entitlements & Feature Flags

Not all users will have inactivity prompts turned on. To keep behavior predictable and auditable:

- A per‑user entitlement flag (e.g., `inactivityPromptEnabled`) is stored in Firestore (on `users` or `api_keys`).
- The extension only schedules `chrome.alarms` and emits `/inactivity-events` **when this flag is true**.
- True active time is computed for all users, but inactivity‑event–based calculations are more accurate when the flag is enabled.

This aligns with the broader feature‑entitlement pattern used for Blur, Clipboard Links, and other admin‑gated capabilities.

---

## 5. User‑Facing Disclosure & Consent

To keep tracking compliant and transparent, the extension presents a clear prompt when a user first starts using The Hammer (or when this behavior is materially changed).

### 5.1 When the prompt appears

- On first run after installation, **or**
- After an update that introduces time tracking or inactivity prompts, **or**
- When an admin newly enables inactivity tracking for that user.

Until the user acknowledges the prompt, the extension operates in a restricted mode (e.g., captures disabled or clearly labeled as “not yet tracking”) to avoid implicit consent.

### 5.2 Prompt content (conceptual)

The copy should be adapted to your org’s legal and policy language, but structurally it includes:

1. **What is collected**
   - Screenshots you explicitly capture using The Hammer.
   - Metadata about those captures (time, project, tool/stage).
   - Session timing: when your capture sessions start & end, and periods where you appear inactive.

2. **How it is used**
   - To help your team understand project progress and tool usage.
   - To generate efficiency and inactivity reports for Admins and Analysts.

3. **Where it is stored and for how long**
   - Stored in your organization’s Hammer environment (Firestore + GCS).
   - Screenshots and time‑tracking events are automatically deleted according to documented retention policies (e.g., session/inactivity events after 1 year).

4. **Your controls**
   - You can see which project a capture is associated with in the extension.
   - Inactivity prompts may be turned on or off for you by an Admin.

5. **Explicit consent action**
   - A clear call to action, such as:
     - **[I understand and agree]**
     - Optional **[More details]** link to internal policy / documentation.

Once accepted, the extension records acceptance locally (and optionally in Firestore) so future sessions don’t re‑prompt unless behavior changes materially.

---

## 6. Implementation Notes

- **Backwards compatibility:** If `inactiveDurationMs` is not populated (older clients), the gap‑based method remains valid and continues to feed true active time.
- **Performance:** Time‑aggregation queries are performed on the backend (e.g., Cloud Run worker) and materialized into report documents; the portal and extension never perform heavy aggregations client‑side.
- **Privacy:** All timing data is scoped by `projectId` and subject to the same data classification and retention policies as screenshots. Admins should ensure this document stays aligned with `data-classification.md` and any formal DPA.
