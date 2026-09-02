# theHammer — what is built, and what was fixed

**Date:** 1 September 2026

---

## The short version

theHammer records **Captures** — screenshots taken while somebody works —
labelled so you can tell later who took them, on whose work, and in which tool.
It is a Chrome extension for taking them and a web Portal for reading them back
and downloading them.

It works end to end today. A capture run of about fifty screenshots was taken
with it on 31 August, and those screenshots are in storage, listed in the
Portal, and downloadable as a ZIP.

**theHammer produces Captures. It does not produce the Storyboard.** The
Storyboard PDF is assembled by hand from the exported pictures. That was a
deliberate decision, not a gap — see *What remains*, section 4.

---

## 1. The three words that matter

Everything below uses these, and they are worth two minutes because two of them
have already been mixed up once.

**Project** — whose work a Capture belongs to. In the Softomedia run there is
one Project per Persona.

**Persona** — the part a Monitored User is working in when the Capture is made.
Either a part they genuinely hold, or one adopted to demonstrate somebody
else's product. Your Google Ads example broke our first definition and this is
the corrected one.

**Tool** — which software is on screen. Free text, typed by the person
capturing.

**Stage** — where in a walkthrough the Capture falls: **Beginning**, **During**
or **After**. It is a workflow phase and nothing else.

*This last one caused a real mistake.* An internal instruction told the operator
to put the Persona in the Stage box. Stage only accepts those three values, so
it could not have worked. The Persona is carried by the Project. Writing the
definition down is an open item (#74).

---

## 2. What exists

### The Chrome extension

- **Pick a Project, a Stage and a Tool**, which then label every Capture.
- **Three ways to capture:** the whole visible page, a region you drag out
  (Snip), or a keyboard shortcut (`Ctrl+Shift+S`). There is also a right-click
  menu entry.
- **A History tab** showing your recent Captures.
- **An inactivity prompt** that asks whether you meant to keep capturing.
- **An offline queue.** A Capture taken with no connection is kept and sent
  when the connection returns.
- **Privacy blur** before upload, which you can cancel.

### The Portal

- **Dashboard** — activity totals at a glance.
- **Projects** — create Projects, see who is in them.
- **Users** — who is in the Workspace, and their role.
- **Activity** — every Capture in a Project: tool, who, file address, size,
  time. Filterable by Tool.
- **Export ZIP** — the Captures as numbered pictures, oldest first, plus an
  `index.csv` you can open in a spreadsheet and write your notes into.
- **Reports**, **Global Settings**, **Workspace Settings**, **User Profile**.
- **Workspace invitations** — with an important limitation, in section 4.

### Underneath

- Pictures live in Google Cloud Storage; the labels live in a database.
- Work is separated by **Workspace**: one customer cannot see another's
  Projects, and this is enforced on the server, not in the browser.
- Deployment runs from **your** repository, and every release waits for an
  approval before it goes live. Nothing reaches production without that.

---

## 3. What was fixed, and why it mattered

Six faults were found and fixed between 29 August and today. Four of them were
invisible — the software reported success while quietly doing the wrong thing —
which is the reason they are described here rather than just listed.

### The Captures that were never recorded

The extension has two ways to send a picture. The faster one, used whenever
possible, **never wrote the record.** The picture reached storage and nothing
pointed at it, so it appeared nowhere: not in Activity, not in an export, not in
any report.

It had gone unnoticed because that faster path refused to run at all when the
Tool box was empty — and everyone testing had left it empty. The moment somebody
filled it in, as the instructions told them to, their Captures would have become
invisible with no error at any point.

### One Capture appearing as two rows

When the fast path failed, the slower fallback recorded the same Capture a
second time under a different address. Two rows, one picture, and the first row
pointed at bytes that were never uploaded — which is what made an export fail
part-way through.

### The Activity columns that had never worked

The file address and size columns read the wrong field names, so they showed a
dash in every Project since the feature was built. Nobody had noticed because a
dash looks like "nothing here yet" rather than "this is broken".

### Every upload taking the slow road *(fixed today)*

The fast upload path used a browser feature that does not exist inside a Chrome
extension's background worker. It failed instantly on **every Capture ever
taken**, and the fallback quietly picked up the work. Everything looked correct
— one Capture, one row, right picture — while every screenshot was routed the
long way round, costing speed and server capacity.

It left exactly one trace: a single line in a developer console that nobody was
reading. It is fixed, and the test suite now refuses to let that feature back
into that part of the code.

### A typed Tool being thrown away *(fixed today)*

If you typed a Tool name and captured without pressing **Save**, the name was
silently discarded and the Capture was recorded with no Tool. A Chrome popup
also discards unsaved typing the moment you click away, and the box then
reopened empty — so the text appeared never to have been typed at all.

This is what produced a run of Captures with a blank Tool column, and it cost a
day of investigation.

**The form now saves as you type.** Save still works and still confirms, but
nothing depends on remembering to press it.

### The export ignoring the filter *(fixed today)*

Filtering Activity by Tool and clicking Export returned **every** Capture in the
Project. The screen said the filter had worked and only the downloaded file
disagreed.

The filter now reaches the export, the file is named after the section, and —
because the filter is applied before the size limit is counted — a Project that
is too large to export in one go can now be exported one section at a time.

---

## 4. Two things to know before you use it

**Invitations are created but never sent.** The Portal will tell you an
invitation succeeded. No email goes out. The invitation is real and can be
accepted, but the code has to be passed to the person by hand. Until that is
fixed (#35), anyone you invite will be waiting for a message that is not coming.

**An export holds at most 50 Captures.** Beyond that, filter by Tool and export
each section. The limit exists so the download cannot exhaust the server, and
the message on screen now tells you what to do.

---

## 5. How confident to be in this

Honest answer, because it is more useful than a confident one.

**Verified working, by hand, in the live system:** signing in, taking Captures
all three ways, the Activity view including its columns and filter, the ZIP
export including a filtered one, and all six fixes above.

**Covered by automated tests:** 270 of them across the four parts of the system.
Every fix above was written test-first — the test was made to fail against the
broken code before the code was changed, so it is a test that would actually
catch the fault returning.

**Not yet verified by anyone but me:** everything in this document. That is
what the second document is for.

**Known to be incomplete:** the third document lists it, honestly, including the
parts you would notice.
