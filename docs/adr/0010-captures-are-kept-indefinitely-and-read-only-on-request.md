# Captures are kept indefinitely, and AI reads them only when a report is asked for

> **Scope, added 2026-09-07.** "Kept indefinitely" is a rule about *time*:
> nothing expires on its own. It does not mean a Project's Captures survive the
> Customer deliberately deleting the Project — that is a **Purge**, and it is
> decided in ADR 0015. Retention is about time; a Purge is about intent.

theHammer is no longer sold to anyone and is run by two people on their own
machines (ADR 0008). That removed the audience whose interests most of the
content rules were written to protect, and left a different question: what
should the tool do with what it captures, now that the only people it captures
are the two running it. The Customer answered on 2026-08-25, in
`deliverables\to-questionnaire-what-still-need-answering.md`.

## Captures are kept for as long as they are wanted

**There is no storage lifetime.** Asked whether deleting screenshots after 90
days was right, the answer was *"NO, keep infinitely."*

Three different numbers are in the code today, and the one that actually runs is
the one nobody chose:

| Where | Value | Effect |
|---|---|---|
| `infra/lifecycle.json`, applied to `gs://thehammer-screenshots` | delete at **90 days** | the only one that does anything |
| `backend/src/lib/defaults.js` | `retentionDays: 365` | reported to the extension, then ignored |
| The popup's retention field | up to **3650** | suggests ten years is available |

The bucket deletes at 90 days regardless of what the application says, so a
person reading the settings is told something untrue. Tracked as a defect
separately; this record is the decision, not the repair.

## AI reads a Capture only when a report is generated

**Reading is off unless it is asked for.** The Customer's words: *"this is OFF
unless activated through generation of analytics, reports or gifs/video"*, and
separately that the primary purpose of a Capture is *"storage and retrieval"* —
screenshots go to Google's AI when a project or a day is analysed, not when a
screenshot is taken.

That is already how the code behaves. `backend/src/worker/reportsWorker.js` is
the only live `generateContent` call, and it runs at report time; the
per-Capture call in `backend/src/worker/ocrWorker.js` is commented out. Nothing
needs building. It is written down here so that nobody later adds per-Capture
OCR believing it to be an obvious improvement — it would reverse a decision the
owner has taken.

**One thing this does not cover, and the owner knows it.** Every Capture still
extracts form fields, control labels and any selected text from the page
(`EXTRACT_SEMANTIC_DATA` in `extension/content.js`) and stores that alongside
the image. That is not AI reading, but it is content leaving the page, and it
happens on every Capture regardless of this decision.

## Running it over other people's material is intended

Asked whether either of them would ever run it while working on something
belonging to someone else — the exposure this arrangement creates, since that
person agreed to nothing — the answer was that it is **the point**, not a
hazard: *"This is not a bug. It's a feature."* The named uses are capturing
Google Ads and GA4 settings, the output of scripts for comparison, and personal
workflows.

So no restriction is designed against it, and the offer to build a per-machine
switch for AI reading was declined as unnecessary — reading is already off
until a report is asked for, which covers it.

## Considered options

**Keeping the 90-day deletion and correcting the interface to match** was the
cheaper repair, and the one proposed. Rejected: the Customer wants the archive.
Note the consequence, which is real and ongoing — storage cost now grows without
bound, on a project the Customer pays for, and nothing in the system will ever
reclaim it.

**A per-machine switch for AI reading** was offered while question 2 was open,
on the reading that third-party material was an exposure to be contained. It is
not being built. If that reading ever returns, the switch is a small piece of
work and this is where to start.
