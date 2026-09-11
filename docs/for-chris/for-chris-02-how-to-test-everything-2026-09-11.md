# theHammer — how to test every feature

**Date:** 11 September 2026
**Replaces:** [the 8 September edition](for-chris-02-how-to-test-everything-2026-09-08.md)

Deliberately short. Each section is a thing to do and one line saying what
"working" looks like.

---

## What is new since 8 September

**Section 8 is the big one: theHammer now builds the Storyboard PDF itself.**
Everything else here you have done before.

---

## Before you start

- **Portal:** <https://thehammer-portal-282689937365.northamerica-northeast1.run.app/>
- **Sign in everywhere as chris.frosztega@gmail.com.** The invitation is tied to
  that address and refuses any other.
- **You need a current invitation code.** The Portal still cannot email
  them (#35). Ask and it comes privately — single use, and it is the key to your
  Workspace, so do not forward it.
- **Allow about 35 minutes.** Sections 1–2 are setup; after that each stands
  alone.

**If something fails, screenshot it before retrying.** Retrying destroys the
evidence. This has cost us three investigations.

---

## 1. Sign in

Open the Portal, sign in with Google, enter the invitation code.

**Working when:** you land on the Dashboard with your name in the corner.

---

## 2. Install the extension

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → pick the `extension` folder from this repository
3. Pin The Hammer to the toolbar, click it, **Sign in**

**Working when:** the card's **ID** reads exactly `bnlcomhbnaecjjifmlpfilpohejhckmh`,
and the popup shows a form with Project, Stage and Tool.

> **Whenever a new version is released:** deploying does not update your browser. Press the
> reload arrow ↻ on The Hammer's card at `chrome://extensions`. This has caught
> us twice — a fix looked broken when it simply had not loaded.

---

## 3. Make a Project

Portal → **Projects → New Project**, name it `Chris test 11 Sept`, add yourself.

In the extension popup: refresh, select it, pick a Stage, type `chris-test` in
Tool.

**Working when:** it lists with one member and appears in the popup's dropdown.

---

## 4. Capture three ways

On any ordinary website: **Capture Now**; then **Snip** and drag a rectangle;
then `Ctrl+Shift+S` without opening the popup.

**Working when:** all three appear under **History** in the popup.

*Browser pages (`chrome://…`) refuse deliberately. The message now names the
real reason rather than blaming your settings.*

---

## 5. Unsaved Tool text

Type `chris-test-2` in Tool, **do not press Save**, click away, reopen the popup.

**Working when:** the box still says `chris-test-2`. Then take a Capture with it.

---

## 6. Read the Captures back

Portal → **Activity** → your Project.

**Working when:** every row has a real **TOOL**, **PATH** (ending `.png`),
**SIZE** and **TIME** — no dashes. Then filter by Tool and watch the count change.

*The path ends `..._<your tool>_<four characters>.png`. If the tool name is
missing there, the server got an empty Tool — faster to check than the column.*

---

## 7. Export

Filter to one Tool → **Export ZIP**.

**Working when:** the filename names the Project *and* the Tool; it holds only
that Tool's Captures; pictures are numbered oldest first; there is an
`index.csv`.

Then clear the filter and export a Project with more than 50 Captures. **It
should refuse and tell you to filter by Tool.** Refusing is correct.

---

## 8. The Storyboard — new, and the main event

Use a Project with a decent number of Captures. Your Softomedia run is ideal.

**a. Curate.** Activity → select the Project → **Build Storyboard**. Untick what
does not belong, order the rest, write notes where useful.

**Working when:** your choices survive leaving the page and coming back.

**b. Generate.** In the **AI narrative** box, type what it should focus on — the
box is required, an empty one is refused. Press **Generate narrative**.
(Or **Record audio walkthrough** and say it instead.)

**Working when:** status reaches **done**. On 66 Captures give it a few minutes;
it runs in the background, so the page can be left alone.

**c. Read and correct.** The opening summary appears in an editable box. Change
a word and press **Save edit**.

**Working when:** your edit is what appears in the PDF at step d — not the
original.

**d. Finalize.** Press **Finalize into PDF**. *This takes one to three minutes
and the button will look idle. That is expected (#122).*

**Working when:** the toast says it is in the Reports tab.

**e. Open it.** Sidebar → **Reports** → your Project → **View** on the newest
`storyboard` row.

**Working when:**
- **Six screenshots to a page**, in a grid
- **Each one has its own caption** — different from the others, about that
  picture
- Each is labelled by its screen address, like `3 · /admin/retailers`
- The opening summary has its own pages in front, as readable prose with **no
  `#` or `**` characters** visible

**Two things you should expect to look wrong, both known:**

1. **Every section heading reads "Beginning."** Your persona walks went into the
   Tool box, not the Stage box, so there is nothing to group by. Filed as #126.
2. **Some frames are labelled with a long truncated web address.** Those are
   Captures of the Portal's own front page, which has no path to show.

**f. The video, only if you want it.** **Generate video** reads the captions
aloud over the screenshots. *This costs money per render — it is a separate
button for that reason. Skip it unless you want to see it.*

---

## 9. Reports generally

Portal → **Reports** → **Generate**.

**Working when:** figures are real numbers rather than placeholders, and the
narrative describes what the numbers say without promising improvements.

*The 1 September document told you not to trust this page. You can now.*

---

## 10. Deleting a Project

Make a throwaway Project, capture into it twice, then delete it.

**Working when:** the confirmation tells you how many Captures you are about to
destroy, and afterwards the Project, its Captures and its Reports are all gone.

*Captures are kept indefinitely now. Nothing expires on a timer — deletion is
only ever something you do on purpose.*

---

## 11. Two customers at once

Ask us to invite a second address to a **different** Workspace. Sign in as that
person.

**Working when:** they cannot see your Project — not in Projects, not in
Activity, not in Reports, not in an export.

*Worth seeing once with your own eyes. Writing the automated tests for this
found four real holes.*

---

## 12. The remaining pages

- **Dashboard** — totals should be real numbers, and yours alone
- **Users** — your Workspace's people; try changing a role
- **Projects** — **Last capture** shows a real time (a dash means "none yet")
- **Settings, Profile** — load and save

---

## 13. Offline

**a.** Network off → take a Capture → network on → wait.
**Working when:** it appears in Activity on its own.

**b.** Network off → capture against one Project → switch Project → capture
again → network on → reload the extension at `chrome://extensions`.
**Working when:** both Projects' sessions are recorded.

---

## What to send back

A line per section: worked, or did not and here is what you saw. Most useful:

- **A screenshot of the screen** as you found it
- **The file address** from the Activity row, if a Capture looks wrong
- **Which Google account** you were signed in as, if anything was refused

If you will open the developer console (`F12` on the Portal, or the **service
worker** link on the extension's card), that text often settles a diagnosis on
its own.

**And say when something on screen sends you the wrong way.** The three
worst faults in the Storyboard PDF were all found by a person opening the
document and looking at it. None was found by a passing test.
