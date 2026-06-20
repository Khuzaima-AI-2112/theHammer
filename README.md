# The Hammer

A Chrome extension that captures a screenshot of the active tab and uploads it to Google Cloud Storage. Captures are categorized by project, tool, and user.

## Project Structure

The repository is structured into distinct functional areas:

- `backend/` — Node.js Express server running on Cloud Run. Handles capture ingestion, role-based access, and Cloud Storage uploads.
- `portal/` — Admin/Analyst/Instructional Designer Single Page Application (SPA).
- `extension/` — Chrome extension (Manifest V3) for triggering captures.
- `infra/` — Deployment scripts and Cloud Build pipeline definitions.
- `docs/` — Project documentation.
  - `docs/architecture.md` — Consolidated architecture decisions, Firestore schemas, and time-tracking specs.
  - `docs/planning/` — Sprint plans (`sprintplan2.md`, `projectplan.md`, `sprint21.md`).
- `mdarchives/` — Archived and deprecated plans/documentation.
- `.agent/` — Instructions and guidance for AI agents (including `AI_GUIDANCE.md`).

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
npm run test
```

### Portal

The Admin Portal is a set of static files. To view them locally, you can use any static file server:
```bash
cd portal
npx serve
```

## Deployment

Deployments are handled via GitHub Actions to Google Cloud. Do not run manual deployments from your local machine.

* `thehammer` (Prod)
* `hammer-dev` (Dev)

Refer to `docs/architecture.md` for complete details on infrastructure, authentication (Cloud IAP), and GCP topology.
