# theHammer — what remains to be built and fixed

**Date:** 1 September 2026

---

## How to read this

Twenty-two items are open. They are grouped by **what they cost you**, not by
how hard they are, because the ordering is a decision for you rather than for
us.

Numbers in brackets are the tracker numbers, so anything here can be traced to
the full write-up.

---

## 1. Things you will notice yourself

These affect somebody using the product today.

### Invitations are never sent (#35)

The Portal reports success and no email goes out. The code exists and works, but
it has to be read out of a server log and passed to the person by hand.

**Cost:** you cannot onboard anyone without me. Anyone you invite waits for a
message that never arrives.

**Also:** the code is currently stored and logged in plain text. It should be
stored as a one-way hash, which is a small change made at the same time.

**Recommend fixing first.** It is the only item that blocks you doing something
without us.

### The capture refusal message is wrong (#72)

When a Capture cannot be taken, the popup says *"Blocked — set Project & save
first"* for six different reasons. Two of those messages are simply untrue:

- One means **the upload failed but the Capture is safely queued** — nothing is
  lost, and the person is told to fix a setting that is not wrong. They may
  retake a Capture that was never lost.
- One means **you cancelled the privacy blur yourself**, reported as a
  misconfiguration.

**Cost:** you will hit this and be sent looking for a problem that is not there.
It already cost me a round trip.

### The "Last capture" column is always empty (#62)

The Projects table shows a dash in that column for every Project, always.

**Cost:** small, but it is the column you would naturally glance at to see
whether a Project is live. Use the Activity view instead. The fix is either to
record the value or to remove the column — worth deciding rather than leaving.

### Dashboard totals may not be showing *(not yet filed)*

I have seen every Dashboard tile show a dash rather than a number. The server
does calculate real figures, so this is a fault rather than an absence of data,
but it has not been diagnosed yet.

**Please say whether you see it too.** Two observers make this a five-minute fix
rather than a hunt.

### Report figures are not all real (#8)

Some numbers on the Reports page are placeholders from an early sprint rather
than calculated from your data.

**Cost:** potentially serious, because a wrong number is worse than a missing
one. Do not rely on that page yet.

### Moving the extension folder breaks signing in (#36)

The extension's identity comes from where its folder sits on disk, so moving it
breaks the connection to the server until someone updates a setting in the
cloud console.

**Cost:** a trap rather than a daily problem, but an unpleasant one — it looks
like a broken login. It is deliberately not being fixed until after the current
capture work, because the fix changes that identity and breaks sign-in until the
cloud setting is changed in step.

---

## 2. Decisions waiting on you

Nothing is blocked technically. These need an answer.

### How long Captures are kept (#29)

Three different numbers appear in the product, the documentation and the
storage settings, which currently deletes at 90 days regardless of what anyone
was told. You said **keep indefinitely**, and you have confirmed you can change
the storage policy — so this needs one change made by you and the other two
numbers corrected to match.

### The 50-Capture export limit (#76)

Filtering by Tool now lets you export a large Project one section at a time, so
this is no longer blocking. The open question is whether that is enough or
whether the export should also take a date range. **A section of more than 50
Captures would need one.** Worth deciding once you have built a Storyboard by
hand and know how big a section actually gets.

### The Storyboard itself (no number — it is a product question)

theHammer produces Captures. Assembling them into a Storyboard PDF is done by
hand, deliberately, because building a document generator before anyone has made
one by hand would be guessing at the format.

You raised that fifty images is a lot of scrolling, and asked about NotebookLM.
Our position is unchanged and worth restating: that is a **curation** problem
rather than a format problem, and the answer is likely to be fewer, better
chosen images rather than a different container. **Build one Storyboard by hand
first.** If it is genuinely unwieldy, we will know exactly what to automate.

---

## 3. Correctness and security work

Not visible, and it is where an unpleasant surprise would come from.

- **Sign-out is not immediate (#18).** A revoked account can keep working for up
  to an hour. Worth fixing before anyone outside your team uses this.
- **Separation between customers is not fully covered by tests (#7).** The
  behaviour is implemented and enforced on the server, and was checked by hand;
  what is missing is the automated suite that keeps it true. This is the item to
  fund if you plan to sell to two customers at once.
- **Captures are not fully covered end to end (#6, #20).** In particular, what
  happens when a connection drops mid-upload is not automatically tested.
- **Queued activity records can be lost offline (#22).** Captures themselves are
  safe; the usage log entries around them are not.
- **An external service call has no sign-off (#39-related).** Our own rules say
  a new third-party dependency needs a recorded review; one call went in without
  it. A paperwork gap rather than a fault, and the paperwork exists to stop the
  next one being real.

---

## 4. Internal tidying

Real work, no customer impact. Listed for completeness rather than for a
decision: **#74** and **#64** (writing down what our own words mean — one of
these caused a genuine mistake this month), **#19**, **#50**, **#37**, **#21**,
**#9**, **#10**, **#28**, **#5**.

---

## 5. If you want a recommendation

In order:

1. **#35** — invitations. It is the only thing stopping you working without us.
2. **#72** — the misleading refusal message. Cheap, and it stops sending people
   after imaginary problems.
3. **#18 and #7** — sign-out and the isolation tests. Do these before a second
   customer, not after.
4. **#8** — the report figures. A wrong number is worse than no number.
5. **#29** — retention. Needs your decision more than our time.

Then the Dashboard question above, once you have said whether you see it too.

---

## One thing we would ask for

**Tell us when a message on screen sends you the wrong way.** Four of the six
faults fixed this month were invisible: the software reported success while
doing something else, and the only clue was a display that quietly disagreed
with reality. You are the first person to use this without knowing how it was
built, which makes you the only person who can notice that kind of thing
honestly.
