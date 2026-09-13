/**
 * Workflows within a Storyboard (#126, ADR 0020)
 *
 * A Workflow is a named piece of work the curator marks out in the Storyboard
 * builder by placing a divider in the ordered frame list. It is stored on the
 * draft as `{ id, name, position }`, and never on the Capture:
 *
 * - `position` is how many frames sit above the divider in the full ordered
 *   list, ticked or not. That is the list the builder shows, so it is the one a
 *   divider is placed in. Two dividers back to back share a position, and their
 *   order in the array is their order on screen.
 * - A Workflow's number is not stored. It comes from its position among the
 *   Workflows that are printed, so unticking every frame in one closes the gap
 *   rather than leaving the client a document that skips from 1 to 3.
 *
 * One definition, used by the PDF, the narrative request and the PATCH route,
 * for the reason `includedCaptures` in routes/admin/storyboards.js is one: if
 * the heading the PDF prints and the name the model was told disagreed, the
 * captions would be written about a different grouping than the one they sit
 * under.
 */

'use strict';

const MAX_WORKFLOW_NAME_LENGTH = 120;
const MAX_WORKFLOW_ID_LENGTH = 64;

/**
 * Checks dividers sent by the builder, against the draft's frame count.
 *
 * @returns {{ workflows: {id: string, name: string, position: number}[] } | { error: string }}
 */
function validateWorkflows(input, frameCount) {
  if (!Array.isArray(input)) return { error: 'workflows must be an array' };

  const seen = new Set();
  const workflows = [];
  let previousPosition = 0;

  for (const entry of input) {
    const { id, name, position } = entry ?? {};

    if (typeof id !== 'string' || id.trim() === '') {
      return { error: 'each workflow needs an id' };
    }
    if (id.length > MAX_WORKFLOW_ID_LENGTH) {
      return { error: `workflow id must be ${MAX_WORKFLOW_ID_LENGTH} characters or fewer` };
    }
    if (seen.has(id)) return { error: `duplicate workflow id: ${id}` };

    // Blank is refused, not defaulted: `Workflow 2 · ` is a heading with
    // nothing after it, on a page a client reads.
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed === '') return { error: `workflow ${id}: name must not be blank` };

    if (!Number.isInteger(position) || position < 0 || position > frameCount) {
      return { error: `workflow ${id}: position must be a whole number from 0 to ${frameCount}` };
    }
    // Stored in list order, so the array alone says which of two back-to-back
    // dividers comes first.
    if (position < previousPosition) {
      return { error: 'workflows must be in list order' };
    }

    seen.add(id);
    previousPosition = position;
    workflows.push({ id, name: trimmed.slice(0, MAX_WORKFLOW_NAME_LENGTH), position });
  }

  return { workflows };
}

/**
 * The Storyboard as it prints: included frames in curated order, split at the
 * curator's dividers.
 *
 * Each section is `{ workflow, frames }`. `workflow` is null for frames above
 * the first divider (and for a draft with no dividers at all, which is every
 * draft made before ADR 0020): those print with no heading. A section with no
 * included frames is dropped, and the remaining Workflows are numbered 1..n.
 *
 * @param {{captureId: string, order: number, included: boolean}[]} captures every frame on the draft
 * @param {{id: string, name: string, position: number}[] | undefined} workflows
 */
function workflowSections(captures, workflows) {
  const ordered = [...(captures ?? [])].sort((a, b) => a.order - b.order);
  const dividers = workflows ?? [];

  const sections = [{ workflow: null, frames: [] }];
  let next = 0;

  ordered.forEach((frame, index) => {
    // Every divider sitting above this frame opens its own section, even the
    // ones with nothing under them; those are filtered out below.
    while (next < dividers.length && dividers[next].position <= index) {
      sections.push({ workflow: dividers[next], frames: [] });
      next += 1;
    }
    if (frame.included) sections[sections.length - 1].frames.push(frame);
  });

  let number = 0;
  return sections
    .filter((s) => s.frames.length > 0)
    .map((s) => (s.workflow === null
      ? s
      : { workflow: { id: s.workflow.id, number: (number += 1), name: s.workflow.name }, frames: s.frames }));
}

/**
 * The Workflow each included frame prints under, by Capture id. A frame above
 * the first divider maps to null. The PDF heads pages from this and the
 * narrative request names each slide's Workflow from it, so the two agree.
 */
function workflowByCaptureId(captures, workflows) {
  const byId = new Map();
  for (const { workflow, frames } of workflowSections(captures, workflows)) {
    for (const frame of frames) byId.set(frame.captureId, workflow);
  }
  return byId;
}

module.exports = { validateWorkflows, workflowSections, workflowByCaptureId, MAX_WORKFLOW_NAME_LENGTH };
