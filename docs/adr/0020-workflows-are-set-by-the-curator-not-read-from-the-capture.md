# Workflows are set by the curator, not read from the Capture

Decided 2026-09-13, settling #126. This supersedes part of ADR 0019 and retires
#74's rule that the Project carries the Persona.

## Decision

A Storyboard is divided into **Workflows** (see `CONTEXT.md`): named pieces of
work such as "Super Admin". The curator sets them in the Storyboard builder by
placing a **divider** in the ordered list of frames. Every frame below a divider
belongs to that Workflow until the next divider. The Workflow is stored on the
Storyboard draft. It is not stored on the Capture, and the extension does not
change.

- A Workflow is a free-text name and nothing more. It has no Persona field, and
  its number comes from its position in the list.
- The PDF heads each Workflow `Workflow N · <name>`, with `(continued)` on
  overflow pages.
- Frames above the first divider, or in a Storyboard with no dividers, are
  printed with no heading. Every draft made before this ADR renders that way.
- A Workflow with no included frames is left out of the PDF, and the builder
  shows it as empty.
- Narrative generation is told each frame's Workflow name as context. The model
  cannot move, add or rename a divider.
- The video is unchanged. There are no title cards, for the reason ADR 0019
  gives.

**Stage is no longer read for grouping.** It means Beginning, During or After
and nothing else. `personaLabel(upload.stage)` and the `Unassigned Persona`
heading go.

## Why

ADR 0019 headed sections from `stage`, taking it to be the Persona. It is not.
The extension offers only Beginning, During and After, and all 66 Captures of
the real Softomedia run carry `beginning`. The persona walks were typed into
Tool instead, and `CONTEXT.md` already forbids grouping by Tool. So the grouping
was reading a field that has never held a Workflow, and nothing in the product
recorded one anywhere.

Putting it in the builder records the Workflow at the moment someone is already
deciding the story (unticking and ordering frames). That is also where it
belongs: the same screenshot could appear in two Storyboards under different
Workflows. It works on Captures that already exist, and it does not depend on
an operator remembering to fill in a box at capture time, which is exactly how
Stage went wrong.

## What this changes in ADR 0019

- *"Section headers come from Capture metadata (`stage`, the Persona; `tool`)"*
  is replaced. Headers now come from the curator's Workflow dividers.
- *"The Analyst still pre-tags nothing"* is narrowed. The Analyst now marks
  where each Workflow starts. What that line protected is unchanged: **the
  model** does not choose the section boundaries, and a person does.

## Considered and rejected

- **A Workflow box in the extension, stamped on each Capture.** The 66 existing
  Captures would have none, so they would need re-capturing or a backfill. It
  also depends on the operator remembering at capture time, which Stage has
  already shown does not happen.
- **One Project per Persona (#74), with a Storyboard drawing from several
  Projects.** This is the largest change, since a Storyboard is scoped to one
  Project today, and the Softomedia run had already ignored the rule.
- **Keep a Storyboard to one workflow and stitch several together.** Chris wants
  one generated Storyboard. Stitching adds a new concept and an extra step for
  him.
- **A Workflow label on each frame instead of dividers.** Frames with the same
  label could end up apart in the order, which would force a choice between
  moving them silently or printing the same heading twice. Dividers cannot get
  into that state, and what the builder shows is what the PDF prints.
- **Group by Tool.** Already forbidden by `CONTEXT.md`. It would also put
  `Test-again` on a page heading in a client document.
