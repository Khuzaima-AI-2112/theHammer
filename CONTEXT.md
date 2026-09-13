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

**Abandoned Upload**:
An attempt at a Capture that never produced an image. The Monitored User's
intent is recorded, but no screenshot was ever stored, so there is nothing to
look at, export or report on. It is not a Capture and never becomes one, and
removing one costs nothing.
_Avoid_: failed capture, empty capture, partial upload, orphan

**Last capture**:
When a Project was last worked in — the time of the most recent row in
`uploads` filed under it, denormalised onto the Project as `lastCaptureAt`
(#62). It times the *record*, not the image: `/upload-url` writes the row
before the bytes are PUT and nothing reports back when they land, so an
Abandoned Upload dates a Project just as a Capture does. This is the same
population `captureCount` reports (#116), and for the same reason — only the
presence of the object in Cloud Storage tells the two apart, and neither the
column nor the count pays a bucket read to find out.
_Avoid_: last activity, last seen, last upload

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

**Storage Lifetime**:
The maximum period the storage bucket keeps any object, whatever else the
system says. It is a hard ceiling, not a preference.
_Avoid_: retention, TTL, expiry

**Purge**:
The complete removal of a Project and everything filed under it — its Captures
and their images, its Sessions, Storyboards and Reports — at an Admin's
request. Storage Lifetime is about time; a Purge is about intent, and does not
wait.
_Avoid_: delete, wipe, cascade, cleanup, archive

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
It is not a Stage: a Stage is a phase of the work, and never names the part
being played.

**Stage**:
The phase of the work a Capture was taken in: Beginning, During or After, and
nothing else. It says *when* in a piece of work the screen was seen, never
*who* was working or *which* piece of work it was. It does not carry the
Persona, and nothing may head or group a Storyboard by Stage as though it did.
_Avoid_: persona, step, milestone, section

**Tool**:
The product a Capture is *of* — the software whose screens the Monitored User
is working in, such as Softomedia or theHammer's own portal. It names what is
on the screen, not what the Monitored User is doing there or which run of work
this is. Production rows carry workflow-shaped values
(`04-Retailer_workflow_captures`, `TEST-verify-1`); that is drift, and a
workflow is a Workflow within a Storyboard. Nothing may group Captures by Tool
as though it named a run of work.
_Avoid_: app, target, workflow, run, batch, stage

**Storyboard**:
An ordered set of Captures, with a note against each one, that tells one
story, divided into one or more Workflows. A Session measures time; a
Storyboard tells a story. The two do not have to agree.
_Avoid_: sequence, slideshow, deck, reel, walkthrough

**Workflow**:
One named piece of work demonstrated within a Storyboard, such as "Super
Admin". It is a name chosen by whoever curates the Storyboard, and it belongs
to the Storyboard, not to the Captures in it: a Capture has no Workflow until
a Storyboard gives it one. It is not a Persona, though its name often is one,
and it is not a Stage.
_Avoid_: section, walk, walkthrough, chapter, persona, group

**Report**:
An artifact generated from a Project's Captures — a set of metrics, an OCR
pass, or a Storyboard — that is requested, queued and waited for. It has a
status and outlives the request that asked for it, which is what separates it
from an Export.
_Avoid_: export, summary, analysis, job

**Export**:
A file an Admin downloads of a Project's Captures. It is produced and returned
by the request that asks for it; there is no Export record, no status and
nothing to queue. A Report is generated and waited for — an Export is not.
_Avoid_: report, job, download job, batch
