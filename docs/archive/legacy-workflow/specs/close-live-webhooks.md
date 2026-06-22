# Close CRM Live Ingestion — Webhook Receiver
**Slug:** close-live-webhooks
**Status:** in-flight
**Target branch:** main

## ⚠️ Landscape heads-up — read first

A LOT of work happened on a parallel branch/worktree today and Drake just **fast-forwarded `main`**. The tree may differ from where any prior Builder session left off. **Before doing anything: `git status`, `git log --oneline -15`, and re-read the files you're about to touch from their CURRENT state on disk — do not assume the repo matches your memory or any earlier session's view.** In particular, the Close ingestion module (`ingestion/close/`), migration 0043, and `docs/state.md` all landed earlier today on `main`; confirm they're present and current before building on them.

Also note: there's a separate Ella worktree on branch `ella-worktree` with its own Builder. **Stay on `main`. Do not touch Ella anything.** This spec is Close-only.

## Why this exists

Close ingestion V1 (`close-ingestion-v1`, pt1 + pt2 reports) shipped: migration 0043 + six mirror tables + `ingestion/close/` pipeline + a bulk backfill (~76k rows, ~10 months, halted intentionally at Drake's call — "we only need it working moving forward"). Now we make it **live**: new Close data flows into the mirror tables in real time.

**Decision: webhooks, NOT polling.** The pt2 report recommended a polling cron as the safer default, but Drake wants true real-time and accepts the extra setup. Close pushes events (lead created/updated, status changes, calls, SMS) to a receiver endpoint the moment they occur; the receiver parses + upserts via the EXISTING pipeline.

## Scope — what's live, what's not

**In scope (mirror, going forward):** leads, lead status-changes, calls, SMS, and keep custom-field-definitions fresh. These are the streams the backfill already covers and the Engine sheet's APPOINTMENT SETTING section needs.

**Explicitly OUT of scope:**
- **Opportunities** — 0 rows backfilled by design; pt2 confirmed they're redundant with status-changes + lead cfs for our metrics. Don't add an opportunity webhook unless a later spec proves a metric needs it.
- **Triage as a Close signal** — NEW INFO from Drake: **triage calls live in Airtable forms, not Close.** The `close_leads.triage_showed` cf is sparse (only 63 leads post-backfill) precisely because triage isn't captured in Close. So this pipeline must NOT be treated as the triage source, and don't invest in making `triage_showed` reliable — triage will be its own Airtable ingestion in a future spec. Mirror the cf if it arrives in a payload (harmless), but it's not canonical.
- **EOC Forms / closing-money** — separate source, future spec (serves the CLOSING section).
- **Backfill changes** — the backfill is done and intentionally partial. This spec does not re-run or extend it.

## Context Builder needs

**Mirror the existing webhook-receiver pattern.** `api/` already has working inbound webhook handlers — read these BEFORE writing the Close one, they're the canonical shape for this codebase:
- `api/fathom_events.py` — closest analog (external service → parse → pipeline upsert).
- `api/slack_events.py` — signature-verification + event-dispatch pattern.
- `api/airtable_nps_webhook.py` / `api/airtable_onboarding_webhook.py` — more inbound-webhook examples.
Match their structure: signature/secret verification first, fast 200 ack, fail-soft per-event, audit via `webhook_deliveries` (confirm the current table name/shape on disk — the backfill reports referenced `webhook_deliveries` with a `source` field; verify).

**The pipeline already exists.** `ingestion/close/pipeline.py` has `sync_lead()`, dispatch-by-`_type`, idempotent `ON CONFLICT (close_id)` upserts, and `sync_recently_updated_leads()`. The webhook receiver should call into this existing pipeline, NOT reimplement parsing. `ingestion/close/parser.py` already maps Close JSON → row dicts incl. `derive_tier()`. Reuse all of it. If a webhook payload shape differs from the API-fetch shape the parser expects, adapt in the receiver/adapter layer — don't fork the parser.

**How Close webhooks work (verify against current docs + the live API — don't trust this blind):**
- Close webhook subscriptions are created via their API (`POST /api/v1/webhook/`) or dashboard, specifying the events to subscribe to (e.g. `lead.created`, `lead.updated`, `lead.status_change`, `activity.call.created`, `activity.sms.created` — confirm exact event-type names against Close's webhook docs) and a target URL.
- Close signs webhook payloads; the receiver MUST verify the signature against a signing secret Close provides at subscription creation. Confirm the current signature scheme (header name, HMAC algorithm) from Close's docs — this is the security boundary, get it right.
- Payloads wrap the changed object + event metadata. The receiver extracts the object, routes by event type to the right pipeline call.
- Close expects a prompt 2xx; do the heavy upsert work fast or defer it, but given our volumes a synchronous upsert-then-200 is likely fine. Match what `fathom_events.py` does.

**Deployment shape.** This is a Vercel serverless function under `api/`, same as the other receivers. It needs a public URL (the Vercel deployment URL for the function) that Close points at.

## What to build

1. **`api/close_events.py`** — the webhook receiver. Verify signature → parse event → route by type → call existing `ingestion/close/pipeline` upserts → audit to `webhook_deliveries` → fast 2xx. Fail-soft: a bad single event logs + still returns 2xx so Close doesn't disable the subscription (confirm Close's retry/disable behavior on non-2xx and handle accordingly — some services disable a webhook after N failures).
2. **Signature verification** against a `CLOSE_WEBHOOK_SECRET` (gate (d) env var — see below). Never skip verification; reject unsigned/badly-signed requests.
3. **Event-type routing** for the in-scope streams (lead create/update, status-change, call, SMS). Map each to the right pipeline method. Status-change events → `close_lead_status_changes`; call/SMS → their tables; lead create/update → `sync_lead` (or a lighter lead-only upsert if the payload carries the full lead).
4. **A subscription-registration helper** — `scripts/register_close_webhook.py` that, given the deployed receiver URL, creates the Close webhook subscription via their API and prints the signing secret for Drake to put in env. This is the cleanest way to do the Close-side setup reproducibly rather than click-ops. **Running it is Drake's gate** (it creates a real subscription in Close + needs the deployed URL to exist first).
5. **Idempotency holds via the existing `ON CONFLICT` upserts** — webhooks can deliver duplicates; the existing keying handles it. Confirm + note it.

## Gates / hard stops

This spec touches deploy + external-service config, so several real gates:
- **`CLOSE_WEBHOOK_SECRET` (+ any other new env var) in Vercel** — gate (d). Scope it, document it, but Drake adds it. Don't add Vercel env vars silently.
- **Deploying the receiver to Vercel** — the function needs to be live at a public URL before Close can point at it. Flag the deploy as a step; if Vercel auto-deploy from `main` is the mechanism, note that the Director-push-vs-Builder-push deploy-trigger flakiness (per CLAUDE.md) may apply — Drake may need to confirm the deploy landed.
- **Registering the webhook in Close** (running `register_close_webhook.py`, or doing it in Close's dashboard) — Drake's action, needs the deployed URL + creates real Close-side state. HARD STOP: Builder scopes + writes the helper, Drake runs it.
- **Order of operations** (document this clearly for Drake): (1) merge + deploy receiver to Vercel, (2) confirm the function is reachable, (3) add `CLOSE_WEBHOOK_SECRET` placeholder / or register first to GET the secret then add it, (4) register the Close subscription pointing at the deployed URL, (5) verify a real event flows end-to-end. Builder should spell out this runbook precisely since the steps are interdependent and Drake executes them.
- Never write to Close beyond the one subscription-creation call (which is Drake-gated). Never echo secrets.

## What success looks like

- `api/close_events.py` deployed-ready: verifies signatures, routes the in-scope event types, upserts via the existing pipeline, audits, returns fast 2xx, fail-soft.
- `scripts/register_close_webhook.py` ready for Drake to run against the deployed URL.
- A precise step-by-step activation runbook in `docs/runbooks/close_ingestion.md` (extend the existing one) so Drake can go live without guessing.
- Idempotency confirmed (dup deliveries are no-ops).
- A documented test path: how to verify end-to-end once live (e.g. create a test lead in Close → confirm a row lands), and ideally a local signature-verification unit check against a sample payload.
- Clear statement of what's live (leads/status/calls/SMS) vs not (opps, triage=Airtable, EOC=future).

## Think this through — what could go wrong

Webhook payload shape differing from the API-fetch shape the parser was built against (the backfill fetched via API; webhooks push a possibly-different envelope — verify the actual payload, adapt in the receiver not the parser). Close disabling the subscription after repeated non-2xx — hence fail-soft + always-2xx-on-handled-error. Duplicate deliveries (idempotency covers it, confirm). Signature scheme assumed wrong (verify against real Close docs — this is the security boundary). Out-of-order delivery (a status-change arriving before the lead it references — the loose-FK design from V1 already tolerates this; confirm). Vercel cold-start latency causing Close to time out the delivery — match the fast-ack pattern of the existing receivers. Surface these honestly.

## Mandatory doc updates

- `docs/runbooks/close_ingestion.md` — extend with the live-webhook section + the precise activation runbook (the interdependent steps above) + failure/retry behavior + how to verify live.
- `.env.example` — add `CLOSE_WEBHOOK_SECRET` (documented, gate (d), where it comes from: Close subscription creation).
- `docs/state.md` — add the live-ingestion entry once the receiver is shipped (code merged); note activation is Drake-gated (deploy + register) so distinguish "receiver shipped" from "live in production."
- `CLAUDE.md` — only if a new `api/` convention or env var needs documenting in the relevant section; keep edits minimal.
- Report at `docs/reports/close-live-webhooks.md`.
