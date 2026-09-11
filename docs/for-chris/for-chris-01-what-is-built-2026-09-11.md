# theHammer — what is built, and what was fixed

**Date:** 11 September 2026
**Replaces:** [the 1 September edition](for-chris-01-what-is-built-2026-09-01.md)

---

## The one sentence that changed

The 1 September edition said this, in bold:

> **theHammer produces Captures. It does not produce the Storyboard.** The
> Storyboard PDF is assembled by hand from the exported pictures.

**That is no longer true.** theHammer now produces the Storyboard itself — you
choose which Captures tell the story, put them in order, say what you want the
narrative to focus on, and it returns a finished PDF. There is a narrated video
too.

That is the headline of the last ten days. Everything else below is either what
makes it trustworthy or what was found broken while getting there.

---

## 1. The Storyboard, end to end

This is new since 1 September and is the largest piece of work in the project so
far. It runs in six steps, all in the Portal.

**Choose and order.** Open a Project's Activity and press **Build Storyboard**.
Every Capture in the Project appears with a tick box, a position and a notes
box. Untick what does not belong, drag the rest into the order you want to tell
it in, and write a note against any Capture that needs one. Your choices are
saved, so you can come back to it.

**Say what it should be about.** Type an instruction — *"walk through the admin
workflows and say what each screen shows"*. Or **record yourself saying it**:
the recording is transcribed and used as the instruction. It is never played
back in the video; it is only a faster way to type.

**It writes the words.** Every chosen screenshot is sent to Google's Gemini
model, in order, with your notes and your instruction. It comes back with a
short opening summary and **one caption per screenshot** — two or three
sentences about that one picture.

**Correct it if it is wrong.** The opening summary appears in an editable box.
Your edit is what goes into the PDF. Nothing overwrites it unless you explicitly
regenerate.

**Finalize into a PDF.** The finished document appears in the Reports list,
viewable and downloadable like any other report.

**Or generate a narrated video.** The captions are read aloud over the
screenshots. This is a separate button on purpose — the video service charges
per render, so it never happens as a side effect of making a PDF.

### What the PDF looks like

Six screenshots to a page, in a grid, each with its own caption underneath and
its own label — the address of the screen it was taken on, like
`3 · /admin/retailers`, rather than the words "Slide 3". The opening summary
gets its own pages in front.

That layout came from **your** hand-built Softomedia Persona Storyboard, which
you sent on 9 September. It was read as evidence rather than guessed at, and it
settled a question we had been arguing from first principles. Six to a page,
prose on every frame, sections per walk — those are your document's decisions,
not ours.

**Concretely:** your 66-Capture run now finalizes to **17 pages**. The first
version of this feature produced **73** — six pages of narrative followed by 66
pages each carrying a screenshot, a heading, and no words at all.

### One honest caveat about the section headings

The layout groups frames into sections and puts a heading on each. In your run,
**every section heading reads "Beginning"** — one section across all eleven
pages.

That is not a fault in the layout; it is a fault in what the layout was given to
read. The heading comes from the Capture's *Stage* field, and every Capture in
that run has Stage set to `beginning`. Your six persona walks — Super Admin,
Admin, Brand, Brand Wizard, Retailer, Tech Op — were recorded in the **Tool**
box instead, because that is where the operator put them.

The walks are in the data. They are in the wrong field to group by, and one of
the eight values there is `Test-again`, which should not appear as a heading in
a client document. It is filed as **#126** and needs a decision rather than a
quick fix — see document 03, section 2.

---

## 2. The Reports page now shows real numbers

The 1 September edition warned you off this page:

> Some numbers on the Reports page are placeholders from an early sprint rather
> than calculated from your data. **Do not rely on that page yet.**

Four separate faults sat behind that warning, and all four are fixed.

**The figures were invented.** Report metrics were hard-coded from an early
sprint rather than calculated. They are now computed from your Captures (#8).

**The OCR reports read nothing.** A report that claimed to compare screenshots
was generated from no screenshots at all and returned a canned result. It now
reads real Captures from a real Storyboard, and the report types that cannot be
produced are refused rather than fabricated (#96).

**No report had ever had a narrative.** The connection to Google's AI was built
with the wrong shape of settings, so every call failed and the graceful
fall-back quietly completed the report without the words. Nobody saw an error,
ever, because the fall-back was working exactly as designed (#107).

**The model had been retired.** Every AI call named `gemini-1.5-flash`, which
Google withdrew in September 2025. So even once the connection was fixed, every
call would have failed. The model names now live in one place, and a test
refuses to let one be written anywhere else (#108).

**And the viewer was a mockup.** Even a finished report could not be opened in
the Portal — the button existed, the panel behind it was a placeholder. You can
now read a report in the browser (#120).

One more, worth knowing because it is about honesty rather than function: the
report narrative was writing commitments the numbers did not support — promising
improvements out of an "executive assistant" voice it had been asked to adopt.
The instruction was removed and there is now a check that refuses a narrative
that strays outside its own figures (#119).

---

## 3. Captures: four faults that were each invisible

**Every Capture was taking the slow road, in production.** The direct upload to
storage was failing on every single Capture, and the fall-back — routing the
picture through our server — was picking it up silently. One Capture, one row,
right picture, and every screenshot going the long way round at our cost (#70).

**Offline Captures were never actually sent.** The queue accepted them and said
so. When the connection returned, the draining step choked on the format the
picture had been stored in, so the queue never emptied. A Capture taken offline
was kept safely and never arrived (#92).

**A typed Tool was still being dropped** in one path (#73), and **a filtered
export still returned the whole Project** (#75). Both were reported as fixed on
1 September; both had a second route that had been missed.

**The refusal message now names the reason.** The popup used to say *"Blocked —
set Project & save first"* for six different situations, two of which were
untrue. Each refusal now says what actually happened (#72).

---

## 4. One customer cannot see another's work — now with proof

On 1 September this was implemented and checked by hand, with no automated
coverage. That was listed as the item to fund before selling to two customers at
once.

It is done, and **writing the tests found real holes.** Not one bug — a pattern:

- **Report pages accepted any Project or report number on trust**, with no
  ownership check at all (#94).
- **The Dashboard counted every customer's data**, not yours (#98), and so did
  the Projects and Users tiles (#101).
- **Two internal routes could be made to pair a Project from one customer with a
  report from another** (#104).
- **An internal password was never set in production**, so the system was
  running on the published default value that ships in the source code (#105).
- The ownership check itself had been **hand-copied into seven places in five
  different spellings**, which is how the gaps happened. There is now one check,
  in one place (#99).

Captures and Reports also now carry the customer they belong to directly, rather
than it being worked out indirectly each time (#102, #103).

Separately: a sign-in page would hand your access token to **any address given
to it** in a link. That is the kind of fault that turns a phishing email into a
real account takeover, and it is closed (#80).

---

## 5. Deleting a Project now deletes it

You asked for Captures to be kept indefinitely. Three different retention
numbers existed across the product, the documentation and the storage settings,
and the storage settings were deleting at 90 days regardless of what anyone had
been told.

That is resolved. The conflicting setting was removed, and deletion is now an
explicit act rather than a timer: **deleting a Project removes everything filed
under it** — its Captures, their pictures in storage, its sessions, Storyboards
and Reports. Every deletion is recorded, the confirmation tells you how many
Captures you are about to destroy, and a sweep exists for anything orphaned by
past deletions (#29, #112–#117).

---

## 6. Smaller things you would notice

- **The extension has the same identity on every machine.** You no longer send
  us its ID and wait. You can move the folder (#36).
- **The "Last capture" column works** on the Projects table (#62).
- **"Last active" is a real time,** not the date the account was created (#81).
- **A Project switch made offline no longer loses that session's time** (#22).
- **The Dashboard no longer shows a tile counting a thing nothing writes** (#100).
- **The export no longer advises a date range** that was never built (#76).

---

## 7. How confident to be in this

The same honest answer as last time, because it is more useful than a confident
one.

**Verified by hand in the live system, since 1 September:** the whole Storyboard
chain, end to end, on the real 66-Capture Softomedia run — curate, generate,
edit, finalize, and open the PDF in the Portal. Also every Workspace-separation
fix, and the report metrics.

**Covered by automated tests:** 561 across the four parts of the system, up from
270 on 1 September. Every fix above was written test-first — the test was made
to fail against the broken code before the code was changed.

**What the tests did not catch, and a person did.** Worth saying plainly,
because it is the pattern of this month: the Storyboard PDF's three worst
defects were all found by opening the document and looking at it, and none by a
green test suite. The narrative printing raw `#` and `**` characters onto a
client page. The 73-page layout. The section headings all reading "Beginning".
A suite that passes tells you the code does what its author expected — not that
what they expected was right.

**Not yet verified by anyone but us:** everything in this document. Document 02
is how you check it.

**Known to be incomplete:** document 03, honestly, including the one item that
still stops you working without us.
