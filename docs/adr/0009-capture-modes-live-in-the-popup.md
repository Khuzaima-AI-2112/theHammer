# The three capture modes live in the popup, not on the toolbar button

The Testing Plan calls `ACT-01` to `ACT-05` "the three-way action icon": one
toolbar button offering a plain screenshot, a snipped region, and a menu. Taken
literally that cannot be built. Chrome gives a toolbar button one behaviour —
it either opens a popup via `default_popup` or it runs code on click, never
both — and theHammer's popup is where the project dropdown, the stage, the tool
box, the history and the settings live. Turning the button into a menu would
mean rehousing all of that, and it would put a menu between the person and a
plain screenshot, which is precisely what `ACT-01` forbids.

**The three ways are two new buttons inside the existing popup instead.**
Capture Now stays where it is; *Snip* and *Full page* sit beneath it.

```
┌─ The Hammer ─────────────┐
│ [Capture] [History]      │
│ Project  [ Acme ▾ ]      │
│ Stage    [ Build ▾ ]     │
│ Tool     [ Figma      ]  │
│ [ Save ] [ Capture Now ] │
│ [ Snip ] [ Full page   ] │  ← new
└──────────────────────────┘
```

The toolbar button, the floating 🔨 and `Ctrl+Shift+S` are untouched. `ACT-01`
and AGENTS.md rule 4 are then safe by construction rather than by care: none of
the instant capture paths were edited, so none of them can have got slower.
Snip costs two clicks. That was accepted as the price of not disturbing the
paths that matter.

## The restricted-page fallback is narrower than ACT-03 sounds

`ACT-03` asks that snipping a restricted page "fail gracefully; fall back to
full capture". The fallback fires when `chrome.tabs.sendMessage` sets
`chrome.runtime.lastError` — nothing is listening in the tab — and then takes a
plain visible-tab capture instead of the region.

That helps exactly one class of page: **the content script is missing but the
URL is capturable.** A tab opened before the extension was installed or
reloaded, the Chrome Web Store, the PDF viewer. A genuinely restricted URL —
`chrome://settings` — is a different thing. `capture()` refuses those on its
own URL guard before any screenshot is taken, and it is right to: Chrome will
not screenshot them at all. The fallback runs there and stops at the same
guard, so the person is told the page cannot be captured rather than being
shown a fallback that quietly does nothing. `extension/tests/action.test.js`
asserts both outcomes so neither is mistaken for the other later.

Because a person who chose Snip and received the whole page has not got what
they asked for, the reply carries `fellBack: true` and the popup says so.
Silence there reads as a bug.

## The context menu keeps its old behaviour

*Hammer: Capture this element* and *Hammer: Capture full page* hit the same
missing-content-script condition today and show *"Please refresh the page to
use element capture."* **They are left alone.** Applying the new fallback to
them as well would be more consistent, and is worth doing one day; it is also
a behaviour change to a working path that this ticket did not ask for, and
AGENTS.md rule 2 says not to. The inconsistency is deliberate and recorded
here rather than fixed in passing.

For the same reason the two context-menu items stay where they are. *Full page*
is now reachable from both the popup and the right-click menu; that duplication
is cheaper than moving a working entry point and finding out afterwards who was
using it.

## Considered options

**Give up `default_popup` and make the toolbar button a menu.** Rejected. It is
the literal reading of "three-way action icon", and it costs the most: every
control in the popup needs somewhere else to live, and a plain screenshot gains
a click it does not have today.

**Put the modes behind a modifier key** — plain click captures, Shift-click
snips. Rejected as undiscoverable. Nothing in the interface would say the
feature exists.

**A settle period before a project change becomes a Session boundary.** Drafted
while `ACT-04` was open, and dropped. See ADR 0007: the boundary commits on the
first capture against the new project, which needs no timer at all.
