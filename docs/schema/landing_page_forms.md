# landing_page_forms

The Typeform form SET each landing page owns, plus that form's **per-form
qualification** config. One row per form. Added in migration
`0110_landing_pages.sql`.

## Why a set (not one form per LP)

An LP usually has one form, but **editing an LP's Typeform ADDS a form** rather
than replacing it — so when a page switches forms, the old form's opt-in cycles
stay counted under that LP. `form_id` is **UNIQUE**, so a form belongs to at most
one LP (the partition that keeps per-LP opt-in counts clean). The **union of all
`form_id`s here is the eligible opt-in set** — what was `OPT_IN_FORMS` /
`HIGH_TICKET_TYPEFORM_FORM_IDS` / the insights cron `FORM_IDS`.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `bigserial` | PK. |
| `landing_page_slug` | `text` | FK → `landing_pages.slug` (ON DELETE CASCADE). |
| `form_id` | `text` | **UNIQUE, not null.** Typeform form_id — the lead-attribution key. |
| `typeform_title` | `text` | Form title (display/reference). |
| `qualify_field_ref` | `text` | The Typeform field ref the qualification reads (was the global `INVEST_FIELD_REF`). |
| `qualify_answers` | `text[]` | Answer LABELS that qualify a lead. Empty/null → the legacy "under-not-in" rule. |
| `is_primary` | `boolean` | The LP's current collecting form. |
| `created_at` | `timestamptz` | |

## Read by

- `shared/lead_tagging.py` `_load_form_cfg` — the eligible form set + per-form
  qualification, used when reconstructing `lead_cycles` (stamps `source_form_id`
  + per-cycle `qualified`). Falls back to `OPT_IN_FORMS` / `INVEST_FIELD_REF` if
  the read fails.
- `api/typeform_insights_cron.py` `_load_form_ids` — which forms to snapshot
  ("starts").
- `lib/db/landing-pages.ts` `getHighTicketFormIds` (TS read-side set).

## Written by

- `app/(authenticated)/sales-dashboard/landing-pages/actions.ts` (`saveLandingPage`).
  Seeded with `SFedWelr`→main and `Os4c0q6V`→training (qualify ref `5138f17b`,
  qualifying = the three `$2k+` tiers) in 0110.

## Related

- [`landing_pages`](./landing_pages.md) · `docs/sales/landing-pages.md`.
