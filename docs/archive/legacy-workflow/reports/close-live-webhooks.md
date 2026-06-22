# Report: Close CRM Live Ingestion — Webhook Receiver

**Slug:** close-live-webhooks
**Spec:** docs/specs/close-live-webhooks.md

## Acclimatization (per spec's landscape heads-up)

What I confirmed before writing any code:

- **Tree state:** `git status` clean before start. `git log --oneline -15` showed the close-ingestion-v1 commits (`ec5ff01` migration → `4375562` pt2 report) plus a separate Ella worktree shipped earlier today. Stayed on `main`, didn't touch Ella anything.
- **V1 ingestion module present + current** on disk at `ingestion/close/{client,parser,pipeline}.py`. Migration 0043 already applied (verified via the V1 pt2 report — 5,172 leads, 9,509 status changes, 14,683 calls, 46,304 SMS already in cloud Supabase).
- **`webhook_deliveries` table** present (migration 0011) with `source text not null default 'fathom_webhook'` + `processing_status` CHECK enum `received/processed/failed/duplicate/malformed`. Receiver writes `source='close_webhook'` for this delivery stream.
- **Canonical webhook pattern** read in `api/fathom_events.py` (closest analog: external service → signature verify → audit-row upsert → parser → pipeline → mark processed → fast 2xx).
- **Close webhook docs confirmed via developer.close.com:** event-type names (`lead.created`, `opportunity.updated`, `activity.call.created`, `activity.lead_status_change.created`, etc.); payload shape (`{event: {object_type, action, data, previous_data, changed_fields}, subscription_id}` — `data` carries the FULL new object, no refetch needed); signature scheme (HMAC-SHA256 of `timestamp + body` with hex-decoded secret, hex compare against `close-sig-hash`); retry behavior (exponential backoff up to 20-min intervals, 72h, then auto-pause after 3 days of failures or 100k backlog).
- **Drake's scope override (received as /run args):** opportunities are now IN scope. Override applied throughout: receiver routes opportunity.created/updated to `upsert_opportunity_from_payload`; `EVENTS_IN_SCOPE` in the register script includes them; runbook + state.md + schema-doc-note all reflect "mirror everything Close emits per Core Principle #1; `value` stays $1-placeholder NOT money."

## Files touched

**Created:**
- `api/close_events.py` — Vercel serverless receiver (signature verify → replay-window check → audit-row upsert → event-type routing → fast 2xx).
- `scripts/register_close_webhook.py` — Drake-run helper to register/list/delete the Close subscription. `EVENTS_IN_SCOPE` is the in-scope event list.
- `scripts/sync_close_cf_definitions.py` — small helper to refresh the cf-name mirror when a Close admin adds/renames a custom field.
- `tests/api/test_close_events.py` — 27 tests (signature happy + 4 reject paths; replay-window 5 cases; synthesized webhook_id stability; event-type routing for every in-scope type incl. Drake's opportunity override + the unknown-type fallback).
- `tests/ingestion/close/test_pipeline_webhook_helpers.py` — 14 tests covering the new per-row upsert helpers + cf-degradation behavior.
- `tests/ingestion/close/__init__.py` — empty marker so pytest discovers the new test module.

**Modified:**
- `ingestion/close/pipeline.py` — added 6 webhook entry points (`load_lead_cf_id_to_name`, `upsert_lead_from_payload`, `upsert_call_from_payload`, `upsert_sms_from_payload`, `upsert_opportunity_from_payload`, `upsert_lead_status_change_from_payload`). Updated module docstring to document both the backfill + webhook entry points.
- `vercel.json` — added `api/close_events.py` per-file runtime config (mirroring `fathom_events.py` pattern: `@vercel/python@4.3.1`, `maxDuration: 60`).
- `.env.example` — documented `CLOSE_WEBHOOK_SECRET` (hex string, format + how-to-obtain via the register script + gate (d) note + the verbatim signature algorithm).
- `docs/runbooks/close_ingestion.md` — rewrote the "Ongoing ingestion" section: webhooks are now V1 (polling helper kept as operational backstop). Added the full Live activation runbook (5 sequential steps + verification SQL), the signature-verification reference, the idempotency layers, the cf-staleness handling, plus 4 new failure-mode rows in the debugging table.
- `docs/state.md` — added a new `### 2026-05-23 — Close CRM live ingestion (webhook receiver shipped; activation Drake-gated)` section at the top of the "Gregory editorial skin shipped" block.

## What I did, in plain English

**Reused the V1 ingestion module rather than reimplementing.** The webhook receiver is a thin Vercel adapter that converts a Close event → an `event.data` payload → an existing `parse_*` + DB upsert. Close webhook payloads include the FULL new object in `event.data` (confirmed against Close docs), so the receiver upserts directly without a refetch round-trip. The same parser path covers the backfill and the webhook — bug fixes there land in both at once.

**Six new pipeline entry points** mirror the `parse_*` functions one-to-one (`upsert_lead_from_payload`, `upsert_call_from_payload`, `upsert_sms_from_payload`, `upsert_opportunity_from_payload`, `upsert_lead_status_change_from_payload`) plus `load_lead_cf_id_to_name(db)` which reads the cf-name map from our own `close_custom_field_definitions` mirror (no Close API call per webhook — the mirror is cheap to query at ~88 rows).

**Receiver shape mirrors `api/fathom_events.py`** because that's the canonical pattern in this codebase. Differences worth surfacing: Close doesn't ship a Standard-Webhooks-style `webhook-id` header, so I synthesize a stable dedup key as `close:{close-sig-timestamp}:{sha256(body)[:16]}`. Two true duplicates (same body, same timestamp) produce identical keys → PK collision → fast 200 ack with `{deduplicated: true}`. Legitimate retries with a fresh timestamp re-attempt processing, but the downstream `ON CONFLICT (close_id)` upserts keep that safe.

**Fail-soft always returns 200 on handled errors.** Close auto-pauses subscriptions after 3 days of failures or 100k event backlog (per their docs). Returning 500 on a per-payload bug would risk auto-pause; returning 200 + marking the `webhook_deliveries` row `failed` keeps the subscription healthy and lets the operational backstop (`sync_recently_updated_leads`) heal the gap. The audit-row trail makes failed deliveries forensically recoverable.

**Drake's opportunity override** baked in across every layer that mentions scope: receiver routing in `_route_event`, `EVENTS_IN_SCOPE` in the register helper, runbook event-routing table, state.md entry, and a dedicated test (`test_route_opportunity_created_drake_override`). The schema doc's existing `value`-is-$1-placeholder note is unchanged (no migration this spec) but reaffirmed in the new code's docstring on `upsert_opportunity_from_payload`.

**Signature verification is the security boundary** so I tested it 7 different ways: happy path, tampered body, wrong timestamp, wrong secret, non-hex secret, empty headers, empty secret. The reference implementation comes verbatim from Close's docs Python example to keep the test bombproof against drift.

**Activation is Drake's gate-(d).** Receiver code merges/pushes/deploys via the existing main → Vercel pipeline. Drake's 5-step activation runbook (in the updated `docs/runbooks/close_ingestion.md` § Live activation runbook): (1) confirm deploy via `curl https://.../api/close_events`, (2) run `scripts/register_close_webhook.py --register --url ...`, (3) copy the signing secret Close returns ONCE, (4) add `CLOSE_WEBHOOK_SECRET` to Vercel env + redeploy, (5) verify a real event flows end-to-end with a SQL check on `webhook_deliveries`.

## Verification

- **`python3 -m py_compile`** on every new/modified Python file — exit 0. No syntax errors.
- **`.venv/bin/python -m pytest tests/api/test_close_events.py tests/ingestion/close/`** — **41/41 passing** in 1.93s. Covers signature, replay window, dedup-key, every in-scope event-type route (incl. Drake's opportunity override + lifecycle variants + the unknown-type fallback), and the per-row upsert helpers (incl. graceful cf-degradation when an unknown cf appears in a payload).
- **Full suite: `.venv/bin/python -m pytest tests/ -q`** — **733/733 passing** in 9.04s. No regressions. (+41 from this spec; prior was 692; the V1 close-ingestion shipped with no test coverage, this spec is the first to add some.)
- **Receiver auth-helper smoke** — ran `_verify_signature` against Close's docs-verbatim example secret + timestamp + body and confirmed it both validates a correct signature AND rejects tampered body/wrong timestamp/wrong secret/non-hex secret/empty headers. Algorithm matches the docs exactly.
- **Register script dry-run** — ran `.venv/bin/python scripts/register_close_webhook.py` against the live Close API. Successfully listed the org's **31 existing webhook subscriptions** (currently all pointing at Make.com and n8n hooks; no conflict with our planned receiver URL — ours will be the 32nd). Auth works, list endpoint reachable.
- **Did NOT** call `--register` — that creates real Close-side state and needs the deployed receiver URL to exist first. Drake's gate-(d) step.
- **Did NOT** smoke-test the receiver end-to-end against a real Close event — the receiver isn't deployed yet (this spec is the code; the deploy + register are Drake's next steps). End-to-end verification is step 5 of the Live activation runbook.

## Surprises and judgment calls

- **31 existing webhook subscriptions in the Close org.** Discovered when the register script's list mode ran. The team already actively uses Close webhooks via Make.com and n8n hooks (single-event subscriptions per hook). Our 32nd subscription is just one more entry in that table, no operational concern — but useful context: this org has lived experience with Close's webhook semantics + retry behavior. If our receiver behaves unexpectedly, the Make.com/n8n hooks are a useful comparison surface.
- **Synthesized webhook_id key instead of a Close-provided one.** Close doesn't expose a Standard-Webhooks-style `webhook-id` header. The synthesized `close:{ts}:{sha256(body)[:16]}` is a defensible substitute but it has a subtle property: a legitimate retry from Close (with a fresh timestamp + same body) will land with a NEW key, not collide. That means each retry creates a new audit row and re-runs the upserts. Downstream idempotency (`ON CONFLICT (close_id)`) keeps that correct, but the audit table will have N rows per retried delivery instead of 1. Not a correctness issue; operational query for "did this lead's update actually land" should look at the mirror table, not at `webhook_deliveries` count.
- **Lead-merge events route to `upsert_lead_from_payload`.** The `lead.merged` event in Close fires when two leads are merged; the `event.data` carries the surviving lead's new state. I route this same as `lead.updated` — refresh `close_leads` with the merged result. The losing lead's row stays in `close_leads` until either deleted manually or until Close also fires a `lead.deleted` event (which isn't currently subscribed). Worth flagging: stale dead-lead rows can accumulate post-merge. If this becomes a real problem, add `lead.deleted` subscription + a soft-archive column on `close_leads`.
- **Unknown event types are audited but not failed.** When Close sends an event type we don't route (e.g. `note.created`, future event types Close adds), the receiver writes the `webhook_deliveries` row, marks it `processed` with `upserted_id = null`, and returns 200. Drake's principle is "mirror everything Close emits"; this gets us observability on what's actually coming through, then we can add routes as needed without panic-changes.
- **5-minute replay window is defensive, not from Close's docs.** Close doesn't document a replay window. I added 5 minutes based on Standard Webhooks convention + parity with `fathom_events.py`. If Close legitimately retries deliveries 5+ minutes after the original timestamp, they'd hit the replay check and be rejected. Given Close's retry behavior tops out at 20-minute intervals over 72 hours, individual retries SHOULD use a fresh timestamp (= fresh signature) — so the replay window only matters for replay attacks, not legitimate retries. If this assumption is wrong in production (deliveries getting 401'd at replay), bump the window or remove the check entirely; the signature verification is still the load-bearing security boundary.
- **Custom-field-name lookup re-runs per webhook invocation.** I load `close_custom_field_definitions` on every webhook (one SELECT, ~88 rows). Vercel's serverless model cold-starts re-import the module anyway, so there's no caching to be had at the process level without explicit caching infrastructure. The query is cheap (PostgREST + small table); not worth optimizing until proven a bottleneck.
- **No cf-sync cron.** The "keep custom-field-definitions fresh" goal lands as a manual `scripts/sync_close_cf_definitions.py` Drake runs when a Close admin adds/renames a cf — not as a scheduled cron. Reason: cf creation in Close is rare (typically zero in months), and a daily cron would add a Vercel cron + env-var setup gate-(d) cost for almost no benefit. If drift becomes a real ops problem, wrap into a cron in a follow-up spec.
- **Subscription response field name unknown.** Close's docs don't explicitly name the signing-secret field in the `POST /webhook/` response. The register script looks for `signature_key`, `secret`, or `signing_key` (most common conventions); if Close uses a different name, the script will print a warning + the full JSON so Drake can find the secret. Easy fix if it surfaces — patch one constant.

## Out of scope / deferred

- **Live activation itself** — Drake's gate-(d) sequence (deploy → confirm URL → register → secret → verify end-to-end). State.md distinguishes "receiver shipped" from "live in production"; the live-in-production update lands after Drake's 5 steps complete.
- **Triage ingestion from Airtable** — per the spec scope, triage lives in Airtable forms and gets its own ingestion spec. Don't invest in `close_leads.triage_showed` reliability here.
- **EOC Forms ingestion** — separate source, serves the CLOSING section.
- **Scheduled cf-definition cron** — manual script for V1.
- **`lead.deleted` subscription** — would prevent post-merge dead-row accumulation. Not currently a real problem.
- **Custom-activity events + `activity.opportunity_status_change`** — not routed (folded into the parent object's `.updated` event). Add to `_route_event` if a future metric needs the dedicated activity stream.
- **Soft-archive column on `close_leads`** — pairs with `lead.deleted`. Would need migration 0044.
- **End-to-end live smoke** — requires deployed receiver + Close subscription, both gate-(d).
- **Backfill changes** — explicitly out of scope per the spec.

## Side effects

- **Close API:** ~2-3 read-only calls during register-script smoke (`GET /api/v1/webhook/` to list existing subscriptions). No POSTs to create/edit subscriptions — that's Drake's gate-(d) step. No writes to Close.
- **Supabase:** no writes, no reads (the test suite uses mocks; nothing hit the cloud DB in this spec).
- **Slack / external services:** none touched.
- **Local filesystem:** no new `.probe-out/` dumps. No `.env.local` modifications.
- **Vercel:** `vercel.json` edited (per-file runtime config added for `api/close_events.py`). Code change will trigger an auto-deploy on push; the new function will be discoverable at `/api/close_events` but will return 500 until `CLOSE_WEBHOOK_SECRET` is set in Vercel env (gate (d)).
- **No new env vars added to Vercel** in this spec — `CLOSE_WEBHOOK_SECRET` is documented in `.env.example` but adding to Vercel is Drake's gate-(d) step (executes during Live activation step 4).
- **No new crons.** Receiver is event-driven, not scheduled.
- **No migrations applied.** All work reuses V1's tables.
