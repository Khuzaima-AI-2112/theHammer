'use strict';

/**
 * Renders the Storyboard narrative's Markdown into a pdfkit document (#121).
 *
 * The narrative comes back from Gemini as Markdown. pdfkit's `.text()` draws
 * the characters it is handed, so passing that string through unmodified put
 * 60 `#` headings, 380 `**` markers and 100 `* ` bullets on the page of the
 * first Storyboard PDF the product ever produced — in the document whose
 * whole point is that a Customer can hand it to a client unedited.
 *
 * Rendering rather than forbidding was the decision. A 13,000-character
 * narrative is only readable because it has sections; instructing the model
 * to return flat prose removes the syntax by removing the structure, and an
 * instruction is not a guarantee anyway (#119 is the ticket about that).
 *
 * The subset is what the model actually emits, and no more: ATX headings,
 * `**bold**`, `*`/`-` bullets with one level of nesting, `---` rules, and
 * inline code spans whose backticks are dropped. Anything else is prose.
 *
 * A malformed marker stays literal — `a ** b` renders as `a ** b`, not as an
 * unterminated bold run that swallows the rest of the document. Visible
 * wrongness beats silent loss; the same reasoning as ADR 0016's, where a
 * narrative that fails its check is replaced rather than quietly published.
 */

const BODY_FONT = 'Helvetica';
const BOLD_FONT = 'Helvetica-Bold';
const BODY_SIZE = 11;

/** Deeper headings than 4 are sized the same — the model never emits them. */
const HEADING_SIZES = { 1: 17, 2: 15, 3: 13, 4: 11.5 };

const RULE_RE = /^\s*(-{3,}|_{3,}|\*{3,})\s*$/;
const HEADING_RE = /^\s*(#{1,6})\s+(.*)$/;
const BULLET_RE = /^(\s*)[*-]\s+(.*)$/;
const BOLD_RE = /\*\*(.+?)\*\*/g;
const CODE_SPAN_RE = /`([^`]*)`/g;
const LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;

/**
 * Three Markdown constructs are deliberately NOT handled, because handling
 * them would damage real narratives. Pinned by tests in
 * `tests/narrative-markdown.test.js`:
 *
 * - `_italic_`. These narratives name `report_type` and `storyboard_changes`.
 *   An italic rule eats the underscores out of a field name and nothing says
 *   so.
 * - `#heading` with no space after the hash. "slide #4" is prose, and
 *   requiring the space is the only thing keeping it prose.
 * - `1. numbered lists`. The number is content, not a marker — replacing it
 *   with a bullet glyph would delete text the reader needs.
 *
 * A subset is a set of choices about what to leave alone, not just what to
 * cover.
 */

/**
 * A line's inline content as bold/plain runs.
 *
 * Code spans lose their backticks first, so `Active` reads as Active — the
 * word is the content, the backticks are the model's formatting of it. A
 * link keeps its text and drops its target: a printed URL is noise in a
 * document nobody can click.
 */
function parseInline(text) {
  const source = text.replace(CODE_SPAN_RE, '$1').replace(LINK_RE, '$1');
  const runs = [];
  let last = 0;
  let match;

  BOLD_RE.lastIndex = 0;
  while ((match = BOLD_RE.exec(source))) {
    if (match.index > last) runs.push({ text: source.slice(last, match.index), bold: false });
    runs.push({ text: match[1], bold: true });
    last = BOLD_RE.lastIndex;
  }
  if (last < source.length) runs.push({ text: source.slice(last), bold: false });

  return runs;
}

/**
 * The narrative as a list of blocks.
 *
 * Separate from rendering because this is where the Markdown is understood
 * and rendering is only where it lands on a page — they fail differently and
 * are worth failing separately.
 */
function parseMarkdown(text) {
  const blocks = [];
  let paragraph = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', runs: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };

  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    if (line.trim() === '') { flush(); continue; }

    if (RULE_RE.test(line)) { flush(); blocks.push({ type: 'rule' }); continue; }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      blocks.push({
        type: 'heading',
        level: Math.min(heading[1].length, 4),
        runs: parseInline(heading[2]),
      });
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flush();
      blocks.push({
        type: 'bullet',
        depth: Math.floor(bullet[1].length / 2),
        runs: parseInline(bullet[2]),
      });
      continue;
    }

    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

/**
 * Draws one line's runs, switching fonts per run.
 *
 * `continued: true` on every run but the last is what keeps a bold phrase on
 * the same line as the prose around it rather than starting a new one.
 */
function drawRuns(doc, runs, { size, indent = 0, prefix = '' }) {
  const pieces = prefix ? [{ text: prefix, bold: false }, ...runs] : runs;
  if (pieces.length === 0) return;

  pieces.forEach((run, i) => {
    const options = { continued: i < pieces.length - 1 };
    if (i === 0 && indent) options.indent = indent;
    doc.font(run.bold ? BOLD_FONT : BODY_FONT).fontSize(size).text(run.text, options);
  });
}

/**
 * Renders `text` onto `doc` at the current position.
 *
 * Leaves the document on the body font and size, because the caller draws
 * slide pages afterwards and inheriting a bold heading font would silently
 * restyle all 66 of them.
 */
function renderMarkdown(doc, text) {
  const blocks = parseMarkdown(text);

  blocks.forEach((block, i) => {
    switch (block.type) {
      case 'heading':
        if (i > 0) doc.moveDown(0.6);
        drawRuns(doc, block.runs, { size: HEADING_SIZES[block.level] });
        doc.moveDown(0.3);
        break;

      case 'bullet':
        drawRuns(doc, block.runs, {
          size: BODY_SIZE,
          indent: 12 + block.depth * 14,
          prefix: '• ',
        });
        break;

      case 'rule': {
        doc.moveDown(0.5);
        const { left, right } = doc.page.margins;
        doc.moveTo(left, doc.y).lineTo(doc.page.width - right, doc.y).stroke();
        doc.moveDown(0.5);
        break;
      }

      default:
        drawRuns(doc, block.runs, { size: BODY_SIZE });
        doc.moveDown(0.4);
    }
  });

  doc.font(BODY_FONT).fontSize(BODY_SIZE);
}

module.exports = { parseMarkdown, renderMarkdown };
