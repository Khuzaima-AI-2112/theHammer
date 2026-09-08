# Vertex AI model migration — primary-source research

**Checked:** 2026-09-08. Every page below was fetched on that date; Google edits these
pages without notice, so re-verify before acting on anything more than a week later.

**Scope:** replaces the UNCONFIRMED figures in issue #108 with facts traced to Google's
own documentation. No third-party trackers, blogs, or forum posts are used as evidence;
where a forum post is the only source for a claim it is labelled unconfirmed and excluded
from the recommendation.

**Note on URLs:** Google moved `cloud.google.com/vertex-ai/generative-ai/docs/*` to
`docs.cloud.google.com/...` (301). The docs URLs below are the post-redirect canonical
ones. The pricing pages are still on `cloud.google.com`.

---

## Recommendation

**Migrate to `gemini-3.5-flash`.**

It is the only current-generation (3.x) Flash model that Google lists as served in
`northamerica-northeast1`, it is GA, and its retirement date is "May 19, 2027 or later" —
so it does not force a second migration inside the year.

**`gemini-3.6-flash` — the target proposed in issue #108 — should not be used.** Two
independent reasons, both from Google's own pages:

1. It is **not served in `northamerica-northeast1`**. Google's regional availability
   matrix shows no support marker for it in Montréal.
2. It sits in Google's **"Models available for shorter availability periods"** bucket,
   which Google defines as: *"Short-term availability models retire 45 days after a
   replacement model is released."* Two replacements have already shipped —
   `gemini-3.7-flash` (2026-08-13) and `gemini-3.8-flash` (2026-09-02) — so `3.6-flash`
   is eligible for a 45-day retirement notice today. `3.7-flash` and `3.8-flash` are in
   the same bucket and are also absent from Montréal.

`gemini-3.5-flash` is in the *normal* lifecycle table with a dated, year-plus horizon —
a materially different commitment from Google than the short-term bucket.

The **cost increase is real and large** (~22x on input, ~4x on output vs 1.5-flash; ~5.5x
input / ~4x output vs 2.5-flash) and is a decision for the project owner, not a default —
see Pricing delta below. There is a cheaper Montréal-served option (`gemini-2.5-flash`,
current pricing) but it retires **2026-10-20**, roughly six weeks out.

---

## Facts table

| Model | Exact Vertex model id | Status | Retirement date (Vertex) | Pricing /1M tokens (text in / text out) | `northamerica-northeast1`? | Source |
|---|---|---|---|---|---|---|
| Gemini 1.5 Flash | `gemini-1.5-flash-001`<br>`gemini-1.5-flash-002` | **Retired** | `-001`: **May 24, 2025**<br>`-002`: **September 24, 2025** | legacy char-based table (see note) | n/a — retired | [lifecycle][L] |
| Gemini 2.5 Flash | `gemini-2.5-flash` | **GA** | **October 20, 2026** | $0.30 / $2.50 | **Yes** | [lifecycle][L], [locations][R], [pricing][P] |
| Gemini 3.5 Flash | `gemini-3.5-flash` | **GA** | **May 19, 2027 or later** | non-global: **$1.65 / $9.90**<br>(global: $1.50 / $9.00) | **Yes** | [lifecycle][L], [locations][R], [3.5-flash page][M35], [pricing][P] |
| Gemini 3.6 Flash | `gemini-3.6-flash` | **GA**, but short-term-availability bucket | "No retirement date announced" — but retires **45 days after a replacement ships**, and two already have | non-global: $0.825 / $4.125 through 2026-12-31, then $1.65 / $8.25 | **No** | [lifecycle][L], [locations][R], [pricing][P] |
| Gemini 3.7 Flash | `gemini-3.7-flash` | GA, short-term bucket | same 45-day rule | same as 3.6 | **No** | [lifecycle][L], [locations][R] |
| Gemini 3.8 Flash | `gemini-3.8-flash` | GA, short-term bucket | same 45-day rule | same as 3.6 | **No** | [lifecycle][L], [locations][R] |
| Gemini 2.5 Flash-Lite | `gemini-2.5-flash-lite` | GA | **October 20, 2026** | $0.10 / $0.40 | **No** | [lifecycle][L], [locations][R], [pricing][P] |
| Gemini 3.5 Flash-Lite | `gemini-3.5-flash-lite` | GA | **July 21, 2027 or later** | non-global: $0.33 / $2.75 | **No** | [lifecycle][L], [locations][R], [pricing][P] |

[L]: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/legacy/legacy-models
[R]: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations
[P]: https://cloud.google.com/vertex-ai/generative-ai/pricing
[M35]: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-5-flash

### Per-question detail

**1. `gemini-1.5-flash` — confirmed retired.**
Google's lifecycle page lists it under **"Retired models"**, verbatim:

> `gemini-1.5-flash-001` | May 24, 2024 | May 24, 2025 | `gemini-2.5-flash-lite`
> `gemini-1.5-flash-002` | September 24, 2024 | September 24, 2025 | `gemini-2.5-flash-lite`

Both point versions are past their retirement date. The unversioned alias
`gemini-1.5-flash` (what the code actually sends) does not appear in any current
availability table. It is not callable on Vertex AI.
Source: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/legacy/legacy-models

Note the issue's separate claim — that 1.5 was withdrawn from projects with *no prior
usage* on 2025-04-29 — is **not** something I could locate on a current Google page. It
may well be true and was true historically, but it is now moot: the models are retired
outright, which is confirmed. See Open questions.

**2. `gemini-2.5-flash`.**
- Exact id: `gemini-2.5-flash` (unversioned; this is the form the lifecycle and locations
  tables use).
- **GA.**
- **Retirement: October 20, 2026**, per Vertex's own lifecycle table. Recommended
  replacement listed by Google is "Gemini 3.5 Flash-Lite or Gemini 3.1 Flash-Lite" —
  note *neither of those is served in Montréal*, which is why this note recommends
  `gemini-3.5-flash` instead.
- Pricing: **$0.30 / 1M text input**, **$2.50 / 1M text output** (audio input $1.00).
  No global/non-global split for 2.5.
- **Served in `northamerica-northeast1`: yes.**
- ⚠️ **Source conflict on the date** — see Open questions. Issue #108's "2026-10-16" is
  not confirmed.

**3. `gemini-3.6-flash` — the id exists, but it is the wrong target.**
- Exact id: `gemini-3.6-flash`. Released 2026-07-21. GA.
- **Not served in `northamerica-northeast1`.**
- Listed in the **short-term availability** bucket, retiring 45 days after a replacement
  ships. `gemini-3.7-flash` and `gemini-3.8-flash` have both shipped since.
- Pricing (non-global): $0.825 in / $4.125 out through 2026-12-31; **$1.65 in / $8.25 out
  from 2027-01-01**. The promotional half-price window expiring is itself a reason to
  price the migration on the 2027 rates, not today's.
- The **actual current-generation Flash model on Vertex AI** is `gemini-3.8-flash`
  (released 2026-09-02) — also not served in Montréal, also short-term bucket. The newest
  Flash model that Montréal actually serves is **`gemini-3.5-flash`**.

**4. TTS — answered separately below.**

**5. Region check — see the dedicated section below.**

**6. Pricing delta — see below.**

---

## The TTS question

**`gemini-2.5-flash-preview-tts` is not a Vertex AI model id.** It appears nowhere in
Google's Vertex AI locations matrix, nor in the Gemini-TTS model documentation. The string
in `backend/src/routes/admin/storyboards.js:222` matches a **Gemini API (ai.google.dev)**
preview id, not a Vertex one — which is consistent with the rest of #108's picture, where
the Vertex call has never actually succeeded and so the wrong id has never been caught.

On the Gemini API deprecations page it is still listed as a *preview* model with
"No shutdown date announced" and a recommended replacement of `gemini-3.1-flash-tts-preview`:

> `gemini-2.5-flash-preview-tts` | May 20, 2025 | No shutdown date announced | `gemini-3.1-flash-tts-preview`

Source: https://ai.google.dev/gemini-api/docs/deprecations

**The Vertex AI TTS models actually served in `northamerica-northeast1` are, verbatim from
Google's region table:**

> `northamerica-northeast1` | Canada | `gemini-2.5-flash-tts`, `gemini-2.5-flash-lite-preview-tts`

Source: https://docs.cloud.google.com/text-to-speech/docs/gemini-tts (the "Available
regions" section, "For Vertex AI API, the following regions are supported" table)

**Recommendation: `gemini-2.5-flash-tts`.** It is the **GA** model (the docs mark
`gemini-2.5-flash-lite-preview-tts` and `gemini-3.1-flash-tts-preview` explicitly as
Preview), it is served in Montréal, and it is the direct GA equivalent of what the code
was reaching for.

`gemini-3.1-flash-tts-preview` — the successor Google names on the Gemini API side — is
**global-endpoint only**. Google's own table lists it under `global | Global (Non-DRZ)`
and nowhere else. Using it would mean sending narration text out of the Canadian region,
which is exactly the data-residency question ADR-0002 flags. Do not adopt it.

**TTS pricing** (Cloud Text-to-Speech pricing page, applies to Gemini-TTS):

| Model | Input | Output |
|---|---|---|
| Gemini 2.5 Flash TTS / 2.5 Flash-Lite Preview TTS | $0.50 / 1M text tokens | $10.00 / 1M audio tokens |
| Gemini 3.1 Flash TTS (Preview) | $1.00 / 1M text tokens | $20.00 / 1M audio tokens |
| Gemini 2.5 Pro TTS | $1.00 / 1M text tokens | $20.00 / 1M audio tokens |

Audio tokens are billed at **25 tokens per second of audio**, so a 60-second narration
clip is ~1,500 audio tokens ≈ **$0.015**.
Source: https://cloud.google.com/text-to-speech/pricing

No free tier: the page states "Not available" under free usage limit for every Gemini-TTS
model.

---

## Region check (`northamerica-northeast1`) — the load-bearing fact

This was verified **twice, from two independent Google pages**, because it is the fact the
whole recommendation turns on.

**Source 1 — the Vertex AI regional availability matrix.**
https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations

The Americas table has columns `Montréal (northamerica-northeast1)` and
`São Paulo (southamerica-east1)`. Under Montréal, the **only** Gemini models carrying a
"Supported" marker are:

- `gemini-3.5-flash` ✅
- `gemini-2.5-pro` ✅
- `gemini-2.5-flash` ✅
- `gemini-embedding-001` ✅ (plus Embeddings for Text / Multimodal)
- `virtual-try-on-001` ✅
- TTS: `gemini-2.5-flash-tts` ✅, `gemini-2.5-flash-lite-preview-tts` ✅

Every other Gemini row — including `gemini-3.8-flash`, `gemini-3.7-flash`,
**`gemini-3.6-flash`**, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`,
`gemini-3-flash-preview`, `gemini-2.5-flash-lite`, and the Omni previews — has **no
support marker** for Montréal.

**Source 2 — the `gemini-3.5-flash` model page's own region list.**
https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-5-flash

Verbatim from the "Supported regions / Model availability" block:

> Global: `global` — Multi-region: `us`, `eu` — **Americas: `northamerica-northeast1`** —
> Europe: `europe-west2`, `europe-west3` — Asia Pacific: …

**Conclusion: `gemini-3.5-flash` is unambiguously served in `northamerica-northeast1`.**
The recommendation requires no region change, and therefore raises no PIPEDA / Quebec
Law 25 question and needs no client decision on residency.

**Corollary that does need flagging:** had `gemini-3.6-flash` been adopted as #108
proposed, it could only have been reached via the `global` endpoint — which routes
processing outside Canada. Google's own note on the TTS page makes the mechanism explicit:
*"The ML processing for these models occurs within the specific region or multi-region
where the request is made."* Choosing a Montréal-served model avoids that entirely.

**On ADR-0002:** the ADR at `docs/adr/0002-launch-north-america-only.md` carries a header
marking it **"Superseded on 2026-08-25 by ADR 0008"**, on the grounds that theHammer is
not operated commercially in any jurisdiction. So the residency constraint may be weaker
than the brief assumed. This does not change the recommendation — `gemini-3.5-flash` is
served in Montréal either way, so no trade-off has to be made — but anyone reasoning from
ADR-0002 should read ADR-0008 first.

---

## Pricing delta

Rates below are per 1M tokens, **text input / text output**, standard pay-as-you-go (not
Priority, not Flex/Batch), from https://cloud.google.com/vertex-ai/generative-ai/pricing.

`northamerica-northeast1` is a **non-global** region, so 3.x models bill at the
**non-global rate — a 10% premium over the global rate**. This split does not exist for
2.5-era models. The rates below use the non-global column, which is the one that applies.

| Model | Input /1M | Output /1M |
|---|---|---|
| `gemini-1.5-flash` (retired; legacy char-based table) | ~$0.075 | ~$0.30 |
| `gemini-2.5-flash` | $0.30 | $2.50 |
| **`gemini-3.5-flash` (recommended, non-global)** | **$1.65** | **$9.90** |
| `gemini-3.6-flash` non-global, through 2026-12-31 | $0.825 | $4.125 |
| `gemini-3.6-flash` non-global, from 2027-01-01 | $1.65 | $8.25 |

**1.5-flash → 3.5-flash: roughly 22x on input and 33x on output.**
**2.5-flash → 3.5-flash: roughly 5.5x on input and 4x on output.**

Sanity check on absolute size: a report generating ~2,000 input and ~1,000 output tokens
costs about **$0.013** on `gemini-3.5-flash` versus about **$0.0004** on 1.5-flash. The
multiplier is dramatic; the per-call amount is around a cent. Whether that matters depends
entirely on call volume, which this note does not estimate — but it should be stated to
the project owner as "about a cent a report, up from a twentieth of a cent", not as "33x",
which sounds worse than the dollar figure warrants.

Cheaper options exist but each has a catch:
- `gemini-2.5-flash` ($0.30/$2.50) is 5.5x cheaper but **retires 2026-10-20**.
- `gemini-3.5-flash-lite` ($0.33/$2.75) is comparably cheap and long-lived but is
  **not served in Montréal**.
- **Flex/Batch pricing halves the cost** of 3.x models ($0.75/$3.75 global for 3.6-class)
  and Vertex lists Batch inference as Supported on `gemini-3.5-flash`. Since report
  narration is an async worker job, not an interactive request, batch mode may be a
  legitimate lever here. Not costed in this note — flagged as a follow-up.

### ⚠️ The 1.5-flash figures are a conversion, not a quotation

Google's legacy pricing table prices Gemini 1.5 **per 1,000 characters**, not per token:

> Gemini 1.5 Flash — Text Input $0.00001875 / 1,000 count · Text Output $0.000075 / 1,000 count

The $0.075 / $0.30 per-1M-token figures above are the conventional ~4-characters-per-token
conversion. They line up with the widely-quoted 1.5-flash token rates, but **the per-token
figure is my arithmetic, not Google's published number.** The 2.5 and 3.x figures are
quoted directly and need no conversion. Since 1.5-flash is retired and unusable, this only
affects the size of the "before" number in the multiplier, not the decision.

---

## Open questions and things I could NOT confirm

1. **`gemini-2.5-flash` retirement date: the two Google properties disagree.** This is a
   genuine conflict between primary sources, shown both ways:
   - **Vertex AI lifecycle page** — `gemini-2.5-flash` | June 17, 2025 | **October 20, 2026** |
     Gemini 3.5 Flash-Lite or Gemini 3.1 Flash-Lite.
     https://docs.cloud.google.com/vertex-ai/generative-ai/docs/legacy/legacy-models
   - **Gemini API deprecations page** — `gemini-2.5-flash` | June 17, 2025 |
     **"No shutdown date announced"** | (no replacement listed).
     https://ai.google.dev/gemini-api/docs/deprecations

   These are different products with independently managed lifecycles, so both can be
   correct. theHammer calls **Vertex**, so **October 20, 2026 is the date that binds us.**

2. **Issue #108's "2026-10-16" is NOT confirmed and appears to be wrong.** The issue
   states 2.5-flash "retires 2026-10-16 (Gemini API) / ~2026-10-20 (Vertex)". The Vertex
   half checks out exactly. The Gemini API half does not: ai.google.dev currently shows
   *no* shutdown date for `gemini-2.5-flash`. The 2026-10-16 figure appears in Google
   developer *forum* threads, which are not primary sources and are excluded here. Treat
   2026-10-16 as **unverified**; use **2026-10-20**.

3. **The "withdrawn from projects with no prior usage on 2025-04-29" claim is
   unconfirmed.** This appears in #108 and in `lessons_learned.md:888` as the mechanism
   behind the 1.5-flash failure. I could not find it on any current Google page. It is
   plausible and was likely accurate when written, but it is **moot** — the models are now
   listed as outright retired, which *is* confirmed, and that alone explains the 404.
   Nothing depends on resolving it.

4. **Issue #108's pricing figures were partly right, partly mismatched.** The quoted
   "$1.50 / $7.50 for 3.6-flash" matches Google's **global** 3.6-flash rate from
   2027-01-01 — but not the current promotional rate ($0.75/$3.75 global, through
   2026-12-31), and not the non-global rate Montréal would actually pay ($1.65/$8.25 from
   2027). The "$0.30 / $2.50 for 2.5-flash" is exactly right. So the numbers were in the
   right neighbourhood but conflated three different columns.

5. **No retirement date for `gemini-2.5-flash-tts` could be found.** It does not appear in
   the Vertex lifecycle tables at all (which cover text, image, and embedding models but
   not TTS), nor on the Gemini API deprecations page under that id. Its absence from the
   deprecation lists is consistent with "not scheduled for retirement", but that is an
   inference from silence, **not a positive confirmation from Google**. Worth re-checking
   before the storyboard TTS path is declared done.

6. **Not verified against a live API call.** Everything here is documentation. Per #108,
   `aiplatform.googleapis.com` has never been enabled on the `thehammer` project and there
   is no `hammer-dev` project to test against, so **no model id in this note has been
   proven callable from this account.** The documentation is strong evidence that
   `gemini-3.5-flash` is available in `northamerica-northeast1`; it is not proof that
   *this project* can call it. A single `generateContent` probe against the Montréal
   endpoint would close that gap and is worth doing before the code change lands.

7. **Batch/Flex pricing not costed.** Flagged above as a possible ~50% cost lever for an
   async worker workload. Not researched in depth.

---

## Code locations this affects

For convenience — these are the sites naming a dead model id (matches the table in #108,
re-verified 2026-09-08):

| File | Line | Current value |
|---|---|---|
| `backend/src/routes/admin/projects.js` | 55, 77, 176 | `'gemini-1.5-flash'` |
| `backend/src/worker/reportsWorker.js` | 24 | `'gemini-1.5-flash'` |
| `backend/src/worker/ocrWorker.js` | 33 (comment), 108 | `'gemini-1.5-flash'` |
| `backend/src/routes/admin/storyboards.js` | 484 | `'gemini-1.5-flash'` |
| `backend/src/routes/admin/storyboards.js` | 218 (comment), 222 | `'gemini-2.5-flash-preview-tts'` |
| `portal/app.js` | 518, 532 | `'gemini-1.5-flash'` |
| `docs/architecture.md` | 394, 423 | prose naming `gemini-1.5-flash` |

Plus test fixtures in `backend/tests/storyboard-*.test.js`,
`backend/tests/reports-ocr-unimplemented.test.js`, and `portal/tests/project-id.test.js`.

Note `portal/app.js` writes the default into a `<select>` — the portal has a model
dropdown whose options were not audited here and will also need updating alongside the
allowlist #108 calls for.
