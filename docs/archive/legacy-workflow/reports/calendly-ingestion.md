# Report (PARTIAL): Calendly Ingestion — Data Model + Live Webhooks + 7-Day Backfill

**Slug:** calendly-ingestion
**Spec:** docs/specs/calendly-ingestion.md
**Discovery (the input):** docs/reports/calendly-discovery.md
**Status:** halted — awaiting Drake's SQL review on migration 0047 (gate (a)). All code + tests + docs in place. Dry-run end-to-end against live Calendly is green. Only the migration apply + smoke + bulk backfill + Drake's webhook activation runbook remain.

## Files touched

**Created:**
- `supabase/migrations/0047_calendly_ingestion_tables.sql` — three tables (`calendly_event_types` reference + `calendly_scheduled_events` + `calendly_invitees`), URI-keyed, with the loose-FK + index strategy from spec.
- `ingestion/calendly/__init__.py` — module docstring + `CLOSER_EVENT_TYPE_NAMES = frozenset({"ai partner strategy call"})` config constant (one-line change if Drake/Aman expand it).
- `ingestion/calendly/client.py` — stdlib-urllib `CalendlyClient` with the mandatory `User-Agent` header (footgun 1), Bearer auth, 429 back-off + Retry-After respect, accepts `CALENDLY_API_KEY` OR `CALENDLY_API_TOKEN` env vars for backwards-compat.
- `ingestion/calendly/parser.py` — pure projection (event_type / scheduled_event / invitee → row dicts), denormalize hot fields, preserve raw_payload jsonb.
- `ingestion/calendly/pipeline.py` — orchestrator: per-row upsert helpers (used by both backfill + webhook), `sync_invitee_and_event` (webhook orchestration fetching the parent event), `sync_recent_events_with_invitees` (backfill walker, dedups across status iterations).
- `api/calendly_events.py` — Vercel serverless webhook receiver. HMAC SHA256 signature verify (Stripe-style `t=,v1=` header), replay-window guard, synthesized webhook_deliveries dedup key, event-type routing, fail-soft (always 200 on handled errors so Calendly doesn't auto-disable). Mirrors `api/close_events.py` shape.
- `scripts/register_calendly_webhook.py` — Drake-run helper to list/create/delete the org-scoped subscription pointing at the deployed receiver URL. Prints the signing key from Calendly's response.
- `scripts/backfill_calendly.py` — 7-day backfill (`now - 7d` lookback + 60d future-window) with `--smoke / --apply / --limit` modes per the operational convention.
- `tests/ingestion/calendly/__init__.py`, `tests/ingestion/calendly/test_parser.py` (15 tests), `tests/ingestion/calendly/test_pipeline.py` (15 tests), `tests/api/test_calendly_events.py` (26 tests) — **56 new tests total**, all green.
- `docs/schema/calendly_event_types.md`
- `docs/schema/calendly_scheduled_events.md` — includes the event-`name` vs `event_type_uri` filtering caveat + the EDT date-math gotcha + example queries for Engine rows 93/34/35.
- `docs/schema/calendly_invitees.md` — includes the reschedule semantics + the `rescheduled=false` filter that prevents double-counting.
- `docs/runbooks/calendly_ingestion.md` — the four footguns, the full Drake-gated 6-step Live activation runbook, backfill modes, idempotency, the DEFERRED "Follow Up Meetings" metric, failure-mode debugging.

**Modified:**
- `vercel.json` — added `api/calendly_events.py` per-file runtime (`@vercel/python@4.3.1`, `maxDuration: 60`, mirroring close_events.py / fathom_events.py).
- `CLAUDE.md` § Folder Structure — adds `ingestion/calendly/`.
- `.env.example` — added `CALENDLY_API_KEY` + `CALENDLY_WEBHOOK_SECRET` entries (both gate (d) for Vercel), with the spec-drift note about `_API_KEY` vs `_API_TOKEN` and the verbatim HMAC verification algorithm.

**NOT touched in this pass** (deferred to Pt 2 resume after gate (a) approval):
- `docs/state.md` — ship entry lands after migration applies + backfill row counts known.

## What I did, in plain English

### Acclimatization

Re-read the discovery report's key findings — event shape verified end-to-end, event-type catalog has 14 active types, "AI Partner Strategy Call" dominant, date-math feasible (100/100 events had both timestamps), 10 existing webhook subscriptions confirm plan-tier supports webhooks. Confirmed migration counter is at 0046; next is 0047. Re-read `api/close_events.py` + `ingestion/close/pipeline.py` for the webhook-receiver shape to mirror.

Two pre-flight checks against the live Calendly API:
- **Webhook signature scheme:** docs portal is locked behind a SPA that the WebFetch tool can't load; pieced together from web search results + community posts + standard Stripe-style conventions. Implemented `t=<ts>,v1=<hex>` parser + HMAC SHA256 over `f"{ts}.{body}".encode()` with secret-as-UTF-8-bytes. **Caveat documented in code + runbook + this report:** if Calendly's actual format differs (e.g. no period separator, different hash, base64 instead of hex), the first real delivery will 401 and we adjust based on the captured header in `webhook_deliveries.headers` (timestamp portion preserved; v1 portion redacted for safety).
- **Backfill query params:** confirmed `/scheduled_events` only filters by `start_time`, not `created_at`. Chose to pull a wide window (`-7d to +60d start_time`) and let aggregation bucket by `event_created_at`. Discovery had already noted this distinction.

### Schema (migration 0047) — three tables

- **`calendly_event_types`** (reference, ~14 rows, `uri text PK`) — name, duration_minutes, kind, active, scheduling_url, raw_payload.
- **`calendly_scheduled_events`** (`uri text PK`) — name (the canonical filter field), status, start_time, end_time, **event_created_at** (the booking-time field the Engine sheet keys on), event_updated_at, event_type_uri (loose FK), host fields denormalized from first event_membership, location/invitees_counter/cancellation as jsonb, raw_payload.
- **`calendly_invitees`** (`uri text PK`) — event_uri (loose FK), email/name, status, invitee_created_at, **rescheduled boolean** (load-bearing — distinguishes new bookings from reschedules), old_invitee/new_invitee URIs, no_show, timezone, cancel_url/reschedule_url, raw_payload.

Loose FKs throughout. Webhook delivery vs backfill order isn't guaranteed; 58% of historical events reference retired event-type URIs absent from `/event_types`. Loose-ref tolerates both.

Indexes targeting the per-day Engine-sheet metric queries: `(status, event_created_at DESC)` for New Scheduled counts; `(name, event_created_at DESC)` for closer-booking filtering; `(event_uri)` on invitees for the typical event-join; partial index `(rescheduled) WHERE rescheduled = true` for the Rescheduled-count metric.

### Ingestion module — three files

`client.py` mirrors `ingestion/close/client.py` shape with two Calendly-specific additions:
1. **Mandatory `User-Agent: ai-enablement/1.0` header** on every request — Cloudflare blocks default `Python-urllib`. Documented as load-bearing.
2. **`fetch_timeseries`-style helper for the parent event** (`get_scheduled_event(event_uri)`) — needed by the webhook receiver per tick.

`parser.py` is pure projection. Critical contract: `parse_invitee` returns `event_uri` extracted from the invitee's `event` field; without it the row is unusable (returns `{}`). `parse_scheduled_event` preserves the event's own `name` field intact for the case-insensitive aggregation filter.

`pipeline.py` exposes per-row upsert helpers (used by both backfill + webhook receiver) plus two orchestrators:
- `sync_invitee_and_event(client, db, invitee_payload)` — webhook entry point. Upserts the invitee + fetches and upserts the parent event. Fail-soft per record. Reschedule handling: each leg of a reschedule pair (the canceled OLD invitee + the created NEW invitee) is delivered as a separate webhook event; each call upserts ITS OWN invitee row only (lineage carried by `old_invitee`/`new_invitee` URIs on the rows themselves) — verified at scale by `test_sync_invitee_and_event_reschedule_pair_no_double_count`.
- `sync_recent_events_with_invitees(client, db, org_uri, lookback_days=7, future_days=60)` — backfill walker. Loops per status (`active` + `canceled` separately because the API param is single-valued); dedups across iterations; pulls invitees per event; fail-soft.

### Webhook receiver `api/calendly_events.py`

Mirrors `api/close_events.py` exactly. Signature verify → replay window → JSON parse → synthesized webhook_id dedup → event-type routing → fast 2xx. Always returns 200 on handled errors (per Calendly's auto-disable-after-failures behavior).

In-scope event types routed:
- `invitee.created` / `invitee.canceled` → `sync_invitee_and_event` (upsert invitee + fetch/upsert event)
- `invitee_no_show.created` / `invitee_no_show.deleted` → `upsert_invitee_from_payload` only (invitee carries the updated `no_show` flag)
- Anything else → audit row written, no upsert (Drake's mirror-everything principle; future-proof)

Header sanitization redacts the v1 signature portion of `Calendly-Webhook-Signature` while preserving the timestamp (forensically useful, not a secret).

### Helper scripts

- `scripts/register_calendly_webhook.py` — list / register / delete. Default mode lists existing subscriptions (verified against live: org has 10 existing Make.com subscriptions). `--register --url <URL>` POSTs `/webhook_subscriptions` with the four in-scope events and prints the signing key. Drake runs this AFTER the receiver deploys + BEFORE adding `CALENDLY_WEBHOOK_SECRET` to Vercel.
- `scripts/backfill_calendly.py` — three modes per the operational convention. Dry-run verified end-to-end against live API (peeked 20 active events; casing drift "Ai" vs "AI" confirmed; closer-call `AI Partner Strategy Call` dominant — matches discovery findings).

### Documentation

- 3 schema docs with column-level notes on the load-bearing contracts (name-vs-URI filtering, EDT date math, reschedule semantics) and example queries for Engine rows 93, 34, 35.
- 1 runbook with the four footguns, the full Drake-gated activation runbook, backfill ops, and a deferred-Follow-Up-metric section.
- `.env.example` entries for both env vars with the spec-drift note + the verbatim HMAC verification algorithm.
- CLAUDE.md folder addition (single-line edit per the spec's mandatory updates).

## Verification

- **`python3 -m py_compile`** on every new Python file — exit 0.
- **`.venv/bin/python -m pytest tests/ingestion/calendly/ tests/api/test_calendly_events.py -v`** — **56/56 passing** in 2.76s.
- **Full suite `.venv/bin/python -m pytest tests/ -q`** — **861/861 passing** in 10.54s. +56 from this spec; no regressions.
- **Live dry-run via `.venv/bin/python scripts/backfill_calendly.py`** — auth OK, org URI captured, 20 active events visible across `AI Partner Strategy Call` / `Ai Partner Strategy Call` (casing drift, both present — case-insensitive match is correct) / `Sales Interview` / `Partnership Call w/ Aman`. User-Agent header working — no Cloudflare 1010 errors.
- **NOT verified yet** (gated):
  - Migration apply (HARD STOP for gate (a)).
  - Smoke + bulk backfill — gated on migration apply.
  - HMAC signature scheme against a real Calendly delivery — gated on Drake's activation runbook (step 5).

## Surprises and judgment calls

- **Cloudflare 1010 (browser_signature_banned)** struck immediately on the first probe call in the discovery pass — already documented there. Carried forward to the ingestion client as `USER_AGENT = "ai-enablement/1.0 (+drake@theaipartner.io)"`. First source in this codebase to require it; Wistia/Close/Meta clients all work without one.

- **Webhook signature implementation is the highest-risk area.** Calendly's docs portal is a SPA that WebFetch can't load directly; I pieced together the algorithm from web-search summaries + community posts + Stripe-style conventions. **The implementation may need adjustment after the first real delivery.** Defensive moves: (a) header parser handles whitespace and missing fields gracefully (5 test cases); (b) sanitizer preserves the timestamp for forensics but redacts the signature; (c) runbook has a "if signature 401s on first delivery" recovery section. If it does fail, the captured header in `webhook_deliveries.headers` is exactly what's needed to fix the verifier.

- **Reschedule double-counting** is the metric-correctness load-bearing concern. Built two layers of defense: (1) `parse_invitee` faithfully preserves `rescheduled` + `old_invitee` + `new_invitee` so the data carries lineage; (2) `sync_invitee_and_event` is tested to NOT touch the other invitee row when called per webhook event. The aggregation layer must filter `rescheduled=false` for the "New Scheduled" count — flagged loudly in `docs/schema/calendly_invitees.md` + the runbook.

- **`event_type_uri` is a loose ref, not a hard FK.** 58% of historical events point at retired URIs (discovery proved this empirically with the live data). Hard FK would block ingestion of those events. Aggregation should NOT join on this column; filter by `name` (case-insensitive) per the documented closer-set.

- **Backfill window is `start_time` ∈ [-7d, +60d]** — wider than the spec's "7 days only" because:
  - The Engine sheet metrics key on `event_created_at` (booking time), not `start_time`.
  - Calendly's `/scheduled_events` only filters by `start_time`.
  - A booking made TODAY for a strategy call NEXT MONTH should land in the 7-day-recent backfill. So the future window has to be wide enough to catch it.
  - The aggregation layer then buckets by `event_created_at` to produce the Engine rows.
  Documented in the backfill script + runbook.

- **CALENDLY_API_KEY vs CALENDLY_API_TOKEN.** Spec said `_TOKEN`; real env var is `_KEY`. Three-way handling: (1) `CalendlyClient.from_env()` accepts either; (2) `.env.example` uses `_API_KEY` as canonical with a comment explaining the drift; (3) the register helper accepts either too. Going forward, standardize on `_API_KEY` (matches `CLOSE_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` precedent). Worth a one-line CLAUDE.md naming-convention note in a future doc-hygiene pass, not now.

- **`maxDuration: 60` on the receiver** (vs 300 on wistia_sync_cron). Webhook delivery is single-event-at-a-time; a 60s ceiling is plenty. If a 503 backoff cascade ever pushes past 60, fail-soft will mark `failed` and the next delivery / backfill heals.

- **The org has 10 EXISTING Calendly webhook subscriptions** pointing at Make.com. Adding an 11th doesn't disrupt those — Calendly fans out to every active subscription. Worth knowing for ops: if anyone wants to consolidate the Make.com flows into our DB-mirror later, that's a deliberate future cleanup conversation, not this spec.

- **DEFERRED Engine row 95 ("Follow Up Meetings")** — Calendly has no native concept; Aman/team hasn't defined what counts. Mirror everything raw; aggregation waits for a definition. Flagged in the runbook + the deferred section here. Three possible interpretations laid out for whoever picks.

- **The pipeline's `sync_recent_events_with_invitees` iterates per status because Calendly's `status` param is single-valued.** Two passes: `active` then `canceled`, with dedup by URI in case an event flips status mid-pull (rare). Tested.

- **Webhook signature header redaction preserves timestamp.** The audit row's `headers.calendly-webhook-signature` value strips `v1=<hex>` and replaces with `v1=<REDACTED>` — never persisting the actual signature bytes, but keeping the timestamp portion useful for replay-window debugging.

## Out of scope / deferred (Pt 2 resume work)

Held for after gate (a) approval:

- **Apply migration 0047** via `supabase db push --linked`.
- **Dual-verify** (schema reality on three tables + indexes + triggers + ledger).
- **Smoke `scripts/backfill_calendly.py --smoke`** against real DB on one event + invitees.
- **Bulk `--apply`** for 7-day backfill (~25 events × invitees = ~50 rows). Drake-gated; quick.
- **Drake's 6-step activation runbook** for live webhooks (deploy → confirm → register → secret → verify). Per the runbook in this commit set.
- **Verify HMAC signature scheme** on first real webhook delivery; adjust receiver if needed.
- **Update `docs/state.md`** with the ship entry.
- **Write `docs/reports/calendly-ingestion-pt2.md`** resume report.

Held for separate / future specs:

- **"Follow Up Meetings" metric definition** — see DEFERRED in the runbook.
- **`no_show` consolidation** — Calendly's native flag vs the Engine sheet's other source.
- **`routing_form_submission` ingestion** if Calendly forms get adopted.
- **Aggregation-layer SQL views** for the six Engine-sheet metrics.
- **Drake's webhook activation steps** are gate (d) — Builder writes the helper + runbook, Drake runs.
- **Multi-invitee group events** if the org ever uses them (schema supports; aggregation assumes solo today).

## Side effects

- **Calendly API:** ~9 read-only calls during dry-run + register-script verification (1 users/me + 1 event_types + 1 scheduled_events page + a couple of probe-related listings during signature-scheme research). No writes — subscription creation is Drake-gated, not done here.
- **Supabase:** zero writes (migration not applied yet → tables don't exist). One read of `oauth_tokens` during the user/identity acclimatization shared from prior context.
- **Slack / external services:** none touched.
- **Local filesystem:** no `.probe-out/` dumps in this spec (discovery already populated `.probe-out/calendly/`).
- **No `.env.local` modifications.** Token read-only.
- **Vercel:** `vercel.json` edited (per-file runtime added for `api/calendly_events.py`). Push triggers auto-deploy. The function will be discoverable at `/api/calendly_events` but every POST will 500 with `misconfigured` until `CALENDLY_WEBHOOK_SECRET` is set in Vercel env (gate (d)). GET returns the standard health-check JSON. No production damage in the meantime.
- **No new env vars added to Vercel** — `CALENDLY_API_KEY` + `CALENDLY_WEBHOOK_SECRET` are documented in `.env.example` but adding to Vercel is Drake's gate-(d) step.

---

## What's needed to unblock

**Drake's SQL review on `supabase/migrations/0047_calendly_ingestion_tables.sql`** (spec gate (a)).

Key things to sanity-check:

1. **Three-table layout.** `calendly_event_types` (reference, 9 cols), `calendly_scheduled_events` (16 cols), `calendly_invitees` (20 cols). URI-keyed PKs everywhere.
2. **Loose FK posture** on `event_type_uri` + `event_uri` — no hard constraints. Reasons documented in column comments + schema docs (retired URIs + delivery-order uncertainty).
3. **Index choices** — `(status, event_created_at DESC)` + `(name, event_created_at DESC)` on events; partial `(rescheduled) WHERE rescheduled = true` on invitees. Confirm or call out missing access patterns.
4. **`rescheduled` + `no_show` as `NOT NULL DEFAULT false`** — defaults match Calendly's "field absent = false" semantic. Confirm.
5. **JSONB on `location`, `invitees_counter`, `cancellation`, `raw_payload`** — flexible passthrough. Confirm.
6. **Trigger `*_set_updated_at` on all three tables** — standard convention.

After approval the Pt 2 resume sequence is:

```bash
# 1. Apply
DB_PW=$(...)
supabase db push --linked --dns-resolver https --password "$DB_PW" --yes

# 2. Dual-verify (psycopg2 against pooler)

# 3. Smoke
.venv/bin/python scripts/backfill_calendly.py --smoke

# 4. Drake confirms smoke, then:
.venv/bin/python scripts/backfill_calendly.py --apply

# 5. Drake's webhook activation runbook (gate d):
#    - confirm deploy of api/calendly_events.py via curl /api/calendly_events
#    - .venv/bin/python scripts/register_calendly_webhook.py --register --url <DEPLOYED_URL>
#    - copy signing key → set CALENDLY_WEBHOOK_SECRET in Vercel env → redeploy
#    - book a test meeting in Calendly; verify webhook_deliveries row + invitee/event mirror

# 6. Update state.md + write docs/reports/calendly-ingestion-pt2.md
```

Pt 2 resume report goes at `docs/reports/calendly-ingestion-pt2.md` per the partial-report convention; this PARTIAL stays intact.
