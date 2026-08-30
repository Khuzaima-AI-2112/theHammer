# The Hammer

A Chrome extension and backend that let a person capture screenshots of their
work, and let their employer see progress and time across projects. This
glossary fixes the words the project uses for the people, the data, and the
disclosure obligations around both.

## Language

**Capture**:
A single screenshot that a Monitored User explicitly takes. theHammer never
records continuously — every image exists because someone pressed the button.
_Avoid_: recording, screen grab, snapshot, screenshot event

**Session**:
One continuous period of work by one Monitored User against one Project.
_Avoid_: shift, run, work block

**Project**:
One named body of work inside a Workspace. It is what a Capture is filed
under, what a Session belongs to, and what progress is reported against.
_Avoid_: job, client, account, workstream, board

**Workspace**:
One Customer organisation's isolated tenant. It is the boundary for data
isolation and for legal responsibility: everything inside one Workspace belongs
to one Customer.
_Avoid_: account, tenant, org, company, team

**Customer**:
The organisation that pays for a Workspace and employs its Monitored Users. The
Customer decides that monitoring happens and is responsible for telling its
staff.
_Avoid_: client, account, company, user

**Monitored User**:
The person whose screen is captured and whose working time is measured. Almost
always an employee of the Customer.
_Avoid_: employee, subject, end user, worker, user

**Disclosure**:
The screen that tells a Monitored User what theHammer collects, before any
Capture is possible. It states facts; it does not ask permission.
_Avoid_: consent prompt, consent screen, agreement, EULA

**Acknowledgement**:
A Monitored User's recorded confirmation that they have seen the Disclosure.
It is not consent: a Monitored User cannot decline it and keep using theHammer.
_Avoid_: consent, agreement, opt-in, acceptance

**Restricted Mode**:
The state a newly installed extension is in until an Acknowledgement is
recorded. Captures are unavailable.
_Avoid_: trial mode, limited mode, unregistered mode

**Configured Retention**:
The period an Admin sets for how long their Workspace keeps Captures.
_Avoid_: retention (ambiguous on its own)

**Storage Lifetime**:
The maximum period the storage bucket keeps any object, regardless of
Configured Retention. It is a hard ceiling, not a preference.
_Avoid_: retention, TTL, expiry

**Active Ratio**:
The proportion of a Session during which the Monitored User's device was
active, as opposed to idle or locked.
_Avoid_: productivity score, efficiency score, utilisation

**Disclosure Version**:
The identifier of the Disclosure text a Monitored User acknowledged. A material
change to what is collected produces a new version and re-prompts.
_Avoid_: consent version, terms version, revision

**Persona**:
The part a Monitored User works in when a Capture is made. It is a part, not
a person: one Monitored User can work in several, and the part may be one they
hold in reality or one they adopt to demonstrate somebody else’s product. It
labels work and controls nothing — unlike the portal’s Role, which controls
what a person may do and labels nothing.
_Avoid_: role, user type, actor, character, profile

**Storyboard**:
An ordered set of Captures, with a note against each one, that demonstrates
a single workflow. A Session measures time; a Storyboard tells a story. The
two do not have to agree.
_Avoid_: sequence, slideshow, deck, reel, walkthrough
