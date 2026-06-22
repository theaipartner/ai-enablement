# Session 2 — De-personalize the Code + Onboarding Docs

**Goal:** Remove Drake-specific identifiers from the code so the system keeps working under a new
operator, reconcile `.env.example` so it's a truthful credential template, and write the docs a new
*human* engineer (not the Director/Builder AI workflow) needs to get oriented.

**Risk level:** Medium. The OAuth de-coupling (§A.1) touches a live data path — test on preview.
The `.env.example` and onboarding work is low risk.

> Read [`00-overview.md`](00-overview.md) first. Depends on Drake's decision on the OAuth successor
> identity (decision #2 in the overview).

---

## A. Remove hardcoded personal identifiers

### A.1 The Drake-pinned Google OAuth coupling (highest effort) — needs Drake decision #2

The Teams + client-meetings calendar sync is architecturally pinned to Drake's identity: **one** OAuth
token (stored in `oauth_tokens`, keyed to Drake's `team_member_id`, `access_tier='creator'`) reads
**all** CSM calendars, because the CSMs share their calendars with Drake at the Google Workspace level.

Hardcoded locations:
- `api/teams_calendar_sync_cron.py:72` — `_DRAKE_EMAIL = "drake@theaipartner.io"` (+ usage ~line 254)
- `api/client_meetings_sync_cron.py:72` — `_DRAKE_EMAIL = "drake@theaipartner.io"` (+ usage ~line 412)
- `lib/db/teams.ts` — `getDrakeOAuthState()` queries Drake's token row

What handoff requires (pick per Drake decision #2):
- **Option A — successor person:** new operator becomes the `creator`-tier team member; CSMs re-share
  calendars to them; new operator runs the OAuth connect flow (`/api/auth/google/connect`) to mint a
  fresh `oauth_tokens` row; replace `_DRAKE_EMAIL` with the successor's email (or read it from an env
  var like `CALENDAR_SYNC_OPERATOR_EMAIL`).
- **Option B — shared service account (recommended for durability):** a non-personal Google account
  owns the OAuth token; CSMs share calendars to it; survives any future personnel change.
  - [ ] Replace the hardcoded `_DRAKE_EMAIL` constant with an env var in both cron files.
  - [ ] Update `getDrakeOAuthState()` (and rename it, e.g. `getCalendarSyncOAuthState()`).
- [ ] **Test on preview** before prod: confirm the calendar sync cron still resolves a token and pulls events. This is gate (c) — Drake eyeballs the live result.

> NOTE: `/teams` is being retired and the Fulfillment dashboard reworked (per project memory), but
> `client_meetings_sync_cron` (per-client "meetings this mo." from Google Calendar) is **live** and
> uses the same coupling. Don't assume retiring `/teams` removes the dependency — verify the
> client-meetings path's token source before declaring the coupling gone.

### A.2 Cosmetic identifier swaps (low priority)

`drake@theaipartner.io` / `drake.ag.eoll@gmail.com` appear in User-Agent strings and test-email sets:
- `ingestion/{calendly,clarity,airtable}/client.py` — `User-Agent: "ai-enablement/1.0 (+drake@...)"`
- `scripts/register_calendly_webhook.py`, `scripts/explore_*` — same UA pattern
- `scripts/export_cold_leads.py`, `_dedup_*` — `TEST_EMAILS` sets (these scripts likely deleted in Session 1)

- [ ] Swap UA contact email to a company address (e.g. `eng@theaipartner.io`). Cosmetic — APIs only use it for politeness/contact.

---

## B. Reconcile `.env.example` — make it a truthful template

`.env.example` has drifted from what the code reads. This is critical for handoff: a new owner
deploying from `.env.example` would ship a subtly broken system.

**Status: DONE 2026-06-22.** `.env.example` reconciled against a full code sweep — 38 → 58 documented
vars. Added Cortana, Deepgram, Make-roster, Airtable-NPS, Ella passive kill switch, Slack extras, the
sales engagement-pinger config, the direct-DB-connection vars, the sales-dashboard flags, and the local
dev flag. Original checklist below.

**Add (live, currently undocumented):**
- [ ] `DEEPGRAM_API_KEY` — transcription (setter-call transcripts via `ingestion/setter_calls/`). Document the service, where to mint the key, who owns the account.
- [ ] `CORTANA_API_KEY` + `CORTANA_BUSINESS_ID` — Meta ad attribution (`ingestion/cortana/`, `api/cortana_sync_cron.py`).
- [ ] `MAKE_OUTBOUND_ROSTER_SECRET` — Make.com auth for `api/accountability_roster.py`.
- [ ] `AIRTABLE_NPS_WEBHOOK_SECRET` — `api/airtable_nps_webhook.py`.
- [ ] Config vars: `SETTER_TRIAGE_FORM_URL`, `CLOSER_TRIAGE_FORM_URL`, `SALES_FORM_NOTIFY_SLACK_CHANNEL`, `SLACK_WORKSPACE`, `ENGAGEMENT_PING_FLOOR`, `SUPABASE_DB_POOL_URL`, `SUPABASE_DB_PASSWORD` (ops note: already mentioned in CLAUDE.md but not in `.env.example`).

**Remove / mark dead:**
- [ ] `ONCEHUB_API_KEY` — service removed (commit `44af239`). Remove from `.env.local` and Vercel (Session 3).
- [ ] Legacy per-cron tokens superseded by `CRON_SECRET` (M6.2): `FATHOM_BACKFILL_AUTH_TOKEN`, `GREGORY_BRAIN_CRON_AUTH_TOKEN`, `ACCOUNTABILITY_NOTIFICATION_CRON_AUTH_TOKEN`. **Verify** they're truly unused (`grep -r` each across `api/`) before removing.
- [x] `AIRTABLE_API_KEY` — CONFIRMED legacy: production reads Airtable via the scoped PATs (`AIRTABLE_SALES_PAT` + `AIRTABLE_ACCOUNTABILITY_PAT`); the bare key is read only by `scripts/explore_airtable_api.py`. Left out of `.env.example`; Vercel cleanup deferred to Session 3.
- [ ] Dead Vercel vars already flagged in `docs/state.md`: `ESCALATION_RECIPIENT_SLACK_USER_ID`, `ELLA_DAILY_DIGEST_CC_SLACK_USER_ID`.

> The authoritative env set is **Vercel Production**, not `.env.local`. The reconcile here makes
> `.env.example` correct; the actual Vercel cleanup happens in Session 3 (gate d, Drake).

---

## C. Onboarding docs for a human engineer

The existing docs (CLAUDE.md, the Director/Builder system) are written for Drake's AI workflow. A new
human dev needs orientation that doesn't assume that workflow.

- [ ] **`docs/onboarding/FIRST-DAY.md`** — clone → `.env.local` (point at the Session-3 credential doc) → `npm install` → run tests (`pytest tests/` + whatever the TS test cmd is) → `npm run dev` → load the dashboard → "where to find X" table.
- [ ] **`docs/onboarding/ARCHITECTURE-101.md`** (or extend `docs/architecture.md`) — the one-page data-flow story: *external tools → ingestion pipelines → Supabase (source of truth) → agents read from Supabase → Next.js dashboard + Slack surfaces*. State the 4 core principles plainly. A diagram beats paragraphs.
- [ ] **State coverage honestly** (in FIRST-DAY and the docs index): the runbooks are kept accurate but there isn't one for every subsystem, and the docs overall are fairly — not fully — comprehensive. Absence of a doc does not mean absence of the system; the code is the source of truth. (Drake's explicit ask.)
- [ ] **`docs/onboarding/README.md`** — index: getting started, the runbooks (~40), schema docs (per table), ADRs, known-issues.
- [ ] **Add a note at the top of CLAUDE.md** (via the project's spec process if you want to be strict, or directly — Drake's call) clarifying: "the Director/Builder/Drake process below is the AI-assisted workflow Drake used; a human engineer doesn't need to follow it to work on the code. Start at `docs/onboarding/FIRST-DAY.md`."

---

## What success looks like

- No personal email resolves a live code path; calendar sync works under a non-Drake identity (tested on preview).
- `.env.example` matches what the code reads — a new owner can populate it and deploy a working system.
- A new engineer can go clone → tests green → dashboard up using only `docs/onboarding/`.

## Hand-off note

Record the OAuth decision (A/B) and test result here. Note any env var you couldn't confirm dead.
