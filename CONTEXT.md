# The Hammer

A Chrome extension and backend that two people use from their own machines to
take Captures of their own work, see progress and time across Projects, and
curate Captures of another company's Tool into Storyboards the model narrates.
This glossary fixes the words the project uses for the people and the data.

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
The isolated space that Projects are filed in. It is the boundary for data
isolation: nothing inside one Workspace can be reached from another.
_Avoid_: account, tenant, org, company, team

**Customer**:
The person who commissioned theHammer, and one of its Monitored Users.
_Avoid_: client, account, company, user

**Monitored User**:
A person who has agreed to theHammer capturing their screen and measuring their
working time. There are two, and nobody else is a Monitored User.
_Avoid_: employee, subject, end user, worker, user

**Purge**:
The complete removal of a Project and everything filed under it — its Captures
and their images, its Sessions, Storyboards and Reports — at an Admin's
request. Nothing expires on its own; a Purge is about intent, and does not
wait.
_Avoid_: delete, wipe, cascade, cleanup, archive

**Active Ratio**:
The proportion of a Session during which the Monitored User's device was
active, as opposed to idle or locked.
_Avoid_: productivity score, efficiency score, utilisation

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

**Caption**:
The words about what one Capture in a Storyboard shows. The model writes it,
and an Analyst may correct it or write one where none exists, but never blank
it. It stays a Caption whoever last wrote it, and generating the Storyboard's
narrative again replaces every Caption, corrected ones included.
_Avoid_: description, label, slide text, note
It is not a Note: a Caption says what is on the screen, a Note says what the
Analyst makes of it.

**Note**:
The Analyst's own remark against one Capture in a Storyboard. It is never
generated, and generating the narrative again never touches it.
_Avoid_: comment, annotation, caption

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

## Retired terms

Words the project used for things theHammer no longer has. They are not in use.

- **Disclosure**, **Acknowledgement**, **Restricted Mode**, **Disclosure
  Version**: there is no Disclosure screen (ADR 0011).
- **Storage Lifetime**: nothing expires on its own; Captures are kept
  indefinitely (ADR 0010).
