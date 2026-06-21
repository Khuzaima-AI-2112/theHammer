# Sprint 23 — Transition to Firebase Authentication

**Goal:** Replace the current Google Cloud IAP and API Key auth mechanisms with Firebase Authentication to enable a true multi-user, publicly signable SaaS platform.

## Scope

Currently, the application relies on Google Cloud IAP for Admin Portal access (which requires users to be added via GCP IAM) and API Keys for the browser extension. This sprint transitions the platform to **Firebase Authentication**, allowing independent user sign-ups, team invitations, and robust identity verification across both the Portal and the Extension.

### 1. Implement Firebase Authentication
- **Admin Portal Integration:** Integrate the Firebase Auth JS SDK into the Admin Portal SPA. Replace the Cloud IAP login flow with a custom Login/Sign-up page supporting Email/Password and Google OAuth.
- **Extension Integration:** Update the browser extension to support Firebase Auth. Users can log in directly from the extension popup, eliminating the need for manual API Key generation and pasting.
- **Backend Verification:** Update the `hammer-api` Express middleware. Instead of reading the `X-Goog-Authenticated-User-Email` header from Cloud IAP or verifying an `X-Api-Key`, the backend will now expect a Firebase ID Token in the `Authorization: Bearer <token>` header. The middleware will verify this token using `firebase-admin/auth`.

### 2. The "Admin Sign-up" Flow
- **Self-Serve Registration:** A customer (the Admin) visits the portal and signs up using Firebase Auth.
- **Workspace Provisioning:** Upon successful registration (typically handled via a Firebase Auth onCreate trigger or a direct API call), the backend provisions a new `workspaces` document in Firestore.
- **Owner Mapping:** The Admin's new Firebase UID is mapped as the Owner of this new workspace, linking their identity directly to their billing and organizational silo.

### 3. The "Invite" Flow
- **Sending Invitations:** In the Admin Portal, the Admin can input email addresses to invite testers, Regular Users, or Instructional Designers. The backend creates a pending `invitations` document in Firestore and sends an invitation email.
- **Claiming Invitations:** The invitee clicks the link in the email, which directs them to a sign-up page. They register via Firebase Auth.
- **Role Assignment:** Once the invitee registers, the backend consumes the invitation token, automatically adds their new Firebase UID to the Admin's `workspaces` environment, and assigns them their designated role (e.g., `instructional_designer`).

### 4. Enforcing Access (RBAC)
- **Middleware Updates:** Every API request includes the Firebase ID Token. The backend decodes the token to get the user's UID, then queries Firestore to determine which `workspaceId` and `projectId` the UID belongs to. 
- **Strict Boundaries:** The backend actively rejects any request (HTTP 403) to read, upload, or modify data that falls outside of the user's authorized Workspaces and Projects.
- **Firestore Security Rules:** Update `firestore.rules` to enforce these boundaries at the database level. Rules will use `request.auth.uid` to ensure users can only query documents that match their assigned Workspace and Project permissions.
