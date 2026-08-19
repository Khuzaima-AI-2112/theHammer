# Developer Guide — `theHammer`

Welcome to `theHammer` repository! This guide provides step-by-step instructions to set up your local development environment, run offline unit/integration tests using the Firebase Emulator, test the Chrome extension, and deploy updates to Google Cloud.

---

## 1. Prerequisites & Environment Setup

### Required Tools
- **Node.js**: v20.x or v22.x
- **npm**: v10+
- **Git**: Latest version
- **Google Cloud SDK (`gcloud` CLI)**: [Install gcloud CLI](https://cloud.google.com/sdk/docs/install)
- **Firebase CLI**: Install globally via `npm install -g firebase-tools`

### Clone the Repository
```bash
git clone https://github.com/cfroszte/thehammer.git
cd thehammer
```

### Install Dependencies
```bash
# Install root workspace dependencies
npm install

# Install backend dependencies
cd backend
npm install
cd ..
```

---

## 2. Authentication & GCP Project Setup

Your Google account (`ua7968863@gmail.com`) has been granted **Editor** permissions on the GCP project `thehammer`.

1. **Authenticate gcloud CLI**:
   ```bash
   gcloud auth login
   gcloud auth application-default login
   gcloud config set project thehammer
   ```

2. **Verify GCP Context**:
   ```powershell
   powershell -ExecutionPolicy Bypass -File ./verify-gcp-env.ps1
   ```

3. **Authenticate Firebase CLI**:
   ```bash
   firebase login
   ```

---

## 3. Local Development & Testing

### Running Unit & Integration Tests (Local Emulator)
All backend tests execute against an offline local Firestore Emulator (no live cloud data is modified during testing):

```bash
cd backend
npx firebase emulators:exec --only firestore --project demo-hammer "npm test"
```

### Running Backend Server Locally
```bash
cd backend
npm start
# Express backend API will listen on http://localhost:8080
```

### Testing the Chrome Extension Locally
1. Open Google Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle switch).
3. Click **Load unpacked** and select the `./extension` directory from this repository.
4. Click **The Hammer** extension icon in Chrome:
   - Go to Options / Settings in the popup.
   - Set **API Base URL** to `http://localhost:8080/api` for local testing or `https://thehammer-backend-282689937365.northamerica-northeast1.run.app/api` for live cloud testing.

---

## 4. Development & Deployment Workflow

### Branching Strategy
- You have push access to `main`.
- (`main-backup` branch is preserved on GitHub as an initial backup point).
- Make your code changes, run test verification, and commit cleanly:
  ```bash
  git add .
  git commit -m "feat: description of your improvement"
  git push origin main
  ```

### Deploying Revisions to Live Cloud Run
When your updates are tested locally and ready for production deployment:

```powershell
# Deploy backend container to Cloud Run (Windows PowerShell)
powershell -ExecutionPolicy Bypass -File ./infra/deploy.ps1
```
Or trigger full Google Cloud Build execution (builds backend + portal and runs smoke tests):
```bash
gcloud builds submit --config=cloudbuild.yaml .
```

---

## 5. Repository Structure & Key Files

| Path | Purpose |
| :--- | :--- |
| `backend/src/index.js` | Core Express API router (`/upload-url`, `/capture`, `/session-events`) |
| `backend/src/lib/` | One Source of Truth (OSOT) constants, roles, logger, and vertex setup |
| `backend/tests/` | Jest integration and unit test suite |
| `extension/` | Chrome MV3 Extension (Service worker, popup UI, content script) |
| `portal/` | Admin Web Portal static UI (Nginx container) |
| `infra/deploy.ps1` | Automated Cloud Run deployment script |
| `cloudbuild.yaml` | Multi-service Cloud Build CI/CD pipeline |
| `docs/megamind.md` | Single-entry OSOT module index |
| `docs/loop_engineering.md` | Architectural inner/outer feedback loop reference |

---

## Need Help?
For architectural references, consult `docs/megamind.md` or `lessons_learned.md` before making structural changes.
