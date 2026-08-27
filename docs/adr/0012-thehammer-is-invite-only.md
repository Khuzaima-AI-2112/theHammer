# theHammer is invite-only

Nobody could sign in, and the reason was not the portal. The live `users`
collection was empty and every route that writes to it was guarded by a
middleware that required a record to already be there. `POST /admin/workspaces`
sets `role: 'admin'` on its caller and is the intended path to the first
administrator; `POST /admin/workspaces/join` is how an invited person gets a
record. Both carried comments saying they were for users who had just signed up,
and both sat behind `requireAuth('user')`, which returns `403 not provisioned`
to exactly that person. The collection had no way to gain a first record, and
invitations could never be accepted. That is #33.

Fixing it forces a question the repository had never answered: **who is allowed
to become a user of theHammer?** Nothing in ADR 0001 to 0011 says. It had never
come up, because sign-in had never worked well enough for it to matter.

## The decision

**Membership is by invitation. There is no self-serve signup.**

An existing administrator issues an invitation to a named email address. The
invited person signs in with Google and accepts it, and that is what creates
their `users` record. The invitation is the authorisation: it is issued by an
administrator of the workspace, matched against the caller's own verified email,
single-use, and expiring.

The first administrator is the one person who cannot be invited, because there
is nobody to invite them. That case, and only that case, is handled by an
environment variable on the backend service:

```
BOOTSTRAP_ADMIN_EMAIL=<the founding administrator's address>
```

`POST /admin/workspaces` accepts a verified Firebase token whose email matches
that variable, and refuses everyone else. **Unset means nobody**, which is the
correct posture for a deployment that already has its administrator.

Both routes now use a new `requireFirebaseUser` middleware, which verifies the
token and stops there. It sets `req.firebaseUser` rather than `req.hammerUser`,
because there is no Hammer user yet and a half-populated one would be read
downstream as a provisioned account with no role. Every other route keeps
`requireAuth` exactly as it was.

## Consequences

- A provisioned user who is not the bootstrap address can no longer create a
  workspace. Under the previous guard they could, and would have become its
  administrator. That capability is withdrawn deliberately: workspaces are not
  something users make for themselves.
- `BOOTSTRAP_ADMIN_EMAIL` is a live credential of a sort — anyone who can set
  environment variables on the backend service can name themselves the founding
  administrator. That is already true of anyone with deploy access, so it adds
  no privilege that did not exist, but it belongs in the same mental category as
  the service account keys.
- The invitation flow has never run in production. It is now reachable for the
  first time, and `POST /admin/workspaces/invites` still only logs the token
  rather than emailing it (`workspaces.js`, marked `TODO`). Delivering
  invitations is a separate piece of work.
- Nothing here changes who may be captured or what is stored. ADR 0001 still
  makes the Customer the data controller.

## Considered options

**Self-serve signup** — anyone with a Google account creates their own workspace
and becomes its administrator. This is what the unguarded route would have done
and it is the least code. Rejected because theHammer is an internal product for
a known set of people, as ADR 0011 records in another context, and a public
endpoint that mints administrators is a liability for a system whose whole
purpose is capturing screens. Nothing about the product asks for it.

**A seed script run with a service-account key** — write the first record
directly into Firestore with the Admin SDK, bypassing HTTP entirely. Genuinely
safer in one respect: it touches no request path, so the tested `403 not
provisioned` behaviour could not regress. Rejected for two reasons. It requires
downloading a long-lived private key to a laptop, which is a worse credential
than an environment variable on a service. And it fixes only the first
administrator: `POST /admin/workspaces/join` would still be unreachable, so
invitations would remain permanently broken and every later user would have to
be added by hand as well. That is treating the symptom.

**First-run-only, allowing workspace creation while the collection is empty** —
self-closing and needs no configuration. Rejected as too implicit: it makes the
security of the endpoint depend on a race, and it gives no way to bootstrap
again if the database is ever rebuilt. The environment variable says out loud
who is allowed to do this.
