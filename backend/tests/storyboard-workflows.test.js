/**
 * Workflows within a Storyboard (#126, ADR 0020)
 *
 * The curator divides the ordered frame list with dividers. A divider is stored
 * as `{ id, name, position }`, where `position` is how many frames — ticked or
 * not — sit above it in the list. Every frame below a divider belongs to it
 * until the next one.
 *
 * Pure: no Firestore, no routes. The PDF, the narrative request and the PATCH
 * validation all go through these two functions, so this is where the rules
 * are pinned; the route tests only prove each caller uses them.
 */
'use strict';

const {
  validateWorkflows, workflowSections, MAX_WORKFLOW_NAME_LENGTH,
} = require('../src/lib/workflows');

/** Frames in a deliberately scrambled array, so `order` is what sorts them. */
function frames(spec) {
  // spec: e.g. 'a+ b- c+' — id, then + included / - excluded
  const list = spec.split(/\s+/).map((token, i) => ({
    captureId: token.slice(0, -1),
    order: (i + 1) * 10,
    included: token.endsWith('+'),
  }));
  return list.reverse();
}

const ids = (section) => section.frames.map((f) => f.captureId);

describe('workflowSections', () => {
  test('a draft with no dividers is one section with no heading — every draft before ADR 0020', () => {
    const sections = workflowSections(frames('a+ b+ c+'), undefined);
    expect(sections).toEqual([
      { workflow: null, frames: expect.any(Array) },
    ]);
    expect(ids(sections[0])).toEqual(['a', 'b', 'c']);
  });

  test('each divider heads the frames below it, until the next one, numbered by position', () => {
    const sections = workflowSections(frames('a+ b+ c+ d+'), [
      { id: 'w1', name: 'Super Admin', position: 1 },
      { id: 'w2', name: 'Brand', position: 3 },
    ]);

    expect(sections.map((s) => s.workflow)).toEqual([
      null,
      { id: 'w1', number: 1, name: 'Super Admin' },
      { id: 'w2', number: 2, name: 'Brand' },
    ]);
    expect(sections.map(ids)).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  test('frames above the first divider are left out when none of them is included', () => {
    const sections = workflowSections(frames('a- b- c+'), [
      { id: 'w1', name: 'Super Admin', position: 2 },
    ]);
    expect(sections.map((s) => s.workflow?.name ?? null)).toEqual(['Super Admin']);
  });

  test('only included frames are carried, in order', () => {
    const sections = workflowSections(frames('a+ b- c+'), [{ id: 'w1', name: 'X', position: 0 }]);
    expect(sections.map(ids)).toEqual([['a', 'c']]);
  });

  test('a Workflow with every frame unticked is left out, and the numbers close up behind it', () => {
    const sections = workflowSections(frames('a+ b- c+'), [
      { id: 'w1', name: 'One', position: 0 },
      { id: 'w2', name: 'Two', position: 1 },
      { id: 'w3', name: 'Three', position: 2 },
    ]);
    expect(sections.map((s) => s.workflow)).toEqual([
      { id: 'w1', number: 1, name: 'One' },
      { id: 'w3', number: 2, name: 'Three' },
    ]);
  });

  test('two dividers back to back: the first is empty and left out', () => {
    const sections = workflowSections(frames('a+ b+'), [
      { id: 'w1', name: 'Empty', position: 1 },
      { id: 'w2', name: 'Full', position: 1 },
    ]);
    expect(sections.map((s) => s.workflow?.name ?? null)).toEqual([null, 'Full']);
    expect(sections.map(ids)).toEqual([['a'], ['b']]);
  });

  test('a divider at the very end has no frames and is left out', () => {
    const sections = workflowSections(frames('a+'), [{ id: 'w1', name: 'Trailing', position: 1 }]);
    expect(sections.map((s) => s.workflow)).toEqual([null]);
  });

  test('an empty Storyboard has no sections', () => {
    expect(workflowSections([], [{ id: 'w1', name: 'X', position: 0 }])).toEqual([]);
  });
});

describe('validateWorkflows', () => {
  test('accepts dividers in list order, trimming names', () => {
    const result = validateWorkflows([
      { id: 'w1', name: '  Super Admin ', position: 0 },
      { id: 'w2', name: 'Brand', position: 0 },
      { id: 'w3', name: 'Tech Op', position: 3 },
    ], 3);
    expect(result).toEqual({
      workflows: [
        { id: 'w1', name: 'Super Admin', position: 0 },
        { id: 'w2', name: 'Brand', position: 0 },
        { id: 'w3', name: 'Tech Op', position: 3 },
      ],
    });
  });

  test('an empty list is valid — it is how every divider gets deleted', () => {
    expect(validateWorkflows([], 3)).toEqual({ workflows: [] });
  });

  test.each([
    ['not an array', { id: 'w1' }, /array/],
    ['a blank name', [{ id: 'w1', name: '   ', position: 0 }], /name/],
    ['a name that is not a string', [{ id: 'w1', name: 7, position: 0 }], /name/],
    ['a missing id', [{ name: 'X', position: 0 }], /id/],
    ['a repeated id', [{ id: 'w1', name: 'X', position: 0 }, { id: 'w1', name: 'Y', position: 1 }], /duplicate/],
    ['a position past the last frame', [{ id: 'w1', name: 'X', position: 4 }], /position/],
    ['a negative position', [{ id: 'w1', name: 'X', position: -1 }], /position/],
    ['a fractional position', [{ id: 'w1', name: 'X', position: 1.5 }], /position/],
    ['dividers out of list order', [{ id: 'w1', name: 'X', position: 2 }, { id: 'w2', name: 'Y', position: 1 }], /order/],
  ])('rejects %s', (_label, input, message) => {
    expect(validateWorkflows(input, 3).error).toMatch(message);
  });

  test('a name is capped rather than refused', () => {
    const { workflows } = validateWorkflows([{ id: 'w1', name: 'x'.repeat(500), position: 0 }], 1);
    expect(workflows[0].name.length).toBe(MAX_WORKFLOW_NAME_LENGTH);
  });

  test('an over-long id is refused by what is wrong with it, not as a missing id', () => {
    const { error } = validateWorkflows([{ id: 'w'.repeat(65), name: 'X', position: 0 }], 1);
    expect(error).toMatch(/characters or fewer/);
  });
});
