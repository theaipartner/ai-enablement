# landing_pages

The landing-page registry — one row per landing page. DB-backed source of truth
(was the static `lib/db/landing-pages.ts` array) so landing pages can be
added/edited in Gregory (`/sales-dashboard/landing-pages`) with no deploy.

Added in migration `0110_landing_pages.sql`. The form SET + per-form
qualification live in the child table [`landing_page_forms`](./landing_page_forms.md).

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `slug` | `text` | **PK.** `?lp=<slug>` key + stable id (kebab). |
| `label` | `text` | Not null. Dropdown + detail-page eyebrow. |
| `lp_path` | `text` | Canonical path, reference/labeling only. |
| `lp_url` | `text` | Full link pasted into the adder (drives auto-discovery). Null for the original seed rows. |
| `typeform_label` | `text` | Typeform-section subtitle on the LP detail page. |
| `vsl` | `jsonb` | Array of `{hashedId,label}` — the VSL video(s) embedded on the LP. |
| `confirm_video_hashed_id` | `text` | Thank-you / confirmation-page Wistia video. |
| `confirm_video_label` | `text` | Its label. |
| `active` | `boolean` | Not null, default `true`. Inactive = hidden from the dropdown, but its forms STAY eligible (cycles never dropped). |
| `sort_order` | `int` | Not null, default `0`. Dropdown ordering. |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` bumped by trigger. |

## Read by

- `lib/db/landing-pages.ts` — `getLandingPages` (active, the dropdown +
  LP-detail), `getLandingPage` (resolve a slug), `getAllLandingPages` (admin
  manager), `getHighTicketFormIds` / `getHighTicketVslHashedIds` (the eligible
  asset sets, union across all LPs). The funnel page, LP-detail page, and
  `funnel-typeform.ts` consume these.

## Written by

- `app/(authenticated)/sales-dashboard/landing-pages/actions.ts` — the admin
  manager (create / edit / activate / delete). Seeded with `main` + `training`
  in 0110 (exact mirror of the prior code registry).

## Related

- [`landing_page_forms`](./landing_page_forms.md) — the Typeform set + per-form
  qualification config.
- `docs/sales/landing-pages.md` — the runbook (how to add an LP).
