# The Hammer

A Chrome extension that captures a screenshot of the active tab and uploads it to Google Cloud Storage. Captures are securely isolated by B2B Workspaces, and categorized by project and tool. Identity is managed via Firebase Authentication.

## Project Structure

The repository is structured into distinct functional areas:

- `backend/` — Node.js Express server running on Cloud Run. Handles capture ingestion, role-based access, and Cloud Storage uploads.
- `portal/` — Admin/Analyst/Instructional Designer Single Page Application (SPA).
- `extension/` — Chrome extension (Manifest V3) for triggering captures.
- `infra/` — Deployment scripts and Cloud Build pipeline definitions.
- `docs/` — Project documentation.
  - `docs/architecture.md` — Consolidated architecture decisions, Firestore schemas, and time-tracking specs.
  - `docs/planning/` — Current sprint plans (`projectplan.md`, `sprint21.md`,
    `sprint22.md`, `sprint31.md`).
  - `docs/archives/` — Superseded plans, including `sprintplan2.md`, which is no
    longer maintained (AGENTS.md rule 1).
  - `docs/adr/` — Architecture decision records.
  - `docs/agents/` — Issue tracker, triage labels and domain-doc conventions.
- `AGENTS.md` — Project rules and guardrails for developers and AI agents (single source of truth).
- `.agent/` — Legacy location; `AI_GUIDANCE.md` is now a stub pointing at `AGENTS.md`.

## Development & Local Setup

### Backend

To start the backend server locally:
```bash
cd backend
npm install
npm run dev
```

To run backend tests:
```bash
cd backend
npm install            # first time: brings in the pinned firebase-tools
npm run test:emulator
```

`npm test` on its own runs Jest against whatever Firestore it can find and is
red on a clean machine — the suite needs the emulator, which `test:emulator`
starts and stops around it. Needs JDK 21 and port 8085 free; see
[`DEVELOPER_GUIDE.md`](./DEVELOPER_GUIDE.md) §1.

### Portal

The Admin Portal is a set of static files. To view them locally, you can use any static file server:
```bash
cd portal
npx serve
```

## Deployment

Deployments are handled by **Cloud Build** (`cloudbuild.yaml`), on a push to
`main` of the client remote, behind the project owner's manual approval
(ADR-0005). Do not run manual deployments from your local machine — see
AGENTS.md rule 5, which is the binding statement.

*Corrected 2026-09-08 (#9): this said GitHub Actions. There is no `.github/`
directory in this repository.*

* `thehammer` (Prod)
* `hammer-dev` (Dev)

Refer to `docs/architecture.md` for complete details on infrastructure, Firebase Authentication, Workspaces, and GCP topology.
