# Report: Typeform Discovery — Form Inventory + Response-Shape Viability
**Slug:** typeform-discovery
**Spec:** docs/specs/typeform-discovery.md

Executed on branch `worktree-b` at `~/projects/ai-enablement-b` (parallel-work integrity check — confirmed via `git branch --show-current`). No writes to Typeform, Supabase, or shared infra. Findings below + raw JSON under `.probe-out/typeform/` (git-ignored, local-only).

## 1. Files touched

**Created:**
- `scripts/explore_typeform_api.py` — read-only probe (urllib, no deps), throwaway. Mirrors `explore_calendly_api.py` shape: `load_token()`, `_request()` with retry on 429 + hard-stop on 401/403, `_write()` for JSON dumps, numbered sections in `main()`. Masks PII (email / phone_number / text / long_text / url answer values + hidden-field email-pattern values) before writing or printing. Local outputs land in `.probe-out/typeform/` (git-ignored via existing rule).
- `docs/reports/typeform-discovery.md` — this report.

**Modified / deleted:** none.

## 2. What I did, in plain English

Built a 6-step probe against the live Typeform API using the existing `TYPEFORM_API_KEY` in `.env.local` (spec said `TYPEFORM_API_TOKEN`; resolved by accepting either, same pattern Calendly used). Confirmed auth via `/me`, paginated through the full form catalog (31 forms, single page), pulled response counts per form via `/forms/{id}/responses?page_size=1` to read `total_items`, fetched full form definitions for the top 5 by volume to surface the question shape (`fields[]` with `ref` / `id` / `type` / `title` + `choices` for choice questions), pulled a 3-response sample per candidate form with PII masked to capture the real `answers[]` structure, and tested date-filter + pagination on the highest-volume form to confirm backfill viability.

Hit one real API constraint mid-probe — `before`/`after` cursor params return HTTP 400 when combined with `sort`. Resolved by re-running with `sort` omitted (Typeform defaults to `submitted_at desc`, which is what we want for cursor backfill anyway). Patched the probe so the published artifact runs clean end-to-end.

## 3. Verification

**Auth:** `/me` returned account `alias='The AI Partner'`, `email='nabeel@theaipartner.io'`, `language='en'`. No 401/403.

**Form inventory:** 31 forms total, single page (page_count=1, total_items=31). Full list with `id` + `last_updated_at` + `title` printed; raw at `.probe-out/typeform/02_forms.json`.

**Response counts:** queried per-form via `?page_size=1` (`total_items` is on every page). Top 8 by volume:

| count   | last_submitted        | id         | title |
|---------|-----------------------|------------|-------|
| 10,319  | 2026-05-21T13:54:04Z  | PWSNd0h2   | US TF Funnel → ClickFunnels (go.theaipartner.io) — Setter Funnel |
| 2,528   | 2025-11-10T13:59:59Z  | w0atrvMi   | The AI Partner Application |
| 484     | 2025-12-29T20:13:46Z  | poifwp1H   | Please click "Start" to begin your application process |
| 429     | 2026-05-24T15:55:28Z  | SFedWelr   | US TF Funnel → CF (go.theaipartner.io/lp) → Closer Funnel |
| 424     | 2026-02-13T13:37:02Z  | QmTC4Tx2   | Go.TheAIPartner.io |
| 406     | 2025-06-04T23:24:17Z  | rlUtqsaA   | DSA Application! |
| 185     | 2026-04-28T13:39:41Z  | N57lwMmA   | Organic Typeform |
| 135     | 2026-02-05T08:02:39Z  | lf55tWt3   | AUS TF Funnel (new) → ClickFunnels (go.theaipartner.io) |

Below 135: 23 more forms ranging from 95 down to 0 responses (test forms, archived funnels, copies). Full list in `.probe-out/typeform/03_response_counts.json`.

**Funnel-relevant candidates (Drake mapping target):**
- **PWSNd0h2** — currently active Setter Funnel; submitted as recently as 2026-05-21; ~10k history.
- **SFedWelr** — currently active Closer Funnel; submitted 2026-05-24 (today); ~429 history, newer form.
- **w0atrvMi** — historical "AI Partner Application"; stopped 2025-11-10; large back-volume (2,528) but no recent traffic.
- **poifwp1H, QmTC4Tx2** — older variants of the same funnel pattern (same shared question refs); now superseded by PWSNd0h2 / SFedWelr.
- **N57lwMmA, lf55tWt3, KvckvaGl, rlUtqsaA** — organic / AUS / LTO / DSA variants. Lower volume; status unclear.

**Form definition shape (confirmed for all 5 candidates):**
- 4-5 fields per form, all with `ref` AND `id` populated. **All `ref`s unique within each form** (5/5 on every candidate). `ref` is the stable key to use for answer-to-question mapping.
- Field types in the funnel forms: `multiple_choice`, `contact_info` (which expands into nested first_name / last_name / email / phone_number subfields). One form (QmTC4Tx2) uses standalone `email` + `contact_info` instead of contact_info alone.
- **Shared question refs across funnel variants** (cross-form stability): `670168f4-e25d-…` ("Are you interested in building a profitable AI business?") appears with the SAME ref on PWSNd0h2, poifwp1H, SFedWelr. `bd4e0524-…` ("monthly income"), `5138f17b-…` ("imagine 6 months"), `78609038-…` ("best email address") similarly stable across the 3 funnel variants. This means a single `ref`-keyed answer-mapping can serve multiple funnel forms without per-form configuration.
- **Hidden fields are uniformly utm + Meta-ad tracking**: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `ad_id`, `ad_name` everywhere; the active funnels add `fbp`, `fbc`, `ip`, `event_id`, `campaign_id`, `adset_id`. SFedWelr adds `funnel`. These are NOT respondent PII — they're attribution metadata and worth mirroring directly.
- Welcome/thankyou screens + logic rules present but ingestion-irrelevant (UI flow only).

**Real response shape (PII-masked):** every candidate form's top-level keys are identical — `['answers', 'calculated', 'hidden', 'landed_at', 'landing_id', 'metadata', 'response_id', 'response_type', 'submitted_at', 'thankyou_screen_ref', 'token']`. SFedWelr additionally carries `outcome` and `variables` (the form has more logic). Example for PWSNd0h2 (PII masked):

```
landed_at:           "2026-05-21T13:52:27Z"
submitted_at:        "2026-05-21T13:54:04Z"
response_id:         "upjjv93lhtee22blkduwupjjv2814uzt"
token:               "upjjv93lhtee22blkduwupjjv2814uzt"   ← same value as response_id
response_type:       <not shown in head — present in JSON>
thankyou_screen_ref: "<screen ref>"
landing_id:          "<id>"
metadata: {
  browser, network_id, platform, referer, user_agent
}
hidden: {
  utm_source: "ig", utm_medium: "paid", utm_campaign: "120246387294960748",
  utm_content: "120246387338210748", utm_term: "aaid_<...>",
  ad_id: "", ad_name: "", adset_id: "", campaign_id: "",
  event_id: "ad71147d-...", fbc: "fb.1.1779371530.PAZX...",
  fbp: "", ip: "162.200.246.132"
}
calculated: { score: 0 }
answers: [
  { field: { ref: "670168f4-...", id: "1g0cvUrRvS", type: "multiple_choice" },
    type: "choice",
    choice: { id: "gyCO95NnIorl", ref: "c4dc1b24-...", label: "Yes, I am looking to build a profitable…" } },
  { field: { ref: "bd4e0524-...", id: "M7VwoUepJD", type: "multiple_choice" },
    type: "choice",
    choice: { id: "og6WlBmpup8U", ref: "f02a73af-...", label: "Below $1,000" } },
  { field: { ref: "5138f17b-...", id: "qjxJZ34Jd6", type: "multiple_choice" },
    type: "choice",
    choice: { id: "56Y2RqAPbt0T", ref: "3d4e38a4-...", label: "Under $2,000" } },
  { field: { ref: "ae611fb7-...", id: "WtuXN0Y7zN", type: "email" },
    type: "email", email: "<redacted-email>" },
  { field: { ref: "5c7917b0-...", id: "eHW0fr7V6p", type: "short_text" },
    type: "text", text: "<redacted-text len=6>" },     ← first_name from contact_info
  { field: { ref: "a75fb05b-...", id: "E3mhme3PdP", type: "short_text" },
    type: "text", text: "<redacted-text len=2>" },     ← last_name from contact_info
  { field: { ref: "c3c3fe18-...", id: "cxwj0bqfTs", type: "phone_number" },
    type: "phone_number", phone_number: "<redacted-phone>" }
]
```

Key shape observations:
- `response_id` and `token` carry the **same string** — either is fine as the primary key. Token is what's used in `before`/`after` cursors.
- Each `answers[]` entry has `field.ref` (the stable Drake-mappable key), `field.id` (system id), `field.type` (the question's declared type), and a top-level `type` (the answer-type tag — usually matches field.type for non-choice questions, is `choice`/`choices` for multiple_choice/dropdown). The actual value lives at `ans[type]` (i.e. `ans["email"]`, `ans["choice"]`, `ans["text"]`).
- `contact_info` group questions are flattened by Typeform into individual answers (email, phone_number, short_text × 2 for first/last name) referencing inner-field refs — NOT one composite "contact_info" answer.
- `hidden` is a flat string→string map; values can be empty when the funnel link didn't carry them.
- `calculated.score` is present but always `0` on the funnel forms (no scoring logic enabled).
- `metadata` carries browser/UA/referer fingerprints — useful for de-bot / channel inference if needed later.

**Date-filter + pagination viability (the load-bearing question):**

- **`since` / `until` filter works**: `?since=2026-04-24T16:31:39&page_size=1` on PWSNd0h2 returned `total_items=837` for the last 30 days, confirming server-side date filtering.
- **`before`-cursor pagination works** WITHOUT the `sort` param:
  - Default sort is `submitted_at desc` (newest first).
  - First page: 3 items, total_items=10319, page_count=3440 at page_size=3.
  - Second page using `before=<oldest token from first page>`: 3 fresh items, **zero overlap** with first page, walking back in time as expected.
- **`sort` + `before`/`after` is rejected** with `HTTP 400 BAD_REQUEST: "can't use before/after param together with sort"`. Documented in the script comment so future-me / future-Builder don't re-discover it. Workaround: omit `sort` (default desc is what we want for cursor backfill); use `sort=submitted_at,asc` only when paging without a cursor (e.g. for the "oldest response" probe step).
- **History reach**: oldest response on PWSNd0h2 is `2025-09-04T23:17:41Z` — full ~9 months of history is available for backfill. (Older forms like w0atrvMi presumably go further back; not probed since they're not the active funnel.)
- **Backfill verdict: VIABLE.** A `typeform_responses` mirror keyed on `response_id` (= `token`) with a paginated cursor backfill (page_size up to 1000, default sort desc, walk via `before=<oldest seen token>` until exhausted) plus a going-forward incremental cron (since=<last_seen_submitted_at>, page through and upsert) is the natural shape — mirrors Close + Calendly's per-event pattern.

**What did NOT verify:** webhook delivery (out of scope; webhook subscriptions endpoint not probed); rate-limit ceiling under bulk pull (low-volume probe didn't trigger 429); whether `_links.responses` or `total_items` updates after edits/deletes (responses are append-mostly; not a current concern).

## 4. Surprises and judgment calls

**(a) Env var name mismatch.** Spec said `TYPEFORM_API_TOKEN`, `.env.local` has `TYPEFORM_API_KEY`. Followed the Calendly precedent (`scripts/explore_calendly_api.py:51-60`): `load_token()` accepts either name and prefers the one that's actually set. Drake's call for the future ingestion spec: keep using `TYPEFORM_API_KEY` (matches the existing entry, no rename needed) OR standardize on `TYPEFORM_API_TOKEN` (matches Drake's mental model when writing specs). Lean: **keep `TYPEFORM_API_KEY`**, because the secret is already named that in `.env.local` and likely in Vercel — rename has zero functional upside and one Drake gate-(d) chore. The script accepts both regardless.

**(b) `sort` + cursor incompatibility.** The Typeform docs imply `sort` and `before`/`after` are independent parameters; the live API rejects them when combined. Caught it on first run, fixed it on second run, documented inline in the script (`scripts/explore_typeform_api.py` Step 6b comment). Worth carrying into the ingestion spec — the backfill `client.list_responses(form_id, before=cursor)` must omit `sort` and rely on the default desc order. The validation principle from prior known-issues — "OpenAPI docs may not match deployed reality" — fired again here, exactly the case the `feedback_api_discovery_curl_probe` memory was for.

**(c) Cross-form question-ref stability.** Multiple active funnel variants (PWSNd0h2, poifwp1H, SFedWelr) carry the SAME field `ref`s for the same questions ("Are you interested…" = `670168f4-…` across all three). The form `id` is different per variant; the field `id`s are different; but the author-assigned field `ref`s are stable. This is a meaningful design lever for the ingestion: a `ref`-keyed answer-extraction layer would handle all funnel variants uniformly without per-form config. The ingestion-spec recommendation below leans on this.

**(d) `response_id` == `token`.** Same string in every sample. Cleaner to pick one as the canonical primary key; lean: `response_id` (semantic) is the column name, with `token` either dropped or mirrored for downstream API calls. Not a structural decision needed today — flagging for the ingestion spec.

**(e) The Engine-sheet mapping is genuinely undocumented.** Searched `docs/state.md`, schema docs, and runbooks — no record of which Typeform fields feed which Engine-sheet rows. Discovery's job here is exactly the spec's "invert the approach" plan: surface the full inventory and hand Drake the mapping. The candidate fields below are framed as the menu Drake picks from.

**(f) PII handling.** Followed the spec hard rule strictly: the committed report shows redaction placeholders (`<redacted-email>`, `<redacted-phone>`, `<redacted-text len=N>`), the in-script printing also redacts before stdout, and `.probe-out/typeform/05_responses_sample_*.json` files contain only masked values. The raw `.probe-out/` directory is git-ignored. Hidden-field values are NOT masked because they're marketing attribution (utm_*, fbp, fbc, ad_id, ip, etc.) — not respondent PII — except when a hidden field's name suggests PII (`name`, `email`, `phone`) or its value matches an email pattern, in which case it's masked too. IP addresses (e.g. `162.200.246.132`) ARE present in the raw `.probe-out/` JSON but NOT in this report; they're a quasi-identifier and worth a decision on whether to mirror in the future ingestion (lean: mirror, IPs are useful for fraud-detection / de-bot, and the source records are already in Typeform's database).

## 5. Out of scope / deferred

**Recommendation for the follow-up ingestion spec** (Drake + Director call, not settled — framed as the input for that decision):

- **Migration `0048`** — pre-assigned to this worktree. Main owns through `0047` (Calendly). Whatever the ingestion spec specifies will land at `0048`.
- **Proposed table shape:**
  - `typeform_forms` — mirror of `/forms/{id}` definitions, one row per form, columns: `form_id PRIMARY KEY`, `title`, `last_updated_at`, `fields jsonb` (the full flattened `fields[]`), `hidden_fields jsonb`, `definition_synced_at`. Lets us look up the question-ref-to-title map at query time without re-fetching from Typeform.
  - `typeform_responses` — mirror of responses, one row per submission, columns: `response_id PRIMARY KEY` (= `token`), `form_id REFERENCES typeform_forms`, `landed_at`, `submitted_at`, `metadata jsonb` (browser/UA), `hidden jsonb` (utm + ad attribution), `calculated jsonb`, `answers jsonb` (the raw `answers[]`), `ingested_at`. Indexed on `(form_id, submitted_at desc)` for time-window queries.
  - Optional `typeform_response_answers` — flattened-per-answer view (one row per question×response) keyed on `(response_id, field_ref)` for query ergonomics. Could be a materialized view over the jsonb instead of a real table. **Drake's call** whether ingestion writes both or just `typeform_responses` and the flattening lives at query time.
- **Ingestion shape:**
  - `ingestion/typeform/client.py` — urllib-only `_request()` mirroring `ingestion/close/client.py` posture (the codebase doesn't pull SDK deps). Retry on 429, hard-error on 401/403. **Crucial:** the `list_responses(form_id, before=cursor)` call MUST omit `sort` to avoid HTTP 400.
  - `ingestion/typeform/sync.py` — backfill (cursor-paginate from newest using `before=<oldest seen token>` until exhausted; upsert) + going-forward incremental (since=`max(submitted_at)` from `typeform_responses`, page through, upsert). Mirrors Close pattern.
  - `scripts/backfill_typeform_responses.py` with `--smoke` (one page real-API end-to-end) and `--apply` (full bulk), per the CLAUDE.md "real-API smoke test before --apply" rule.
  - Going-forward cron: 3-hour cadence is plenty (low-volume — ~5-10 responses/day on PWSNd0h2 lately). Match Wistia / Meta cron cadence.
- **Engine-sheet mapping** — DRAKE'S CALL. The candidate questions on the active funnels (using the stable cross-form `ref`s):
  | ref prefix | question | answer-type | candidate Engine row |
  |---|---|---|---|
  | `670168f4-…` | "Are you interested in building a profitable AI business?" | choice (Yes/No) | qualification gate? funnel-completion rate? |
  | `bd4e0524-…` | "What's your monthly income?" / "income at the moment?" | choice (5 brackets) | lead-quality segmentation? |
  | `5138f17b-…` | "Imagine 6 months from today, accomplished goal of…" | choice (4-5 brackets) | aspirational-income tier? |
  | `78609038-…` | "Best email address" / contact_info | email | identity resolution → `clients` join |
  | `ae611fb7-…` | standalone email field (when not in contact_info) | email | same |
  | `c3c3fe18-…` / `5229d90d-…` | phone (contact_info subfield) | phone_number | identity resolution |
  | `5c7917b0-…` / `a75fb05b-…` / `76bd7a2d-…` / `759268cd-…` | first / last name (contact_info subfields) | text | identity resolution |

  Plus the per-form `hidden` block (utm_source / utm_medium / utm_campaign / ad_id / ad_name / fbp / fbc / ip / event_id) for attribution-side rows.

  **Drake input needed:** name the specific Engine-sheet rows that should be populated from Typeform, the form(s) they pull from, and the grain (per-response → daily aggregate). Most likely shape based on the inventory: funnel-completion rate per day, lead-quality breakdown (income-bracket distribution), and identity-mapping into the existing `clients` table via email/phone match — but that's a guess until Drake confirms.

- **Identity resolution to `clients`** — the contact_info answers carry email + phone + name, and `clients` already has the `metadata.alternate_emails` / `alternate_names` patterns from § Client Identity Resolution. The ingestion spec should specify how a new Typeform response resolves to a client row (case-insensitive email-match against `clients.email` + `clients.metadata.alternate_emails`, fall through to no-link if unmatched — DO NOT auto-create a client row from a Typeform response without Drake's call). This is the bridge from per-response mirror to client-level signal.

- **PII / IP storage decision** — flagged in §4(f). The mirror is currently proposed to store raw `hidden` (including IP) and raw `answers` (including emails/phones/names). Drake's call whether to (i) mirror raw, (ii) hash IPs / emails at ingest, or (iii) split PII out into a separate restricted-access table. Lean: (i) mirror raw, because the data is already in Typeform's database (we're not creating new exposure) and the ingestion DB is Supabase service-role-only.

**Watch-posture items** (not blocking):
- Webhooks endpoint — Typeform supports per-form webhook subscriptions for realtime delivery; not probed today. The cron-based pull is sufficient for the funnel volume, but if real-time-ish ingest becomes desirable later (e.g. Slack-notify on a new application), webhook subscriptions would be the path. Park for a future spec.
- Rate-limit ceiling — not stressed today. Bulk backfill on the 10k-response form will need to budget for ~2 req/sec; at page_size=1000 that's ~11 requests for full backfill, well under any limit. Notable only if a future ingestion path enumerates 100+ forms.

## 6. Side effects

- **Real-world API calls:** ~80 GET requests against `api.typeform.com` (auth check + form list + 31 response-count probes + 5 form definitions + 5 response-sample fetches + 4 pagination/date-filter test requests on PWSNd0h2 + the diagnostic re-runs while diagnosing the `sort+before` 400). Read-only — no Typeform-side state changed. Account owner (`nabeel@theaipartner.io`) will see ~80 entries in the Typeform API access log; nothing alarming. Worth mentioning if Nabeel pings about API activity.
- **Local filesystem writes (NOT committed):** `.probe-out/typeform/01_me.json`, `02_forms.json`, `03_response_counts.json`, `04_form_def_<5 form_ids>.json`, `05_responses_sample_<5 form_ids>.json`. The `05_*` files contain PII-masked response samples; the others contain non-PII metadata + form definitions + redacted hidden field values. `.probe-out/` is git-ignored via line 72 of `.gitignore`. Safe to leave for Drake to inspect; safe to `rm -rf .probe-out/typeform/` afterward.
- **Supabase / Slack / Vercel / external integrations:** none touched.
- **Secrets handling:** `TYPEFORM_API_KEY` read from `.env.local` into a Python variable, used only as an `Authorization: Bearer` header. Never logged, never written to disk, never committed.
