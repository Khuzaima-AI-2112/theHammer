# Sprint 20 — Multi-Tenancy, Billing, and Project-Based Access Control

**Goal:** Transform the platform into a B2B SaaS product where a paying Admin can create a Workspace, invite team members, and restrict access via Projects.

## Scope

This sprint transitions the system from a single-tenant environment to a true multi-tenant SaaS architecture. It introduces Workspaces (Organizations) tied to billing, and refines Role-Based Access Control (RBAC) so that regular users and instructional designers are grouped and restricted by Project.

### 1. Workspaces (Tenants) & Sign-up
- **Workspace Entity:** A new `workspaces` collection. A Workspace represents a single paying customer's environment.
- **Admin Sign-up:** The initial Admin signs up, provisions a new Workspace, and establishes the billing relationship (e.g., via Stripe integration).
- **Tenant Isolation:** All `projects`, `uploads`, `api_keys`, and `reports` must be associated with a specific `workspaceId`. Firestore security rules and backend middleware must strictly enforce tenant isolation so data never leaks across Workspaces.

### 2. User Invitations & Roles
- **Workspace Memberships:** Admins can invite other Admins, Regular Users, and Instructional Designers to join their Workspace.
- **Role Scopes:**
  - **Admins:** Have global visibility over the entire Workspace. They can create projects, invite users, assign users to projects, and manage billing.
  - **Regular Users & Instructional Designers:** Have limited visibility. They can only see and interact with the specific Projects they are explicitly assigned to.

### 3. Project-Based Access Control (Grouping)
- **Project Assignment:** Instead of a generic "Groups" feature, **Projects** serve as the boundary for grouping users. Admins assign users to specific Projects to grant them access.
- **Data Silos:** A Regular User uploading a screenshot, or an Instructional Designer creating a storyboard, must do so within the context of an assigned Project. They cannot view activity, assets, or reports from Projects they do not have access to.

## Proposed Implementation Plan

### Phase 1: Data Model & Middleware Migration
- Introduce `workspaces` collection: `{ workspaceId, name, billingStatus, ownerId, createdAt }`.
- Update existing collections (`projects`, `users`, `api_keys`, `uploads`, `session_events`, `inactivity_events`, `reports`) to enforce a `workspaceId` foreign key.
- Update `backend/src/middleware` to resolve the `workspaceId` from the authenticated user or API key, and automatically scope all queries to that workspace.
- Write a data migration script to move existing single-tenant data into a default initial Workspace.

### Phase 2: Sign-up & Billing Infrastructure
- Implement the Admin self-serve sign-up flow in the Admin Portal.
- Integrate a billing provider (e.g., Stripe Checkout) to activate the Workspace upon successful payment.
- Add a "Billing & Subscription" settings panel for Admins to manage seats, upgrade/downgrade, and view invoices.

### Phase 3: Invitation System & Roster Management
- **Invitations:** Create a flow where Admins invite users via email, assigning them a global Workspace role (`admin`, `user`, `instructional_designer`, `analyst`).
- **Project Rosters:** Update the Admin Portal UI so Admins can explicitly add Workspace members to specific Projects.
- **Access Enforcement:** Ensure API endpoints (e.g., `GET /admin/projects/:id/activity`) strictly validate that the requesting user is either an Admin or explicitly in the `project_memberships` subcollection for that Project.

### Phase 4: End-User Experience Updates
- **Portal & Extension Views:** When a non-Admin accesses the portal or the browser extension, `GET /me/projects` must only return their assigned Projects.
- **Upload Guards:** The capture endpoints (`/capture`, `/upload-url`) must verify that the user has write access to the requested `projectId` before accepting the upload.
