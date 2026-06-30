# Runbook: Meta Ads Ingestion (Meta Marketing API)

Schema docs: `docs/schema/meta_ad_daily.md`, `docs/schema/cortana_ad_daily.md`,
`docs/schema/cortana_campaign_daily.md`, `docs/schema/cortana_adset_daily.md`.
Module: `ingestion/meta_ads/`. Cron: `api/meta_sync_cron.py`.
Backfill: `scripts/backfill_meta_ads.py`. Tests: `tests/ingestion/meta_ads/`.

## What this ingestion does

Pulls the team's Meta ad data **straight from the Meta Marketing (Graph)
API** and mirrors it into the same four tables the sales dashboard already
reads. **Replaced Cortana** as the data source on **2026-06-30** (`ingestion/cortana/`
+ `api/cortana_sync_cron.py` are kept in the repo, unscheduled, for instant
revert — see § Revert).

| Meta `level` | Table | Grain |
|---|---|---|
| `account` | `meta_ad_daily` | account-wide daily spend/delivery (PK `day`) |
| `campaign` | `cortana_campaign_daily` | per-campaign daily (PK `day,entity_key`) |
| `adset` | `cortana_adset_daily` | per-ad-set daily (**native** now) |
| `ad` | `cortana_ad_daily` | per-ad daily |

The `cortana_*` table **names are unchanged** — six dashboard consumers +
the sales bot + the `sales_bot_ro` RLS role read them, and `meta_ad_daily`
already set the precedent of keeping its name through a source swap (Sheet →
Cortana). A rename to `meta_*` is a separate, optional later pass.

Per CLAUDE.md § Core Principles: this is a replaceable adapter in its own
module (`ingestion/meta_ads/`); the dashboard reads the mirror tables, never
the API.

---

## ⚠️ THREE STANDING WARNINGS (read these)

### 1. The access token is a 60-day USER token, NOT a System User token

`META_ACCESS_TOKEN` today is a **USER** token (verified via `/debug_token`:
`"type": "USER"`, with an `expires_at`). It is **not** a permanent System
User token. Two consequences:

- **It expires `2026-08-29 15:29 UTC`** (data-access window ends `2026-09-28`).
  When it lapses, **every cron tick raises `MetaAdsAuthError` (Meta code 190)
  and ad-spend data FREEZES** — the dashboard keeps showing the last synced
  day (stale, not crashed). The audit row in `webhook_deliveries`
  (`source='meta_sync'`) flips to `failed`/`partial` with the 190 message.
- **It is tied to a person** (Zain's user login, `user_id …2143`). If that
  account revokes the app, changes password/2FA, or loses access, the token
  dies **early**, before the expiry date.

**Why we shipped it anyway:** a System User token requires the app to be
registered/reviewed on Meta (a long process that wasn't done in time). The
USER token pulls byte-identical data today — the only cost is longevity.

**The fix (do this when the app is registered):** Meta **Business Settings →
Users → System Users** → create/select one → **Add Assets** (the ad
account(s), with View Performance / `ads_read`) → **Generate New Token**
(pick the app, scope `ads_read`, expiration **Never**). Confirm via
`/debug_token` it shows `"type": "SYSTEM_USER"` and **no** `expires_at`.
Then update `META_ACCESS_TOKEN` (Vercel + `.env.local`) and redeploy.

### 2. Renewing the current USER token (stop-gap if the System User isn't ready by Aug 29)

A 60-day user token can be re-extended **before it expires** by exchanging it
for a fresh long-lived token (needs the app secret):

```bash
curl -sG 'https://graph.facebook.com/v23.0/oauth/access_token' \
  --data-urlencode 'grant_type=fb_exchange_token' \
  --data-urlencode 'client_id=1199194128631289' \
  --data-urlencode "client_secret=<APP_SECRET>" \
  --data-urlencode "fb_exchange_token=<CURRENT_TOKEN>"
```

Update `META_ACCESS_TOKEN` with the returned token and redeploy. **Set a
calendar reminder ~2 weeks before `2026-08-29`.** (A System User token makes
this whole step disappear — prefer it.)

### 3. Ad-account timezone is fixed **EST (UTC-5)**, the dashboard uses ET (DST-aware)

`act_2293461684485411` reports in `timezone_name: "EST"` (fixed −5, **no
DST**). Meta buckets `time_increment=1` days in that account timezone, and we
store `date_start` verbatim as `day`. The dashboard treats `day` as
`America/New_York` (currently EDT/−4 in summer). So during DST the day
boundary sits 1 hour off ours — a sliver of near-midnight spend can land on
the adjacent calendar day vs the dashboard. This matches what the team sees
in Ads Manager and is immaterial for daily totals; just don't be surprised by
a near-midnight cent landing a day over.

---

## The API

- **Base:** `https://graph.facebook.com/v23.0` (override via `META_API_VERSION`).
- **Auth:** `Authorization: Bearer <META_ACCESS_TOKEN>` (scope `ads_read`).
- **Endpoint:** `GET /act_<id>/insights`
- **Key params:** `level` (`account|campaign|adset|ad`), `time_increment=1`
  (one row per day per entity), `time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}`,
  `fields` (see § Field map), `limit` (we use 500).
- **Pagination:** follow `paging.next` (a full URL with cursor + token) until
  absent. The client does this automatically.
- **One call per level** covers the whole window — no per-day fan-out (Cortana
  needed one call per day; Meta does not).

### Credentials (env vars)

- Local: `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID` (+ optional
  `META_API_VERSION`) in `.env.local`.
- **Production: set the same vars in Vercel Production env vars.** (CLI v52 is
  broken for env writes — use the Vercel dashboard. Env-var changes don't take
  effect until the next deploy.) `META_AD_ACCOUNT_ID = act_2293461684485411`
  ("USA - AI Partner Call Funnel"); the token is the secret.

## Field map (read off the live API 2026-06-30)

`ingestion/meta_ads/parser.py` is the source of truth.

| Our column | Meta field | |
|---|---|---|
| `meta_ad_daily.amount_spent` / `cortana_*.spent` | `spend` | |
| `impressions` | `impressions` | |
| `reach` | `reach` | |
| `frequency` | `frequency` | **native** (Cortana derived `impr/reach`) |
| `meta_ad_daily.clicks_all` / `cortana_*.clicks` | `clicks` | |
| `link_clicks` / `inline_link_clicks` | `inline_link_clicks` | |
| `unique_link_clicks` / `unique_inline_link_clicks` | `unique_inline_link_clicks` | |
| `unique_clicks` | `unique_clicks` | |
| `cpm` | `cpm` | |
| `cortana_*.ctr` | `ctr` | all-click CTR |
| `meta_ad_daily.ctr` | `inline_link_click_ctr` | **link** CTR (preserves the column's meaning) |
| `unique_ctr` | `unique_ctr` | |
| `meta_ad_daily.cost_per_unique_link_click` | `cost_per_unique_inline_link_click` | **native** (Cortana derived) |
| `cortana_*.cost_per_inline_link_click` | `cost_per_inline_link_click` | |
| `platform_entity_id` | `campaign_id` / `adset_id` / `ad_id` | numeric Meta id — **joins `close_leads.*`** |
| `entity_name` | `campaign_name` / `adset_name` / `ad_name` | |
| `entity_key` | `"<name>\|\|\|<id>"` | synthesized to match Cortana's PK shape |

**Not ported (mirrored by Cortana, read by ZERO dashboard code):** the
`conversions` jsonb attributed-funnel blob and the attributed rollup columns
(`leads`, `roas`, `total_revenue`, `page_views`, the creative-video metrics,
campaign budget fields). New Meta rows carry `conversions = {}` and those
columns NULL. The dashboard's funnel counts come from `close_leads` /
`lead_cycles` joined on the Meta ids (the `sales_funnel_counts` SQL fn), never
from this attribution — confirmed before the swap. **Historical Cortana rows
keep their values untouched.**

## Cron

`api/meta_sync_cron.py`, Vercel `0 */3 * * *`. Re-pulls a trailing **4-ET-day**
window each tick (one call per level) and upserts — absorbs Meta's ~72h
restatements (last-write-wins on the PKs). Each grain writes independently
(one grain throttling doesn't lose the others). Audit row to
`webhook_deliveries` with `source='meta_sync'`. Auth: `Authorization: Bearer
${CRON_SECRET}`.

Manual trigger:
```bash
curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://ai-enablement-sigma.vercel.app/api/meta_sync_cron
```

**⚠ 250 MB function cap:** `api/meta_sync_cron.py` has its
`"excludeFiles": "{.next,node_modules}/**"` entry in `vercel.json` — without
it the deploy bundles `.next/` and fails. Don't remove it.

## Backfill

```bash
# smoke: one complete day end-to-end against the REAL API, NO writes (run first)
.venv/bin/python scripts/backfill_meta_ads.py --smoke

# seed cloud (production) — psycopg2 path, last 4 days
.venv/bin/python scripts/backfill_meta_ads.py --days 4 --apply --cloud
```

Idempotent. Meta retains insights well beyond our needs; the practical horizon
is whatever the ad account has run.

## Cutover from Cortana (the steps taken / to verify)

The Cortana cron and this cron **both write the same four tables** — do **not**
run both. Cutover order:

1. Set `META_ACCESS_TOKEN` + `META_AD_ACCOUNT_ID` (+ `META_API_VERSION`) in
   Vercel Production env vars.
2. Push the commit that swaps the cron in `vercel.json`
   (`cortana_sync_cron` → `meta_sync_cron`) — done in this change.
3. After deploy, manually trigger `meta_sync_cron` and verify: an audit row
   with `source='meta_sync'`, a fresh `meta_ad_daily` row with
   `ctr_source_raw='meta_api'`, and that recent days roughly match the last
   Cortana numbers (spend within restatement noise).

## Revert (instant)

The Cortana code (`ingestion/cortana/`, `api/cortana_sync_cron.py`) and its
`vercel.json` **function entry** stay in the repo, unscheduled. To revert: in
`vercel.json` crons, swap `/api/meta_sync_cron` back to `/api/cortana_sync_cron`
and push. (`CORTANA_API_KEY` / `CORTANA_BUSINESS_ID` should remain set in
Vercel until the Meta cutover is confirmed stable.)

## Multi-account (deferred — see below)

The token can already see the whole ad-account fleet under the **AI Arbitrage**
business (id `206811243718995`): US + AUS Call Funnel, a **standby** account
(`act_4057282177838321`), and a **disabled** former USA account
(`act_1354598025968162`) — i.e. account-rotation-after-ban is a real, current
need. A DB-backed `meta_ad_accounts` registry + admin page (so a banned
account is swapped with no deploy) is the **planned next step**, deferred for
this single-account swap. Until then, rotating accounts = change
`META_AD_ACCOUNT_ID` in Vercel + redeploy. A System User token scoped to the
business would read all those accounts with one credential.

## Known gaps

- **Local DB** is a divergent offline mirror (stuck ~migration 0011); cloud is
  the system of record. Verify against cloud only.
- **Attribution not ported** — see the field-map note. If a future surface
  ever needs ad-level attributed conversions, that comes from Meta `actions` /
  a separate conversions integration, not this mirror.
