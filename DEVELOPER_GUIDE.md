# Developer Guide — `theHammer`

Welcome to `theHammer` repository! This guide provides step-by-step instructions to set up your local development environment, run offline unit/integration tests using the Firebase Emulator, test the Chrome extension, and deploy updates to Google Cloud.

---

## 1. Prerequisites & Environment Setup

### Required Tools
- **Node.js**: v20.x or v22.x
- **npm**: v10+
- **Git**: Latest version
- **Google Cloud SDK (`gcloud` CLI)**: [Install gcloud CLI](https://cloud.google.com/sdk/docs/install)
- **JDK 21** — required, and specifically 21. The Firestore emulator is a Java
  program, and `firebase-tools` refuses to start it on anything older:
  `MIN_SUPPORTED_JAVA_MAJOR_VERSION = 21` in
  `lib/emulator/commandUtils.js`, with the message *"firebase-tools no longer
  supports Java version before 21"*. **JDK 17 is not enough.** Check with
  `java -version`; anything below 21, or no JDK at all, and most of the backend
  suite fails with a connection-refused error that reads like a broken project
  rather than a missing tool. [Temurin 21](https://adoptium.net/) is what this
  project is developed against, and `cloudbuild.yaml` installs `openjdk21-jre`.
- **Firebase CLI**: do **not** install it globally. It is pinned in
  `backend/package.json` (`firebase-tools`, exact version) and `npm ci`
  in `backend/` puts it on the path for the scripts below. A global or `npx`
  copy installed elsewhere resolves whatever is newest that day, which is how
  local testing breaks with nobody having touched the repository. Inside
  `backend/`, `npx firebase` finds the pinned copy and is fine; anywhere else
  it does not.

### Clone the Repository
```bash
git clone https://github.com/cfroszte/thehammer.git
cd thehammer
```

### Install Dependencies
```bash
# Install root workspace dependencies
npm install

# Install backend dependencies. `npm ci`, not `npm install`: install on
# Windows rewrites package-lock.json without entries the Linux build needs
# (lesson 86).
cd backend
npm ci
cd ..
```

---

## 2. Authentication & GCP Project Setup

Your Google account (`usmanali07137@gmail.com`) has been granted **Editor** permissions on the GCP project `thehammer`.

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
   cd backend && npx firebase login    # the pinned CLI; see §1
   ```

---

## 3. Local Development & Testing

### Running Unit & Integration Tests (Local Emulator)
All backend tests execute against an offline local Firestore Emulator (no live cloud data is modified during testing):

```bash
cd backend
npm ci             # first time, or after pulling: brings in the pinned CLI
npm run test:emulator
```

That script is the one `cloudbuild.yaml` runs, so a green run here is the same
run the pipeline makes. It needs port **8085** free — that is where
`firebase.json` puts the emulator, and the only place it is *authoritatively*
declared (#57). The test setup carries a matching fallback, which
`infra/tests/emulator-port-single-source.test.js` asserts agrees with it. An emulator already running on 8085 fails the command with
*"Could not start Firestore Emulator, port taken"*; stop it, or point the
command at another port with `--config`.

*Corrected 2026-09-08 (#9): this used to read `npx firebase emulators:exec …`.
`npx firebase` resolves the `firebase` package — the client SDK — which ships
no such command; the CLI is `firebase-tools`.*

### Running Backend Server Locally
```bash
cd backend
npm start
# Express backend API will listen on http://localhost:8080
```

**`INTERNAL_SECRET` locally:** you do not need to set it. Report generation
authenticates itself to the `/worker/*` routes with this secret, and outside
production the process generates a random one at startup — which works because
the caller and the worker are the same process. You will see one log line
saying so. In production it must be set, and an unset value refuses the
internal path rather than falling back to a known string (#105); Cloud Run
receives it from Secret Manager, provisioned by `infra/add-internal-secret.ps1`
and wired up in `cloudbuild.yaml`.

### Testing the Chrome Extension Locally
1. Open Google Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle switch).
3. Click **Load unpacked** and select the `./extension` directory from this repository.
4. Click **The Hammer** extension icon in Chrome:
   - Go to Options / Settings in the popup.
   - Set **API Base URL** to `http://localhost:8080` for local testing, or
     `https://thehammer-backend-282689937365.northamerica-northeast1.run.app`
     for live cloud testing.

     *Corrected 2026-09-08 (#9): both used to carry an `/api` suffix. No route
     answers that prefix — every call 404'd on a fresh install, which is what
     #26 was about. `normaliseApiBase()` in `extension/service-worker.js` now
     strips a trailing `/api`, so a profile that cached the old value still
     works; the instruction was still teaching people to type it.*

### The extension ID is fixed, and why that matters

Every unpacked copy of this extension gets the **same** ID on every machine:

```
bnlcomhbnaecjjifmlpfilpohejhckmh
```

Chrome derives an extension's ID from its public key, and when a manifest
declares no key it invents one from the **folder path** you loaded from. That
is why the ID used to differ per developer, and why the backend had to keep a
growing list of them: `backend/src/index.js` builds its CORS allowlist from
`EXTENSION_ID`, and `portal/auth-ext.html` checks the sign-in redirect against
the same value, so an unlisted ID has every call refused by CORS — which from
the browser looks nothing like a configuration problem (#31, #36).

`extension/manifest.json` now declares the public key, so the ID is stable.
**After pulling this change, remove and re-load the unpacked extension once**;
its ID changes to the one above and the old per-machine ID stops working.

**Check yours matches.** On `chrome://extensions`, the ID is printed under the
extension's name. If it is not the string above, you are loading a folder whose
`manifest.json` has no `key` — check you pulled, and that you loaded
`./extension` rather than a copy.

### Regenerating the extension key

You should not need to do this. It is written down because the ID is only
stable while the key is, and losing the key means every ID changes at once.

The private key is **not in the repository**. It lives at
`~/.thehammer/thehammer-extension-key.pem` (`.gitignore` covers `*.pem`).
The `key` field in the manifest is the *public* half and is safe to commit.

If the key is ever lost or has to be rotated, generate a new pair and read off
the values it produces:

> ⚠️ **This overwrites any key already at that path, without asking.** If one
> is there, the ID derived from it stops being reproducible the moment it is
> replaced — move it aside first unless you mean to rotate. (Written down
> because it happened while this section was being tested.)

```bash
# From the repository root. Writes the private key and prints what to paste.
node -e "
const crypto=require('crypto'),fs=require('fs'),os=require('os'),path=require('path');
const out=path.join(os.homedir(),'.thehammer','thehammer-extension-key.pem');
fs.mkdirSync(path.dirname(out),{recursive:true});
const {publicKey,privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
fs.writeFileSync(out,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
const der=publicKey.export({type:'spki',format:'der'});
const id=[...crypto.createHash('sha256').update(der).digest('hex').slice(0,32)]
  .map(c=>String.fromCharCode(parseInt(c,16)+0x61)).join('');
console.log('private key :',out);
console.log('manifest key:',der.toString('base64'));
console.log('extension id:',id);
"
```

Chrome's `chrome://extensions` → **Pack extension** produces an equivalent
`.pem`; the command above is preferred only because it prints the derived ID
and the base64 key directly, and needs no GUI.

Then make all four changes together — the first two are the ones that break
the product if they disagree:

1. `extension/manifest.json` — set `"key"` to the printed **manifest key**.
2. `cloudbuild.yaml` — set `_EXTENSION_IDS` to the printed **extension id**.
   Keep it in single quotes, and if a second ID is ever genuinely needed
   separate them with a **space**, never a comma: `gcloud`'s `--set-env-vars`
   splits its own pairs on commas and would truncate the value silently
   (lesson 63).
3. Run `npm run test:extension`. `extension/tests/manifest-key.test.js` derives
   the ID from the manifest and asserts `cloudbuild.yaml` names it, so a
   half-finished rotation fails there rather than in production. **Nothing runs
   this automatically** — Cloud Build's test step and the pre-commit hook both
   run the backend suite only.
4. Commit and push to `client/main`, then approve the build. The new ID only
   reaches the backend and the portal through a deploy; until then the live
   service still trusts the old one.

Finally, remove and re-load the unpacked extension in Chrome, and tell anyone
else testing to do the same — their ID changes too.

**Before publishing to the Chrome Web Store**, note that the Store assigns the
extension its own key and ID on first upload. If that ever happens, the Store's
ID becomes canonical and cannot be changed afterwards: take the key it assigns,
put *that* in `manifest.json`, and redo steps 2–4 with the new ID.


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

**You do not deploy. A push does.** Pushing to `main` of the client remote
fires the `buildme` Cloud Build trigger, which runs the suite, builds both
images, deploys them and smoke-tests — after the project owner approves it
(ADR-0005). AGENTS.md rule 5 is the binding statement: *"Never hand-write or
execute ad-hoc `gcloud run deploy` commands against production, and never
deploy from a developer machine."*

```bash
git push client main     # then approve the build in the Cloud Build console
```

To roll back, roll back — do not deploy. `docs/runbook.md` §1 covers Cloud Run
revision rollback, which needs no build at all.

> *Corrected 2026-09-08 (#9). This section used to offer two ways to deploy by
> hand, and both were wrong:*
> 
> - `infra/deploy.ps1` is retired for production. Its settings have drifted
>   from the pipeline (`--min-instances 0`, `--memory 256Mi`, `API_KEY` via
>   `--set-secrets`), so running it would have quietly changed the service's
>   configuration as well as its image.
> - `gcloud builds submit` bypasses the trigger, and with it the approval gate
>   and the record of which commit was deployed. It also stages a copy of the
>   repository into the project's default bucket — which is how five source
>   archives from June ended up sitting in the **Captures** bucket, still open
>   as #110.

So a deploy that git cannot account for is not merely untidy: this document
was the instruction that produced one.

---

## 5. Repository Structure & Key Files

| Path | Purpose |
| :--- | :--- |
| `backend/src/index.js` | Core Express API router (`/upload-url`, `/capture`, `/session-events`) |
| `backend/src/lib/` | One Source of Truth (OSOT) constants, roles, logger, and vertex setup |
| `backend/tests/` | Jest integration and unit test suite |
| `extension/` | Chrome MV3 Extension (Service worker, popup UI, content script) |
| `portal/` | Admin Web Portal static UI (Nginx container) |
| `infra/deploy.ps1` | **Retired for production** — present, but its settings have drifted from the pipeline. Do not run it against `thehammer` (AGENTS.md rule 5). |
| `cloudbuild.yaml` | Multi-service Cloud Build CI/CD pipeline |
| `docs/megamind.md` | Single-entry OSOT module index |
| `docs/loop_engineering.md` | Architectural inner/outer feedback loop reference |

---

## Need Help?
For architectural references, consult `docs/megamind.md` or `lessons_learned.md` before making structural changes.
