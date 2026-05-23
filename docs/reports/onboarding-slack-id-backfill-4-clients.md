# Report: Onboarding webhook — backfill slack IDs for 4 clients via curl
**Slug:** onboarding-slack-id-backfill-4-clients
**Spec:** docs/specs/onboarding-slack-id-backfill-4-clients.md

## Files touched

Created:
- `docs/specs/onboarding-slack-id-backfill-4-clients.md` — the spec.
- `docs/reports/onboarding-slack-id-backfill-4-clients.md` — this report.

Modified:
- `docs/specs/onboarding-slack-id-backfill-4-clients.md` — `Status:` flipped from `in-flight` to `shipped`.

No code changes. Four production POST calls + one read-only cloud `SELECT`. Webhook secret was loaded from `.env.local` and used only in the `X-Webhook-Secret` header — never printed in logs, this report, or any file.

## What I did, in plain English

Fired the four `airtable_onboarding_webhook` POSTs one at a time, each with the exact payload from the spec. Every response came back `200` with `"action":"updated"` — meaning the email matched an existing client row and the slack IDs backfilled cleanly (no duplicate creation, no conflict). Then one cloud SELECT joining `clients` to `slack_channels` confirmed every row now has the right `slack_user_id` (on `clients`) AND the right `slack_channel_id` (on `slack_channels.client_id`).

## Verification

**Four webhook calls — all `200` + `action="updated"`:**

| # | Client | Email | Status | Action | client_id |
|---|---|---|---|---|---|
| 1 | Matt Solomon | `loumantis@gmail.com` | `200` | `updated` | `7d867535-d90e-44a8-8151-e9261b567943` |
| 2 | Catrina Bodamer | `katiebdee@gmail.com` | `200` | `updated` | `13fed9df-0886-4029-ad72-59fe6ec0c741` |
| 3 | Britney Fields-Feliz | `britney@fieldsfelizent.com` | `200` | `updated` | `d7c30f2d-a198-4609-8189-c4dce6bdc1ca` |
| 4 | Steve Lowery | `sal2177@gmail.com` | `200` | `updated` | `8d8ae219-f321-4d56-9594-199cc386b1f8` |

Each delivery also returned a unique `delivery_id` (captured in the bash output) — written to `webhook_deliveries` for audit. No `409` conflict, no `created`, no 4xx/5xx. STOP-and-surface gates didn't trigger on any call.

**Cloud SELECT verification (read-only, join on `slack_channels.client_id`):**

```
(4 rows)
  OK  Britney Fields-Feliz      user=U0B57RZU18F  channel=C0B57RFEA9M
  OK  Catrina Bodamer           user=U0B2HAH69GD  channel=C0B2E89QEHZ
  OK  Matt Solomon              user=U0B3M2F0AM6  channel=C0B3M1YML0G
  OK  Steve Lowery              user=U0B5A08Q1SP  channel=C0B6AG23QF2

OVERALL: ALL FOUR VERIFIED ✓
```

Every row matches the payload's `slack_user_id` (stored on `clients`) AND `slack_channel_id` (stored on `slack_channels` with `client_id` FK back to the client). Catrina's email is still `katiebdee@gmail.com` as expected (the spec was explicit: do NOT correct it here; that's a separate Drake dashboard action).

## Surprises and judgment calls

**Spec's verify-query had a column-name mismatch.** The spec's SELECT was `select email, slack_user_id, slack_channel_id from clients` — but `clients` doesn't have a `slack_channel_id` column. The channel mapping lives in `slack_channels.slack_channel_id` with a `client_id` FK back to `clients`. (This is consistent with the table separation: a client can have at most one active channel, modeled as a one-to-many that's currently one-to-one in practice.) Adapted the verify query to a `LEFT JOIN slack_channels sc ON sc.client_id = c.id`. The intent of the verification was preserved: confirm both IDs are stored where the webhook puts them. All four rows verified clean.

A first attempt also added `AND sc.archived_at IS NULL` defensively, but `slack_channels` doesn't have an `archived_at` column either — so the unfiltered join is correct. Removed it.

**Catrina's intentionally-uncorrected email worked as designed.** The webhook matched `katiebdee@gmail.com` against the existing client row (id `13fed9df-...`) and updated the slack IDs onto that row without touching the email. No new "Catrina" row got created. Per spec: separate Drake-side correction step.

**No secret leakage.** The webhook secret was read via `grep '^AIRTABLE_ONBOARDING_WEBHOOK_SECRET=' .env.local` into a local shell variable, passed in the `X-Webhook-Secret` header only. Never echoed, never written to this report or any file. The `delivery_id`s in `webhook_deliveries` are not secret (they're random UUIDs the API mints), so they're fine to surface here.

## Out of scope / deferred

- Catrina's email correction (`katiebdee@gmail.com` → her preferred address) is a separate Drake dashboard action per spec § Hard stops. Not in this scope.
- No new known-issues entries warranted — the spec's verify-query column mismatch is a one-line correction the next runner can pick up from this report (or a tiny spec to fix the runbook's example query); not blocking.

## Side effects

- **Four production POSTs** to `https://ai-enablement-sigma.vercel.app/api/airtable_onboarding_webhook` — each created an audit row in `webhook_deliveries` + updated the corresponding `clients` row + ensured the matching `slack_channels` row (per the webhook's existing upsert behavior). All four are idempotent re-fires (would yield `action="noop"` on a second identical send). The four client_ids returned are stable.
- **One read-only cloud `SELECT`** for verification — no writes.
- **Zero code changes**, zero schema changes, zero Slack posts.

This commits + pushes the spec + report to `main`.
