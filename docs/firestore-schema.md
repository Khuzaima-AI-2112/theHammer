# The Hammer — Firestore Schema (Sprint 5, schemaVersion: 1)

> Architecture decision: **flat top-level collections** (Final Call 2A in `arch_decisions.md`).  
> Every cross-project document carries a `projectId` field. No subcollections. All new doc types include `schemaVersion: 1`.

---

## Collections

### `projects`

One document per project created by an admin.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Auto-generated Firestore doc ID |
| `name` | string | Display name, max 128 chars |
| `adminId` | string | `users` doc ID of creating admin |
| `memberCount` | number | Maintained by Firestore transaction on member add/remove |
| `createdAt` | string | ISO 8601 timestamp |
| `updatedAt` | string | ISO 8601 timestamp; set on every PATCH |
| `schemaVersion` | number | Always `1` |

**Example documents:**

```json
{
  "id": "proj_abc123",
  "name": "Acme Q3 GTM Audit",
  "adminId": "usr_zyx987",
  "memberCount": 3,
  "createdAt": "2026-06-16T14:00:00.000Z",
  "updatedAt": "2026-06-16T15:30:00.000Z",
  "schemaVersion": 1
}
```

```json
{
  "id": "proj_def456",
  "name": "Beta Launch Onboarding",
  "adminId": "usr_zyx987",
  "memberCount": 1,
  "createdAt": "2026-06-10T09:00:00.000Z",
  "updatedAt": "2026-06-10T09:00:00.000Z",
  "schemaVersion": 1
}
```

```json
{
  "id": "proj_ghi789",
  "name": "Enterprise Pilot — EMEA",
  "adminId": "usr_zyx987",
  "memberCount": 0,
  "createdAt": "2026-06-15T11:00:00.000Z",
  "updatedAt": "2026-06-15T11:00:00.000Z",
  "schemaVersion": 1
}
```

---

### `users`

One document per provisioned user (created by admin via portal).

| Field | Type | Notes |
|---|---|---|
| `id` | string | Auto-generated Firestore doc ID |
| `email` | string | Google account email (matches IAP `X-Goog-Authenticated-User-Email` sans prefix) |
| `role` | string | `admin` \| `analyst` \| `instructional_designer` \| `user` |
| `createdAt` | string | ISO 8601 timestamp |
| `createdBy` | string | `users` doc ID of admin who provisioned this user |
| `schemaVersion` | number | Always `1` |

**Example documents:**

```json
{
  "id": "usr_zyx987",
  "email": "alice@example.com",
  "role": "admin",
  "createdAt": "2026-06-01T08:00:00.000Z",
  "createdBy": "usr_zyx987",
  "schemaVersion": 1
}
```

```json
{
  "id": "usr_bob111",
  "email": "bob@example.com",
  "role": "analyst",
  "createdAt": "2026-06-10T10:00:00.000Z",
  "createdBy": "usr_zyx987",
  "schemaVersion": 1
}
```

```json
{
  "id": "usr_carol222",
  "email": "carol@example.com",
  "role": "user",
  "createdAt": "2026-06-12T14:00:00.000Z",
  "createdBy": "usr_zyx987",
  "schemaVersion": 1
}
```

---

### `project_memberships`

Join table between `projects` and `users`. Written atomically with `project.memberCount` increment (Firestore transaction, task 5.6).

| Field | Type | Notes |
|---|---|---|
| `id` | string | `{projectId}_{userId}` — deterministic, prevents duplicate membership |
| `projectId` | string | Foreign key to `projects` |
| `userId` | string | Foreign key to `users` |
| `role` | string | Role within this project (mirrors `users.role` at admission time; can diverge) |
| `admittedAt` | string | ISO 8601 timestamp |
| `admittedBy` | string | `users` doc ID of admin who ran `POST /admin/projects/:id/members` |
| `schemaVersion` | number | Always `1` |

**Example documents:**

```json
{
  "id": "proj_abc123_usr_bob111",
  "projectId": "proj_abc123",
  "userId": "usr_bob111",
  "role": "analyst",
  "admittedAt": "2026-06-16T14:05:00.000Z",
  "admittedBy": "usr_zyx987",
  "schemaVersion": 1
}
```

```json
{
  "id": "proj_abc123_usr_carol222",
  "projectId": "proj_abc123",
  "userId": "usr_carol222",
  "role": "user",
  "admittedAt": "2026-06-16T14:06:00.000Z",
  "admittedBy": "usr_zyx987",
  "schemaVersion": 1
}
```

```json
{
  "id": "proj_def456_usr_carol222",
  "projectId": "proj_def456",
  "userId": "usr_carol222",
  "role": "user",
  "admittedAt": "2026-06-16T15:00:00.000Z",
  "admittedBy": "usr_zyx987",
  "schemaVersion": 1
}
```

---

### `uploads` (existing — confirmed flat, no subcollections)

Core capture record written by `POST /capture`. Established in Sprint 4.  
`schemaVersion: 1` added to all new docs written from Sprint 5 onward (existing docs without it are grandfathered).

| Field | Type | Notes |
|---|---|---|
| `path` | string | GCS object path |
| `bucket` | string | GCS bucket name |
| `size` | number | File size in bytes |
| `projectId` | string | Foreign key to `projects` |
| `userId` | string | Foreign key to `users` |
| `tool` | string | Extension tool name (e.g. `"gtm"`, `"ga4"`) |
| `tabUrl` | string | Captured tab URL (max 500 chars) |
| `uploadedAt` | string | ISO 8601 timestamp |
| `sessionId` | string | Links to `session_events` doc (added Sprint 6) |
| `schemaVersion` | number | `1` on all docs written from Sprint 5 onward |

**Composite indexes** (declared in `infra/firestore.indexes.json`):
- `(projectId ASC, tool ASC, uploadedAt DESC)` — powers `GET /admin/projects/:id/activity?tool=`
- `(projectId ASC, userId ASC, uploadedAt DESC)` — powers Sprint 6 inactivity gap detection

---

## `firestore.indexes.json` location

`infra/firestore.indexes.json` — deployed via `firebase deploy --only firestore:indexes` in GitHub Actions.
