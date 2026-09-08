# theHammer — how to test every feature

**Date:** 8 September 2026
**Replaces:** [the 1 September edition](for-chris-02-how-to-test-everything-2026-09-01.md)

---

## What changed since the 1 September edition

Three things, and the first one removes a step you had to wait on me for.

- **The extension now has the same identity on every machine.** You no longer
  need to send me its ID and wait for a release before your Captures work. That
  was the worst part of the last walkthrough — it put a ten-minute round trip
  with me in the middle of your setup, and it is gone. **You can also move the
  folder now.**
- **The Projects table's "Last capture" column works.** The last edition told
  you to ignore it because it always showed a dash. It now shows real times.
- **A project switch made while offline no longer loses that session's time.**
  Section 10 has a way to see it.

If you did the 1 September walkthrough, sections 1–2 are worth redoing from
scratch anyway, because the extension identity changed.

---

## Before you start

You need two things from me:

1. **The Portal address:**
   <https://thehammer-portal-282689937365.northamerica-northeast1.run.app/>
2. **A fresh invitation code.** The one in the last edition expired on
   8 September 2026. The Portal still cannot email these — that is issue #35 —
   so ask me and I will send you a new one privately. Single use, tied to
   **chris.frosztega@gmail.com**, and it is the key to the Workspace, so please
   do not forward it.

The extension comes from this repository now rather than a `.zip` — see
section 2.

Sign in everywhere with **chris.frosztega@gmail.com**. The invitation is tied to
that address and will refuse any other.

**Expect roughly 40 minutes** for the whole document. Sections 1 and 2 are the
setup; from section 3 onward each part stands alone, so you can stop and resume.

**If something does not work, write down what you saw and send it to me
before retrying.** Retrying often destroys the evidence — three separate
investigations were slowed by exactly that, and one build failure this month was
retried twice before anyone read the log. A screenshot of the screen is usually
enough, and your screenshots have settled several questions already.

---

## 1. Getting into the Portal

1. Open the Portal address above.
2. Sign in with Google as **chris.frosztega@gmail.com**.
3. Enter the invitation code when asked.

**Working when:** you land on the Dashboard with your own name in the corner.

---

## 2. Installing the extension

The extension is not in the Chrome Web Store, so it loads from a folder.

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** — top right.
3. Click **Load unpacked** and pick the `extension` folder from the repository.
4. Pin The Hammer to the toolbar so you can reach it.

**Working when:** the card shows The Hammer with no red error, the icon is in
your toolbar, and the **ID** on the card reads exactly:

```
bnlcomhbnaecjjifmlpfilpohejhckmh
```

**Check that ID.** It is the whole of what used to be a stop-and-wait step. If
it says anything else, you are loading a folder from before this change — pull
the latest and load `extension` itself rather than a copy of it. If it matches,
the server already trusts you and there is nothing to send me.

*Why it used to be different:* Chrome derived an unpacked extension's identity
from where its folder sat on your disk, so yours differed from mine and the
server refused everything you sent — silently, with sign-in appearing to work.
The extension now carries its own key, so the identity is the same everywhere
and the folder can live wherever you like. Issue #36, closed 8 September.

Then click the icon and **Sign in**, again with the same address.

**Working when:** the panel changes from a welcome screen to a form with
Project, Stage and Tool.

> **The one thing to remember about updates.** When I release a new version,
> deploying it to the server does **not** update your browser. Return to
> `chrome://extensions` and press the reload arrow ↻ on The Hammer's card.
> This caught us twice, and both times a fix looked broken when it simply had
> not loaded. Moving the folder is now harmless, but reloading is still required.

---

## 3. Setting up a Project

In the Portal:

1. **Projects → New Project.** Name it `Chris test 8 Sept`.
2. Add yourself as a member.

**Working when:** it appears in the Projects list showing one member.

Then in the extension popup, press the small refresh so the new Project appears
in the dropdown, select it, choose a Stage, and type `chris-test` in the Tool
box.

---

## 4. The three ways to capture

Do all three. They share most of their machinery but not all of it.

**a. Whole visible page.** Open any ordinary website, click the extension icon,
press **Capture Now**.

**b. A region.** Press **Snip**, then drag a rectangle over part of the page.

**c. The keyboard.** Press `Ctrl+Shift+S` without opening the popup at all.

**Working when:** each says it uploaded, and each appears under the **History**
tab in the popup.

**A capture will be refused on browser pages** — anything starting `chrome://`,
including the extensions page itself. That is deliberate. Be aware the message
is currently unhelpful and may say "set Project & save first" even when your
Project is set correctly; that wording is a known fault (#72), not a real
problem with your settings.

---

## 5. The Tool box — worth testing deliberately

The fault most likely to affect your Storyboard work.

1. Open the popup and type `chris-test-2` in the Tool box.
2. **Do not press Save.**
3. Click somewhere else so the popup closes.
4. Open the popup again.

**Working when:** the box still says `chris-test-2`.

Before this was fixed the box would have been empty, and any Capture taken would
have been recorded with no Tool at all — discovered only much later, in the
export.

Now take a Capture with that Tool set, and continue to section 6.

---

## 6. Reading the Captures back

Portal → **Activity** → choose your Project.

**Working when** you see one row per Capture, and **all** of these have real
values rather than a dash:

- **TOOL** — `chris-test` or `chris-test-2`
- **PATH** — a long file address ending in `.png`
- **SIZE** — a number of KB
- **TIME** — how long ago

The file address is the most informative field. It ends
`..._<your tool>_<four characters>.png`. **If the tool name is missing from that
address**, the server received an empty Tool — which is faster and more reliable
to check than the TOOL column itself.

Then use the **Tool** dropdown to filter, and confirm the row count changes.

---

## 7. The export

This is the feature that produces Storyboard material, so it is worth care.

1. With the filter set to one Tool, press **Export ZIP**.
2. Open the downloaded file.

**Working when:**

- The file name contains **both** the Project and the Tool you filtered to.
- It contains **only** that Tool's Captures — not everything in the Project.
- The pictures are numbered `001`, `002`, … **oldest first**. The order is the
  point: it is the order you build the Storyboard in.
- There is an `index.csv` listing number, file, time, tool, stage and page
  address. Open it in a spreadsheet — that is the column to write commentary
  into.

**Then test the limit deliberately.** Clear the Tool filter and export a Project
holding more than 50 Captures. It should refuse, and the message should tell you
to filter by Tool and export each section. Refusing is correct behaviour; a
message that does not say what to do instead is not.

---

## 8. Two people at once

This is the check that matters most commercially, because it is the promise that
one customer cannot see another's work.

Ask me to invite a second address to a **different** Workspace. Sign in as
that person and confirm they cannot see `Chris test 8 Sept` — not in Projects,
not in Activity, not in an export.

This is enforced on the server rather than by hiding things in the browser, and
there is automated coverage for it, but it is worth seeing with your own eyes
once.

---

## 9. The remaining Portal pages

Quicker, and mostly a matter of confirming they load and show sensible things.

- **Dashboard** — the totals across all Projects. **Note:** I have seen these
  show a dash rather than numbers. If you see that too, say so; it is not yet
  explained and is recorded in the third document.
- **Users** — everyone in your Workspace, and their role. Try changing a role.
- **Projects** — the **Last capture** column now shows a real time, and so does
  the tile above the table. *This is new since the last edition, where it always
  showed a dash (#62, closed 8 September).* A Project you have never captured
  into still shows a dash, correctly — that means "none yet", not "we could not
  tell".
- **Reports** — see the third document before drawing conclusions from anything
  here; some figures are not yet real.
- **Global / Workspace Settings, User Profile** — confirm they load and save.

---

## 10. Offline behaviour

Two separate things, and the second one is new.

**a. A Capture taken offline.**

1. Turn off your network.
2. Take a Capture. It should be accepted and queued rather than lost.
3. Turn the network back on and wait.

**Working when:** the Capture appears in Activity without you doing anything
further.

**b. A project switch made offline.** This is the one that used to lose data.

1. With the network **off**, take a Capture against `Chris test 8 Sept`.
2. Still offline, switch the extension to a *different* Project and take a
   Capture there.
3. Turn the network back on, then reload The Hammer at `chrome://extensions`
   (the queue is drained when the extension starts).

**Working when:** both Projects' sessions are recorded — the time you spent on
the first Project is still there.

Until 8 September the outgoing session was written straight to the server at the
moment you switched, and if that failed there was no second attempt: the time
was gone. It is now kept on disk and sent when you are back online (#22). You
would only notice this in session-based figures, not in the Captures themselves,
which is why it went unnoticed for so long.

---

## What to send back

A short note per section — worked, or did not and here is what I saw. The most
useful things you can include:

- **A screenshot of the screen** as you found it.
- **The file address** from the Activity row, if a Capture looks wrong.
- **Which Google account** you were signed in as, if anything was refused.

If you are willing to open the developer console (`F12` on the Portal, or the
**service worker** link on The Hammer's card at `chrome://extensions`), the text
there is often the single thing that settles a diagnosis. Three faults this
month were found in it and one was wrongly closed for want of it.
