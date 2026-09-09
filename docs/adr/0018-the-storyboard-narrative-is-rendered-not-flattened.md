# The Storyboard narrative's Markdown is rendered, not forbidden

Decided 2026-09-09, closing #121, after the first end-to-end Storyboard run the
product has ever had.

## Decision

The model keeps returning Markdown, and `lib/narrativeMarkdown.js` renders a
fixed subset of it into the PDF. We do **not** instruct the model to return
flat prose.

## Why

The alternative was one line of prompt: *"return plain prose, no Markdown."*
It is much the smaller change, and it has a precedent — #119 constrains a
Report's register by instruction plus a check.

It was rejected because it removes the syntax by removing the structure. The
real narrative this decision was made against is 12,965 characters across 60
headings. What makes that readable is that it is sectioned; flattened, it is
thirteen thousand characters of undifferentiated paragraph, and the Customer
who was going to hand it to a client still has work to do — which is story 22
of #84, the requirement this whole ticket exists to satisfy.

The register argument that carried #119 does not carry here. There, the
problem was the *content* of what the model said (invented commitments), and
an instruction plus a detector was the only way to constrain content. Here the
problem is purely presentational: the words were right, the asterisks were
showing. Presentation is the renderer's job, not the prompt's.

## What the subset is, and what it deliberately excludes

Handled: ATX headings (`#` through `######`, sized to four levels), `**bold**`,
`*` and `-` bullets with nesting, `---` rules, code spans (backticks dropped),
and links (text kept, target dropped).

Not handled, each on purpose, each pinned by a test:

- **`_italic_`.** These narratives name `report_type` and `storyboard_changes`.
  An underscore-italic rule silently eats the underscores out of a field name.
- **`#heading` with no space.** "slide #4" is prose. The required space is the
  only thing keeping it prose.
- **`1.` numbered lists.** The number is content, not a marker. Replacing it
  with a bullet glyph deletes text the reader needs.

A malformed marker stays literal: `a ** b` renders as `a ** b`, not as an
unterminated bold run that swallows the rest of the document. Visible
wrongness over silent loss — the same instinct as ADR 0016's, which replaces a
narrative that fails its check rather than quietly publishing it.

## Consequences

A Markdown subset grows. The pressure will be to "complete" it, and the
exclusions above are the ones that must survive that pressure, because each is
a case where more coverage means worse output. The test file is where that
argument is recorded; a future reader who deletes one of those tests should
have to read the reason first.

The check lives with the artifact, not the prompt: `storyboard-finalize.test.js`
asserts the generated PDF's text layer carries no `**`, no `#` and no backtick
while still containing every word. That is the half of #119's lesson that
transfers — the instruction was never the guarantee, the check is.

## Open, and not decided here

ADR 0016 exempts the Storyboard narrative from `narrativeGuard` on the grounds
that it is *"the Analyst's draft… not a figure presented to a Customer."* This
ticket's own evidence contradicts that premise: the finalized narrative is the
first seven pages of a 72-page document whose stated purpose is to be handed to
a client unedited. Whether the guard should therefore run over the Storyboard
narrative — at generation, at finalize, or not at all, given an Analyst reviews
and can edit it in between — is a real question this decision does not settle.
