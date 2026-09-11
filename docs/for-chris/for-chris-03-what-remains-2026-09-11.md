# theHammer — what remains to be built and fixed

**Date:** 11 September 2026
**Replaces:** [the 1 September edition](for-chris-03-what-remains-2026-09-01.md)


## 1. Things you will notice yourself

### Invitations are still never sent (#35)

Unchanged, and still the top of this list for the same reason: **it is the only
item that stops you doing something without us.** The Portal reports success,
no email goes out, and the code has to be read out of a server log and passed to
you by hand. The code is also still stored and logged in plain text, which
should be fixed in the same change.

**Cost:** you cannot onboard anyone — including yourself onto a new address —
without waiting for a code to be passed to you by hand.

### You cannot correct a caption (#123)

You can edit the Storyboard's opening summary — that box exists and your edit is
what lands in the PDF. **You cannot edit the 66 individual captions.** If the AI
says something wrong about one screenshot, your only options are to regenerate
everything or to accept it.

**Cost:** real, on a document you intend to hand to a client. It is the one part
of the deliverable you cannot correct.

This was a known consequence of the design rather than an oversight, and it is
recorded, but it is the gap we would expect you to hit first in real use.

### A large Storyboard may hang rather than fail (#122)

Finalizing your 66-Capture run takes between one and three minutes. The server
cuts a request off at five minutes. A Storyboard roughly twice the size would
exceed that.

**The failure shape is the bad one:** no report appears, no error is recorded,
and the page simply polls forever. Nothing tells you it has gone wrong.

**Cost:** low today, certain later. The cause is that screenshots are fetched
one at a time; fetching them several at a time is the cheap fix and needs no new
infrastructure.

### The Storyboard's section headings all read "Beginning" (#126)

Covered in document 01. The PDF groups frames into sections and heads each one,
but it reads the Capture's *Stage* field, and every Capture in your run has
Stage set to `beginning`. Your six persona walks went into the **Tool** box.

**Cost:** you get one section across eleven pages instead of six named walks.
The document is still correct and readable; it is just not doing the grouping
the layout exists for.

**This needs your decision, not a quick fix** — see section 2.

*Related and smaller:* a few frames are labelled with a long, truncated web
address. Those are Captures taken on the Portal's own front page, which has no
page path to show, so the label falls back to the server name. We can make it
show the Tool name instead — say the word.

---

## 2. Decisions waiting on you

### Where does a persona walk get recorded? (#126, #74)

The heart of the previous item, and worth your thinking rather than ours.

theHammer has a **Stage** box offering *Beginning*, *During*, *After* — a
workflow phase. It also has a **Tool** box for naming the software on screen.
Your operator recorded the persona walks in Tool
(`01-Super_Admin_storyboard`, `05-TechOpWorkflowCaptures`, and so on), which is
a sensible thing to have done given the boxes available, but it means the
walk is filed under "which software is this" rather than "which walk is this".

**Grouping by Tool instead is not the answer.** Two of the eight values in your
run are `TEST-verify-1` and `Test-again`, and neither belongs as a heading in a
client document.

**The real question:** should theHammer have a place to record which persona
walk a Capture belongs to? Our view is yes, and that it belongs on the Capture
rather than being inferred. But it is a product change and it is yours to call.

### How much of the hand-built Storyboard should we reproduce? (#84)

Your document had **19 pages and 52 images**. We now produce the part that
matters most — the numbered frames, six to a page, each with prose. Three things
in yours we have deliberately **not** built:

- **The evidence pages** — a zoomed crop of one frame with longer analysis
  beside it. Ten of your 52 images. Some of the best pages in the document.
  Nothing in the product currently asks which frames deserve one.
- **The Coverage page** — 35 features scored against a spec. We do not have the
  spec, and theHammer does not record severity.
- **Method and Recommendations pages.**

**Worth deciding once you have generated one yourself** and can compare it
against your hand-built version side by side. That comparison is the most useful
thing you could send us this month.

### Date ranges on reports (#95)

A date range is threaded through the reports machinery but has no defined
meaning and is never read. Either it should filter, or it should come out.
Cheap either way; needs to know which you want.

---

## 3. Correctness and security work

Not visible, and where an unpleasant surprise would come from.

- **Sign-out is still not immediate (#18).** A revoked account can keep working
  for up to an hour. Unchanged since 1 September, and **still the thing to fix
  before anyone outside your team uses this.**
- **The capture loop has no automated coverage (#5, #6, #20).** The extension's
  most important code — taking a screenshot and getting it to the server — is
  tested by hand only. What happens when a connection drops mid-upload is not
  automatically tested. Given that two of this month's worst faults were in
  exactly this path and both were invisible, this is the coverage we would buy
  next after #35.
- **The snip overlay was merged untested (#28)** and wants a hand-check in a
  browser.
- **The build cannot use a reproducible install (#118),** because a file it
  depends on was generated on Windows. A paperwork-shaped problem with a real
  consequence: builds are not exactly repeatable.
- **Old build archives are accumulating in the Captures bucket (#110).** Costs
  pennies; untidy, and it puts non-Capture files somewhere a Purge reasons about.

---

## 4. Internal tidying

Real work, no customer impact, listed for completeness: **#19** (a storage
client built at the wrong moment), **#10** (an unused dependency and duplicate
database indexes), **#21**, **#37**, **#50**, **#64** and **#74** (writing down
what our own words mean — the second of these has now caused two genuine
mistakes, including #126).

---

## 5. Recently finished, awaiting closure in the tracker

Complete and in production, not yet marked closed: **#121** (the PDF printed raw
formatting characters), **#123** (the narrative sat in front of the slides
rather than around them) and **#125** (six frames to a page). Mentioned so the
open count here matches what you see if you look at the tracker yourself.

