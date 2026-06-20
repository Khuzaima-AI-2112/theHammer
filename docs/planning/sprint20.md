# Sprint 20 — Groups and User Organization

**Goal:** Allow admins to organize users and other admins into Groups.

## Scope

This sprint will introduce a net-new "Groups" entity to the platform to organize users.

### Requirements to Clarify Before Development
Before beginning work on this sprint, the following questions need to be resolved and the data model designed:
1. Should "Groups" be a completely new entity (e.g. a `groups` collection)? Or are you looking to rename the existing `projects` feature to `groups`?
2. If it is a new entity, what is the relationship between Groups and Projects? Do Projects belong to Groups?
3. Does assigning an admin to a Group automatically give them admin rights over all Users in that Group?

### Proposed Features
- Create/Read/Update/Delete (CRUD) for Groups in the Admin Portal.
- Ability to assign Users and Admins to Groups.
- Role-based Access Control (RBAC) adjustments based on group membership.
