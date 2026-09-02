# Deployment notes

**For:** Chris, testing from a clone of this repository
**Date:** 2 September 2026
**Commit these notes describe:** `40382d7`

---

## 1. Nothing needs pushing — it is already on your `main`

`main` in this repository is at **`40382d7`**, which is every fix through
1 September. It has been the deploy source since 27 August, so there was no
older code to overwrite. Your **`main-backup`** branch (`7f068a2`) is untouched.

The only thing added since you asked is this folder.

---

## 2. Running it locally, without deploying anything

Fastest way to see it work, and it touches no cloud resources.

**Requirements:** Node 22, Java (for the Firestore emulator), and the Firebase
CLI (`npm install -g firebase-tools`).

```bash
# 1. The Firestore emulator — leave this running in its own terminal
firebase emulators:start --only firestore --project demo-hammer

# 2. The four test suites
cd backend && npm install && npm test    # 138 tests
cd ..     && npm run test:portal         #  45
             npm run test:extension      #  76
             npm run test:indexes        #  11
```

All 270 should pass. If the backend suite fails to connect, the emulator is not
running — it is declared on port **8085** in `firebase.json` and is not started
automatically.

The backend also runs standalone (`cd backend && npm start`). In development it
accepts an `x-dev-user-email` header in place of a real sign-in, which is how
the routes can be exercised without Firebase. That shim is disabled whenever
`NODE_ENV=production`.

---

## 3. Deploying into **your** Google Cloud project

`cloudbuild.yaml` uses `$PROJECT_ID` throughout, so images and service accounts
follow whichever project the build runs in. **Four values do not**, and each
needs changing before a deploy into a different project:

| Where | Value now | What it must become |
|---|---|---|
| `cloudbuild.yaml`, `deploy-backend` | `GCS_BUCKET=thehammer-storage-2026` | your bucket |
| `cloudbuild.yaml`, `deploy-backend` | `ADMIN_ORIGIN=https://thehammer-portal-282689937365…` | your portal's URL |
| `cloudbuild.yaml`, `deploy-backend` | `EXTENSION_ID=effbpm… ndmbjl…` | see section 5 |
| `portal/auth-ext.html` | a `firebaseConfig` block | your Firebase project's config |

The region is **`northamerica-northeast1`** in several places. Changing it means
changing all of them together.

**Prerequisites that exist in the current project and would need creating in a
new one:**

- An Artifact Registry repository named `thehammer` in that region.
- Two service accounts: `thehammer-backend@…` and `thehammer-portal-sa@…`.
  The backend one needs Firestore and Cloud Storage access.
- A Firestore database, and a Cloud Storage bucket.
- A Firebase web app, for the sign-in configuration above.

**Firestore indexes are not deployed by the build.** They are in
`firestore.indexes.json` and go up separately:

```bash
firebase deploy --only firestore:indexes --project <your-project>
```

Eleven composite indexes are defined, and a missing one shows up as a query
failing at runtime rather than at deploy time. `npm run test:indexes` checks
that every index the code relies on is declared, but it cannot check they are
actually built in your project.

---

## 4. How a deploy runs today

1. A push to `main` fires the Cloud Build trigger.
2. The build runs the backend suite against a Firestore emulator **inside the
   build**. A failing test stops the build before anything deploys.
3. **The build then waits for a human approval.** This is set on the trigger,
   not in `cloudbuild.yaml`. Cloud Build → History → click the **Build ID** —
   not the Commit link, which navigates to GitHub — → Approve.
4. Backend deploys, its URL is injected into `portal/app.js`, portal deploys.
5. A smoke test calls `/health` on both. A non-200 fails the build, and Cloud
   Run keeps the previous revision serving.

Roughly four to five minutes, most of it the test step.

**Rolling back** is a Cloud Run traffic change rather than a rebuild: pick the
previous revision and send 100% of traffic to it. Revision `00019-xvt` is the
last recorded known-good point, though several deploys have happened since and
the current revision number has not been written down — worth noting one before
you start.

---

## 5. The extension — the part that will catch you out

**Cloud Build does not ship the extension.** It builds and deploys the backend
and the portal only. The extension is loaded unpacked from `extension/` in your
clone, so Chrome keeps running whatever it last read from disk.

Two consequences:

**After changing anything under `extension/`, reload it by hand** —
`chrome://extensions` → the ↻ icon on The Hammer's card. Reloading in place is
safe. This cost us two days of confusion in a fortnight, both times a fix
appearing not to work when it had simply never loaded.

**Your copy will have a different identity from ours.** Chrome derives an
unpacked extension's ID from its folder path, and the backend only accepts
Captures from IDs it has been told about. Loading this repo's `extension/`
folder on your machine produces a third ID, which is not in the list.

The failure is quiet: sign-in works, Captures appear to send, and nothing
arrives. To fix it:

1. Load the extension, and copy the **ID** shown on its card.
2. Add it to the space-separated `EXTENSION_ID` list in `cloudbuild.yaml`.
3. Push, and approve the build.

Then do not move the folder, or the ID changes and you repeat this. That
fragility is tracked as **#36**; the fix is deferred because it also changes the
sign-in redirect address and would break portal sign-in until the OAuth client
is updated in the same window.

---

## 6. Things worth knowing before you judge what you see

- **Dashboard tiles may show `—` instead of numbers**, and the Users table's
  "Last active" may be days out of date. Both look like one cause that has not
  been diagnosed yet. Not filed, mentioned in *What remains*.
- **The Projects table's "Last capture" is always `—`** (#62). Use Activity.
- **A blocked Capture usually says "set Project & save first"** whatever the
  real reason (#72). Two of those messages are actively untrue — one of them
  means the Capture was safely queued.
- **Invitations are created but never emailed** (#35). The code is written to
  the Cloud Run log and has to be passed on by hand.
- **An export holds at most 50 Captures.** Filter by Tool and export each
  section; the on-screen message now says so.

---

## 7. If something looks broken

The single most useful thing is the **service worker console**:
`chrome://extensions` → The Hammer → **service worker**. Three faults this
month were found there and one was wrongly closed for want of reading it.

Two checks that beat guessing, in order — and both before re-typing anything,
because re-typing destroys the evidence:

```js
// What the next Capture will actually send:
chrome.storage.local.get('session').then(r => console.log(JSON.stringify(r)))
```

And the object path in the Activity **PATH** column: it ends
`..._<tool>_<4 hex>.png`. A missing tool segment means the server received an
empty Tool, which is faster and more reliable than reading the TOOL column.

For the portal, a stale `app.js` has now caused two false alarms. To check the
tab is running current code rather than a cached script:

```js
exportProjectCaptures.toString().includes('activityToolFilter')
```

`false` means press F5.
