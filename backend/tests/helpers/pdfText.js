'use strict';

/**
 * Minimal text extraction for a PDF this codebase generated with pdfkit
 * using `PDFDocument({ compress: false })` — not a general-purpose PDF
 * parser, and not meant to become one.
 *
 * pdfkit's standard (non-embedded, non-subsetted) fonts encode each text run
 * inside a text object (`BT`...`ET`) as a hex string of WinAnsi byte codes,
 * which for printable ASCII decode 1:1 back to the original characters.
 * Concatenating every hex string found inside a stream that contains a text
 * object, across every content stream in document order, reconstructs
 * enough of the text pdfkit wrote to assert on ordering and presence — which
 * is all storyboard-finalize.test.js needs. An image XObject's raw bytes
 * live in their own `stream`/`endstream` block with no `BT`, so filtering on
 * that keeps this from misreading binary image data as text.
 */
function extractPdfText(buffer) {
  const str = buffer.toString('latin1');
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const hexRe = /<([0-9A-Fa-f]+)>/g;
  let out = '';
  let streamMatch;
  while ((streamMatch = streamRe.exec(str))) {
    const content = streamMatch[1];
    if (!content.includes('BT')) continue;
    let hexMatch;
    while ((hexMatch = hexRe.exec(content))) {
      out += Buffer.from(hexMatch[1], 'hex').toString('latin1');
    }
  }
  return out;
}

/**
 * How many pages the document has — the claim #125's layout is about.
 *
 * Each page is its own `/Type /Page` object in the body; the single
 * `/Type /Pages` node that lists them is excluded by the word boundary, and
 * nothing else in a pdfkit document writes either marker.
 */
function countPdfPages(buffer) {
  const matches = buffer.toString('latin1').match(/\/Type \/Page\b/g);
  return matches ? matches.length : 0;
}

module.exports = { extractPdfText, countPdfPages };
