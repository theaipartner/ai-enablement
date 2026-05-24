# Report (Pt 2 — PARTIAL): Meta Ad Spend Ingestion (Google Sheet)

**Slug:** meta-sheet-ingestion
**Spec:** docs/specs/meta-sheet-ingestion.md
**Pt 1 (left intact):** docs/reports/meta-sheet-ingestion.md (the original scope-gate halt)
**Status:** halted — awaiting Drake's SQL review on migration 0044 (gate (a)). Sheets API working end-to-end; all code + tests + docs in place. Only the migration apply + bulk first-pull remain.

## Files touched

**Created:**
- `supabase/migrations/0044_meta_ad_daily.sql` — single new mirror table.
- `ingestion/meta/__init__.py` — module docstring.
- `ingestion/meta/sheets_client.py` — stdlib-urllib Sheets v4 reader (tab discovery + values fetch), bearer-token auth (caller passes the token).
- `ingestion/meta/parser.py` — header-name-keyed projection with CTR derivation + defensive numeric parsing + `HEADER_TO_COLUMN` source-of-truth map.
- `ingestion/meta/pipeline.py` — orchestrator (`sync_meta_ad_daily`) + `SyncOutcome` dataclass.
- `api/meta_sheet_sync_cron.py` — Vercel serverless cron mirroring `teams_calendar_sync_cron.py` shape.
- `tests/ingestion/meta/__init__.py` — pytest discovery marker.
- `tests/ingestion/meta/test_parser.py` — 17 parser tests.
- `tests/ingestion/meta/test_pipeline.py` — 6 pipeline tests.
- `tests/api/test_meta_sheet_sync_cron.py` — 9 cron-shell tests (auth + drake-lookup + OAuth-failure paths).
- `docs/schema/meta_ad_daily.md`
- `docs/runbooks/meta_sheet_ingestion.md` — includes scope-reauth procedure (which we already executed once today; documented so next time isn't a surprise).

**Modified:**
- `vercel.json` — added `api/meta_sheet_sync_cron.py` per-file runtime config + cron schedule `0 */3 * * *` (every 3 hours).
- `CLAUDE.md` — § Folder Structure adds `ingestion/meta/`.

**NOT touched (deferred to Pt 3 resume after gate (a) approval):**
- `docs/state.md` — ship entry lands after migration 0044 is applied + bulk-first-pull row count is known.

## What I did, in plain English

### Re-ran the scope check first

Per the spec gate fired in Pt 1, the first concrete action this session was to re-verify Drake's OAuth token scope:

```
scope:      'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/spreadsheets.readonly'
expires_at: 2026-05-24 02:52:14+00
updated_at: 2026-05-24 01:52:15+00 (the reconnect Drake just did)
```

PASS. Both scopes now present, freshly refreshed. Spec resumed.

### Live sheet discovery (validating spec assumptions)

Ran a one-shot smoke against the production Sheet via Drake's token — confirmed the spec's predictions match reality:

- **Tab:** literally named `Sheet1` (gid=0, 1000 rows × 26 cols allocated)
- **Headers:** match the spec exactly (10 columns: Day → CTR)
- **CTR column IS broken:** every row reads `1899-12-31` (the Sheets serial-0 percentage-as-date bug)
- **24 total rows:** 1 header + 23 data rows (2025-05-02 → 2026-05-23)
- **Duplicate `2026-05-23` rows present:** values `450.9` vs `449.33` — matches the spec's example verbatim. Cortana restates the current day.

This live read informed both the parser test cases (verbatim sample rows used as fixtures) and the design decision to derive CTR rather than mirror.

### Built the artifacts

Followed the established `ingestion/{fathom,close}/` shape:

- **`sheets_client.py`** — stdlib `urllib`, no SDK dep, same posture as `shared/google_oauth.py`. Two functions (`fetch_first_tab_title`, `fetch_values`) that take a bearer token and return parsed JSON / values arrays. Tab discovery is per-tick so a future Cortana rename of `Sheet1` doesn't break the cron.
- **`parser.py`** — `HEADER_TO_COLUMN` is the source-of-truth map for column-name → DB-column. Header-name-keyed so column re-order in a future Cortana export doesn't break parsing. CTR derivation in `_derive_ctr` (NULL-guarded against zero/missing impressions). Defensive numeric parsing strips `$` and `,`. Day-parse validates ISO date so header-echo / bottom-blank rows skip cleanly.
- **`pipeline.py`** — `sync_meta_ad_daily(db, token)` orchestrator: discover tab → fetch A:J → parse → per-row upsert with fail-soft. `SyncOutcome` dataclass surfaces `rows_parsed / rows_upserted / rows_failed / days_covered / warnings / errors` for the cron's audit row + HTTP response. Same code path serves cron + first-time bulk pull (the Sheet IS the history; one pull loads everything).
- **`api/meta_sheet_sync_cron.py`** — direct shape-clone of `api/teams_calendar_sync_cron.py`: `CRON_SECRET` bearer auth, drake-lookup via `team_members.email = drake@theaipartner.io`, `get_valid_access_token(drake.id)`, `sync_meta_ad_daily`, audit-row write to `webhook_deliveries` with `source='meta_sheet_sync'`. Reuses existing env vars — no new ones needed.

### Migration 0044

Single table `meta_ad_daily`:
- `day date PRIMARY KEY` (idempotency + DESC-scan covered for free)
- 8 source-mirror columns (`frequency`, `amount_spent`, `impressions`, `clicks_all`, `link_clicks`, `unique_link_clicks`, `cpm`, `cost_per_unique_link_click`) with appropriate `numeric` / `integer` types
- `ctr numeric` — DERIVED (NOT the broken source column)
- `ctr_source_raw text` — forensic capture of the broken `1899-12-31` value
- `created_at` / `updated_at` + `set_updated_at` trigger

No FKs (no other tables reference this), no extra indexes (PK covers the access patterns).

### Vercel cron + folder docs

- `vercel.json` gets the per-file Python runtime (mirroring fathom/teams precedent: `@vercel/python@4.3.1`, `maxDuration: 60`) AND the cron schedule `0 */3 * * *` (every 3 hours at the top of the hour).
- `CLAUDE.md` § Folder Structure adds `ingestion/meta/`.
- `.env.example` unchanged — no new env var; cron reuses `CRON_SECRET`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `SUPABASE_*` per spec.

## Verification

- **Scope check** — PASS, both scopes present, token freshly refreshed.
- **Live sheet read** — full end-to-end via Drake's token. Tab discovered, headers retrieved, values fetched, 24 rows parsed (header + 23 data rows), CTR brokenness confirmed, duplicate `2026-05-23` confirmed.
- **`python3 -m py_compile`** on every new file — exit 0.
- **`.venv/bin/python -m pytest tests/ingestion/meta/ tests/api/test_meta_sheet_sync_cron.py -v`** — **32/32 passing** in 2.52s.
- **Full suite `.venv/bin/python -m pytest tests/ -q`** — **765/765 passing** in 9.60s. No regressions (+32 new).
- **NOT verified yet** — the migration itself (HARD STOP for Drake's SQL review per spec gate (a)). The cron's first real bulk-pull is the natural smoke once the table exists.

## Surprises and judgment calls

- **3-hour cron cadence vs daily.** Spec said "daily or a few times daily — Builder recommends; a few-times-daily poll is cheap and catches restatements." Picked `0 */3 * * *` — every 3 hours at the top of the hour. Reasoning: Cortana restates the current day with corrected numbers across the day (proven by the duplicate `2026-05-23` rows with different spend), Sheets API is generous on quota (~8 calls/day for this cron vs 300/min limit), and 3 hours gives 8 chances per day to catch updates without burning quota or adding observability noise. Hourly would be fine too; daily would miss late-day restatements. Easy to dial up/down later.
- **Single-tab assumption hardcoded.** `pipeline.sync_meta_ad_daily` discovers the FIRST tab (`sheets[0].properties.title`) and reads A:J from it. If Cortana ever adds a second tab and writes data there, we'd miss it silently. Worth flagging — the runbook calls this out under § Out of scope. Easy to widen if it ever matters.
- **`HEADER_TO_COLUMN` keys on sheet header text, not column index.** A future Cortana export tweak that re-orders columns would still parse correctly; one that renames a column would log a warning + leave that column NULL on every row (not crash). Trade-off: a rename means a code change to keep the column mirrored. Logged warnings make this visible in the audit row.
- **CTR column source IS mapped — but to `ctr_source_raw`, not `ctr`.** This is intentional and tested (`test_ctr_source_column_routes_to_raw_not_to_derived_ctr`). The `ctr` column itself is computed downstream. If a future engineer reads the parser and thinks "this looks wrong, the source CTR column isn't being mirrored to `ctr`" — that's the design, see the schema doc's "Why CTR is derived" section.
- **`ctr_source_raw` will be `'1899-12-31'` on every row indefinitely** unless Cortana fixes the export. Storing it eats minimal space; recovering forensic transparency if the bug ever changes shape is worth the bytes.
- **Test fixtures use verbatim live data.** The parser tests use the EXACT header set + sample rows observed in the live Sheet on 2026-05-23. If Cortana changes the export shape significantly, these tests will break loudly — that's the correct behavior (drift surfaces immediately rather than silently corrupting data).
- **No standalone backfill script.** The spec said "a simple `--apply` run of the same pipeline against the full sheet range backfills it" — but the same code path (pipeline + cron) does this, so a separate script would be ceremony. The cron's first tick after deploy IS the backfill (loads all 23 current days). Documented in the runbook.
- **One-line edit to `CLAUDE.md` § Folder Structure committed in this spec's commit set.** Per the standing Director/Builder rule that doc edits ride in the spec's Builder work; this is a routine structural addition.

## Out of scope / deferred (Pt 3 resume work)

Held until Drake approves migration 0044:

- Apply migration 0044 via `supabase db push --linked` per `docs/runbooks/apply_migrations.md`.
- Dual-verify (schema reality via `to_regclass('public.meta_ad_daily')` + ledger via `supabase_migrations.schema_migrations`).
- Run the cron once manually via `curl` to confirm end-to-end works against the freshly-created table.
- Verify row count + date range (expected: 23 rows, 2025-05-02 → 2026-05-23).
- Compute + spot-check a couple of CTR values (e.g. for `2026-05-23` first row: 105 / 6088 * 100 = ~1.7247; the derive logic should match).
- Update `docs/state.md` with the Meta sheet ingestion ship entry.
- Write `docs/reports/meta-sheet-ingestion-pt3.md` per the partial-report convention (this PARTIAL stays intact).

Held for future specs (separate Director scope):

- Per-campaign / per-adset breakdown — requires Cortana to export a campaign-grouped sheet.
- Multi-sheet / multi-tab support — single-tab assumption today.
- Alerting on stale data (no row for `current_date` after N hours) — operational add-on if it becomes needed.

## Side effects

- **Google Sheets API:** ~3 read-only calls during the live discovery smoke (one `?fields=sheets.properties`, one A1:J5 sample, one A:J full). No writes.
- **Google OAuth:** one token-refresh implicitly (token was due for refresh; `get_valid_access_token` minted a fresh one + updated the `oauth_tokens` row). New `access_token_expires_at` is ~1h from now.
- **Supabase:** the scope-check SELECT against `oauth_tokens` + `team_members`. No writes to any mirror table (migration not applied yet → `meta_ad_daily` doesn't exist).
- **Slack / external services:** none touched.
- **Local filesystem:** no `.probe-out/` dumps (live read printed to stdout only, not persisted).
- **Vercel:** no deploy yet — code change will trigger auto-deploy on push to `main`. Once deployed, the cron function appears at `/api/meta_sheet_sync_cron` but won't actually run until the next `0 */3 * * *` tick OR a manual `curl` trigger. The cron is gated on migration 0044 existing — if it fires before the migration applies, every per-row upsert will fail (table doesn't exist), the audit row will say `failed`, but Close's auto-disable doesn't apply here so no operational damage. Once the migration applies, the next tick (or a manual re-trigger) lands cleanly.

---

## What's needed to unblock

**Drake's SQL review on `supabase/migrations/0044_meta_ad_daily.sql`** (spec gate (a)).

Key things to sanity-check:

1. **PK choice.** `day date primary key` — assumes one row per day. Cortana restates the same day with corrected numbers; the upsert is last-write-wins. Confirm that's the desired semantic (very likely yes).
2. **CTR-as-derived design.** `ctr numeric` is populated by the ingestion layer (`link_clicks / impressions * 100`), NOT from the Sheet's source column. `ctr_source_raw text` captures the broken `1899-12-31` value for forensics. The runbook + schema doc spell this out loudly so a future engineer doesn't try to "fix" it.
3. **Numeric column types.** `numeric` (unconstrained precision) for currency / floats, `integer` for counts. Sample values fit comfortably in both.
4. **Indexes.** PK on `day` covers point-lookup + DESC scans; no separate indexes added. Confirm no missing access pattern.
5. **No FKs.** This table doesn't reference any other; nothing references it today. Aggregation layer will JOIN on `day` against future cohort-date computations.
6. **Cron schedule `0 */3 * * *`** in vercel.json — confirm OK (or specify a different cadence).

After approval, I run:
```bash
DB_PW=$(...)  # per docs/runbooks/apply_migrations.md § Apply
supabase db push --linked --dns-resolver https --password "$DB_PW" --yes
```
Then dual-verify, then trigger one cron run manually via `curl`, then update `state.md` + write Pt 3 report.
