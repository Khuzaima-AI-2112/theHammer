/**
 * The narrative's Markdown is rendered, not printed (#121)
 *
 * Gemini returns Markdown. `buildStoryboardPdf` used to hand that string
 * straight to pdfkit's `.text()`, which draws the characters it is given, so
 * the first Storyboard PDF the product ever produced carried 60 `#` headings,
 * 380 `**` markers and 100 `* ` bullets as visible text — in a document whose
 * whole purpose is to be handed to a client.
 *
 * `lib/narrativeMarkdown.js` parses the subset the model actually emits and
 * draws it with pdfkit's own font and indent calls. Two halves are tested
 * separately because they fail differently: `parseMarkdown` is pure and is
 * where the syntax is understood, `renderMarkdown` is where it reaches the
 * page and is checked for leaking any marker back out.
 *
 * Run from backend/: npx jest narrative-markdown --runInBand
 */
'use strict';

const { parseMarkdown, renderMarkdown } = require('../src/lib/narrativeMarkdown');

/** A pdfkit stand-in that records every string drawn, in order. */
function stubDoc() {
  const drawn = [];
  const doc = {
    fonts: [],
    text(value) { drawn.push(String(value)); return doc; },
    font(name) { doc.fonts.push(name); return doc; },
    fontSize() { return doc; },
    moveDown() { return doc; },
    moveTo() { return doc; },
    lineTo() { return doc; },
    stroke() { return doc; },
    x: 50,
    y: 100,
    page: { width: 612, margins: { left: 50, right: 50 } },
  };
  return { doc, drawn };
}

describe('parseMarkdown', () => {
  test('reads a heading as its level and text, without the hashes', () => {
    expect(parseMarkdown('#### Phase 1: Retailer Onboarding')).toEqual([
      { type: 'heading', level: 4, runs: [{ text: 'Phase 1: Retailer Onboarding', bold: false }] },
    ]);
  });

  test('caps heading level at 4, since deeper ones size the same', () => {
    const [block] = parseMarkdown('###### Deep');
    expect(block.level).toBe(4);
  });

  test('splits bold runs out of a paragraph', () => {
    expect(parseMarkdown('Operator **clicks Save** now')).toEqual([
      {
        type: 'paragraph',
        runs: [
          { text: 'Operator ', bold: false },
          { text: 'clicks Save', bold: true },
          { text: ' now', bold: false },
        ],
      },
    ]);
  });

  test('a heading can be entirely bold, which is how the model writes them', () => {
    expect(parseMarkdown('#### **4. Retailer List (Updated)**')).toEqual([
      { type: 'heading', level: 4, runs: [{ text: '4. Retailer List (Updated)', bold: true }] },
    ]);
  });

  test('reads bullets, and their nesting depth', () => {
    expect(parseMarkdown('* Top\n  * Nested')).toEqual([
      { type: 'bullet', depth: 0, runs: [{ text: 'Top', bold: false }] },
      { type: 'bullet', depth: 1, runs: [{ text: 'Nested', bold: false }] },
    ]);
  });

  test('a dash bullet is the same thing as a star bullet', () => {
    const [block] = parseMarkdown('- Dashed');
    expect(block.type).toBe('bullet');
  });

  test('reads a horizontal rule', () => {
    expect(parseMarkdown('---')).toEqual([{ type: 'rule' }]);
  });

  test('strips inline code backticks but keeps the word', () => {
    expect(parseMarkdown('status is `Active` now')).toEqual([
      { type: 'paragraph', runs: [{ text: 'status is Active now', bold: false }] },
    ]);
  });

  test('joins wrapped lines into one paragraph, and splits on a blank line', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { type: 'paragraph', runs: [{ text: 'one two', bold: false }] },
      { type: 'paragraph', runs: [{ text: 'three', bold: false }] },
    ]);
  });

  test('an unclosed bold marker stays literal rather than eating the rest', () => {
    // A half-written marker is the model's mistake, not a licence to drop text.
    expect(parseMarkdown('a ** b')).toEqual([
      { type: 'paragraph', runs: [{ text: 'a ** b', bold: false }] },
    ]);
  });

  test('keeps a link\'s text and drops its target', () => {
    expect(parseMarkdown('see [the dashboard](https://example.com/x) now')).toEqual([
      { type: 'paragraph', runs: [{ text: 'see the dashboard now', bold: false }] },
    ]);
  });

  // The three below are deliberately NOT handled, and each would be a defect
  // if it were. They are pinned so the next reader does not "complete" the
  // subset and break real narratives in the process.

  test('underscores survive, because field names contain them', () => {
    // `_italic_` is a Markdown construct this parser refuses on purpose: the
    // narratives describe `report_type` and `storyboard_changes`, and an
    // italic rule would silently eat the underscores out of them.
    expect(parseMarkdown('the report_type field and storyboard_changes rows')).toEqual([
      { type: 'paragraph', runs: [{ text: 'the report_type field and storyboard_changes rows', bold: false }] },
    ]);
  });

  test('a hash with no space after it is a number, not a heading', () => {
    // "slide #4" is prose. Requiring the space is what keeps it prose.
    const [block] = parseMarkdown('see slide #4 for the modal');
    expect(block.type).toBe('paragraph');
    expect(block.runs[0].text).toBe('see slide #4 for the modal');
  });

  test('a numbered list stays prose, numbering intact', () => {
    // `1. ` carries no marker to strip — the number is the content. Rendering
    // it as a bullet would replace real text with a glyph.
    const [block] = parseMarkdown('1. Operator opens the retailer list');
    expect(block.type).toBe('paragraph');
    expect(block.runs[0].text).toBe('1. Operator opens the retailer list');
  });

  test('empty input is no blocks, not one empty paragraph', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   \n\n  ')).toEqual([]);
  });
});

describe('renderMarkdown', () => {
  const NARRATIVE = [
    '### **Phase 1: Retailer Onboarding**',
    '',
    '#### **4. Retailer List (Updated)**',
    '* **Operator Action:** Verifies `FreshMart` is `Active`.',
    '  * Confirms registration.',
    '',
    '---',
    '',
    'Closing paragraph with **emphasis**.',
  ].join('\n');

  test('draws every word of the narrative', () => {
    const { doc, drawn } = stubDoc();
    renderMarkdown(doc, NARRATIVE);
    const all = drawn.join(' ');

    for (const word of ['Phase 1', 'Retailer List', 'Operator Action', 'FreshMart', 'Active', 'Confirms registration', 'emphasis']) {
      expect(all).toContain(word);
    }
  });

  test('no Markdown marker reaches the page', () => {
    const { doc, drawn } = stubDoc();
    renderMarkdown(doc, NARRATIVE);

    for (const drawnText of drawn) {
      expect(drawnText).not.toContain('**');
      expect(drawnText).not.toContain('`');
      expect(drawnText).not.toMatch(/^#{1,6}\s/);
      expect(drawnText).not.toMatch(/^\s*[*-]\s/);
    }
  });

  test('bold runs are drawn in a bold font', () => {
    const { doc } = stubDoc();
    renderMarkdown(doc, 'plain **bold** plain');
    expect(doc.fonts).toContain('Helvetica-Bold');
  });

  test('plain prose with no Markdown at all still renders', () => {
    // The instruct-plain-prose option was rejected, but a narrative that
    // happens to carry no syntax must not render as nothing.
    const { doc, drawn } = stubDoc();
    renderMarkdown(doc, 'Just a sentence.');
    expect(drawn.join(' ')).toContain('Just a sentence.');
  });
});
