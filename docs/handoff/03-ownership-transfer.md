# Session 3 — Ownership & Credential Transfer

**Goal:** Move the three platforms (GitHub, Vercel, Supabase) and the ~16 third-party accounts from
Drake's personal ownership to the company, and rotate/re-document credentials. This doc is also the
**durable credential inventory** — the knowledge that otherwise walks out the door with Drake.

**Risk level:** High — irreversible account actions + production credentials. Most steps are Drake's
gates (a) irreversible and (d) credentials. Do the cleanup (Session 1) and de-personalization
(Session 2) first so there's less to move.

> Read [`00-overview.md`](00-overview.md) first. No secret VALUES are recorded in this doc — only key
> names, owners, and where to get/rotate them.

---

## ⏳ LIVE STATUS — RESUME HERE (as of 2026-06-24)

Session 3 is mid-execution. **Done: credentials, GitHub, Supabase. Remaining: Vercel** (the last big step).

**DONE:**
- **Credentials** → company Bitwarden, one secure note holding the full prod env set. Local master file shredded. Recovery used: 38 pulled from Vercel + 13 from `.env.local` + Fathom×2 from Drake's personal Bitwarden + `SALES_FORM_NOTIFY_SLACK_CHANNEL` looked up; `ONCEHUB_WEBHOOK_SECRET` dropped (dead); **`CRON_SECRET` freshly generated** (`openssl rand -hex 32`) — now lives only in the Bitwarden note.
- **GitHub** → transferred `drakeynes/ai-enablement` → **`theaipartner/ai-enablement`** (company USER account, *not* an org — Drake's call; can convert later). Local remote re-pointed; all session commits pushed; company repo is at the clean state.
- **Supabase** → project `sjjovsjcfffrftnraocu` transferred to the company org; verified alive (60 public tables; same ref/URL/keys, so Vercel is unaffected). Follow-ups: put a card on the company org + **upgrade it to Pro**, then **downgrade Drake's personal org** (stop paying).

**STATE TO KNOW:** Vercel **auto-deploy is PAUSED** (the repo moved; the Vercel GitHub App isn't yet authorized on `theaipartner`). **No downtime** — the live deployment keeps serving. Auto-deploy resumes when Git is re-linked in the Vercel step.

**NEXT — Vercel transfer (do in ONE low-traffic sitting; it's the only step with a brief gap):**
- *Prereqs:* add Drake's Vercel account (`drakeynes`) as a **member of the company Vercel team**; company team on **Pro + card** (19 crons incl. per-minute → Hobby won't support it). Billing moves to the company.
1. Project `ai-enablement` (projectId `prj_EeWPd4k8agIsq90BILpxnTX24JB8`) → **Settings → Transfer Project** → company team.
2. **RE-ADD env vars from the Bitwarden note** — Vercel does NOT carry env vars across a transfer. **DROP the dead ones:** `ONCEHUB_API_KEY`, `ONCEHUB_WEBHOOK_SECRET`, `FATHOM_BACKFILL_AUTH_TOKEN`, `GREGORY_BRAIN_CRON_AUTH_TOKEN`, `ACCOUNTABILITY_NOTIFICATION_CRON_AUTH_TOKEN`, `ESCALATION_RECIPIENT_SLACK_USER_ID`, `ELLA_DAILY_DIGEST_CC_SLACK_USER_ID`. Use the fresh `CRON_SECRET`. Skip `VERCEL_*` system vars. (`AIRTABLE_API_KEY` is legacy/explore-only — optional.)
3. **Re-connect Git** to `theaipartner/ai-enablement` (authorize the Vercel GitHub App on the company GitHub) → restores auto-deploy.
4. **Verify the URL is still `ai-enablement-sigma.vercel.app`** (keeps the 5 webhooks working). If it changed → re-register via `scripts/register_*.py`.
5. **Redeploy**, then verify end-to-end: push a trivial commit → auto-deploys; a cron fires (`webhook_deliveries` audit rows); edit an Airtable record → row updates.
- *Why one sitting:* between the transfer and finishing the env re-add, functions have no config and will error — paste fast, redeploy.

**AFTER Vercel:** downgrade Drake's personal Supabase + Vercel orgs. Non-code IT item (already flagged in §C Google Cloud + Session 2 §A.1): **keep the `drake@theaipartner.io` work account ACTIVE through offboarding** — the calendar OAuth depends on it. Drake hands over his Google account login later.

---

## STEP 0 — Export the authoritative credential set (Drake, gate d) — DO THIS FIRST

`.env.local` has drifted (dead OnceHub key, legacy cron tokens). **Vercel Production is the source of
truth.** Before any transfer:

- [ ] Drake exports the full Vercel Production env var set (Vercel dashboard → project → Settings → Environment Variables, or `vercel env pull`).
- [ ] Reconcile against the inventory table below + the Session-2 `.env.example` reconcile. Flag anything in Vercel not listed here.
- [ ] Store the authoritative set in the company password manager (Bitwarden today) under company-controlled access — **not** Drake's personal vault.

---

## A. The three platforms

### GitHub
- **Current:** `https://github.com/drakeynes/ai-enablement` (Drake's personal account).
- [ ] Create/confirm a company GitHub org.
- [ ] Use **Settings → Transfer repository** to move it to the org (preserves history, issues, and the Vercel integration). Adding the company as a collaborator is NOT equivalent — ownership stays personal.
- [ ] Re-grant team access on the org side.
- [ ] Update any local clones' remotes.

### Vercel
- **Current:** Drake's account, project `ai-enablement`, URL `ai-enablement-sigma.vercel.app`.
- [ ] Transfer the **existing project** to a company Vercel team (Vercel supports project transfer between teams). **Keep the URL** — see "Webhooks" below for why.
- [ ] Re-link the GitHub integration to the org repo (auto-deploy on push to `main`).
- [ ] Re-create all env vars in the company team's Production scope (from STEP 0).
- [ ] Confirm all **19 cron jobs** carry over (they're declared in `vercel.json`, so a redeploy re-registers them — verify in the dashboard).
- [ ] Remove dead env vars while you're here (all confirmed 0 code refs on 2026-06-22): `ONCEHUB_API_KEY` (OnceHub removed), the 3 legacy per-cron tokens `FATHOM_BACKFILL_AUTH_TOKEN` / `GREGORY_BRAIN_CRON_AUTH_TOKEN` / `ACCOUNTABILITY_NOTIFICATION_CRON_AUTH_TOKEN` (superseded by the single `CRON_SECRET`), and `ESCALATION_RECIPIENT_SLACK_USER_ID` + `ELLA_DAILY_DIGEST_CC_SLACK_USER_ID`. **`AIRTABLE_API_KEY` is NOT dead** — it's a legacy single key read only by `scripts/explore_airtable_api.py`; production reads Airtable via the scoped PATs. Drop it from Vercel only if the explore script won't be run.

### Supabase
- **Current:** Drake's project `sjjovsjcfffrftnraocu` (region us-east-2 / Ohio). Source of truth.
- [ ] Transfer the project to a company Supabase org (Supabase supports org/project transfer — confirm current mechanism in their dashboard).
- [ ] Rotate the `service_role` key + DB password after transfer; update Vercel + the company vault.
- [ ] Confirm the pooler URL (`SUPABASE_DB_POOL_URL`) for ops scripts.
- [ ] Re-confirm `NEXT_PUBLIC_SUPABASE_*` (anon key + URL) for the dashboard.

---

## B. Webhooks — re-register ONLY if the Vercel URL changes

All registered against `ai-enablement-sigma.vercel.app`. **If the project transfer keeps the URL,
skip this section.** If a new URL is used, re-run each helper with the new URL, then update the
returned secret in Vercel (several are one-time mints):

| Service | Endpoint | Helper | Notes |
|---|---|---|---|
| Fathom | `/api/fathom_events` | (manual) | Secret not rotatable via API; rotation = delete + recreate webhook. |
| Calendly | `/api/calendly_events` | `scripts/register_calendly_webhook.py` | Caller-supplied secret. |
| Typeform | `/api/typeform_events` | `scripts/register_typeform_webhooks.py` | Per-form; auto-selects forms active in last 30 days. |
| Airtable | `/api/airtable_events` | `scripts/register_airtable_webhook.py` | Base-level; `macSecretBase64` returned once. Needs `webhook:manage` scope on the PAT. |
| Close | `/api/close_events` | `scripts/register_close_webhook.py` | Registration infra ready; not yet live. |

---

## C. Third-party account inventory

For each: what it does · auth var(s) · who owns it · where to mint/rotate. **Verify the "owner" column
with Drake — several are assumptions.**

### Already on others' accounts — DOCUMENT, don't migrate
| Service | Purpose | Var(s) | Owner | Mint/rotate |
|---|---|---|---|---|
| **Fathom** | Call recordings/transcripts | `FATHOM_API_KEY`, `FATHOM_WEBHOOK_SECRET` | **Nabeel** (account-owner-only) | Fathom Settings → API Access. Webhook secret = delete+recreate. |
| **Wistia** | Video analytics | `WISTIA_API_TOKEN` | **Nabeel** (account-owner-only) | Wistia → Account Settings → API Access. |
| **Microsoft Clarity** | Page metrics | `CLARITY_API_KEY` | **Admin-only — Nabeel if Drake isn't admin** | Clarity → Settings → Data Export. 10 req/project/day cap. |

### Verify owner / migrate to company
| Service | Purpose | Var(s) | Owner (verify) | Mint/rotate |
|---|---|---|---|---|
| **Anthropic** | All Claude calls | `ANTHROPIC_API_KEY` | likely company | console.anthropic.com → Keys |
| **OpenAI** | Embeddings (`text-embedding-3-small`) | `OPENAI_API_KEY` | likely company | platform.openai.com → API keys |
| **Supabase** | DB / source of truth | `SUPABASE_*` | Drake → company | dashboard (see §A) |
| **Slack** | Ella bot + ingestion | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_USER_TOKEN` | workspace admin + a dedicated `@ella` user | api.slack.com/apps. `SLACK_USER_TOKEN` ties to the `@ella` *user account* — confirm who controls it. |
| **Google Cloud** | Calendar OAuth (Teams + client-meetings sync) | `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `NEXT_PUBLIC_APP_URL` | Drake's GCP project | console.cloud.google.com → Credentials. Redirect URI must be `{APP_URL}/api/auth/google/callback`. **DECISION (2026-06-22): the calendar OAuth stays pinned to the `drake@theaipartner.io` work account (no code de-personalization). KEEP THAT WORK ACCOUNT ACTIVE through Drake's offboarding** — do not deactivate/delete it, or both calendar syncs break (the `oauth_tokens` row is keyed to it and the CSMs share calendars with it). See Session 2 §A.1 for recovery if it's ever lost. |
| **Close CRM** | Lead/activity mirror | `CLOSE_API_KEY`, `CLOSE_WEBHOOK_SECRET` | verify | Close → Settings → Developer. Auth = key as Basic-auth username, empty password. |
| **Calendly** | Bookings/invitees | `CALENDLY_API_KEY`, `CALENDLY_WEBHOOK_SECRET` | verify (Admin/Owner tier) | Calendly → Integrations → API & Webhooks. |
| **Typeform** | Lead opt-in forms | `TYPEFORM_API_KEY`, `TYPEFORM_WEBHOOK_SECRET` | verify | Typeform → Settings → Personal tokens. |
| **Airtable (sales)** | Setter/Closer funnel, base `appCWa6TV6p7EBarC` | `AIRTABLE_SALES_PAT`, `AIRTABLE_WEBHOOK_ID`, `AIRTABLE_WEBHOOK_MAC_SECRET` | verify | airtable.com/create/tokens. Needs `data.records:read` + `webhook:manage`. |
| **Airtable (accountability)** | Accountability table, base `appR566PxMuP71mD6` | `AIRTABLE_ACCOUNTABILITY_PAT`, `_BASE_ID`, `_TABLE_ID` | verify | Separate PAT, read-only. |
| **Cortana** | Meta ad attribution | `CORTANA_API_KEY`, `CORTANA_BUSINESS_ID` | verify | Cortana settings. **Undocumented in `.env.example` — add in Session 2.** |
| **Deepgram** | Setter-call transcription | `DEEPGRAM_API_KEY` | **verify — entirely undocumented** | console.deepgram.com. **This service was missing from all env docs — confirm account + billing owner.** |

### Glue / internal-issued secrets (regenerate, hand to the right person)
| Var | Purpose | Notes |
|---|---|---|
| `MAKE_OUTBOUND_ROSTER_SECRET` | Make.com auth to `/api/accountability_roster` | Shared secret; must match Make.com's HTTP header. Undocumented in `.env.example`. |
| `AIRTABLE_ONBOARDING_WEBHOOK_SECRET` | Make.com onboarding receiver | Shared with Make.com. |
| `AIRTABLE_NPS_WEBHOOK_SECRET` | NPS webhook receiver | Undocumented in `.env.example`. |
| `CRON_SECRET` | Single Bearer token for ALL cron endpoints | Consolidated M6.2. Rotate = change in Vercel + redeploy. |
| `SPEED_TO_LEAD_API_KEY` | Bearer for `/api/speed-to-lead` (Zain) | Hand new value to Zain after rotation. |

### Make.com
- **Purpose:** daily pull from `/api/accountability_roster` for accountability + NPS automation.
- [ ] Confirm Make.com account ownership; transfer/share the scenario; update the shared-secret header after rotation.

---

## D. Personnel knowledge to capture (in Drake's head today)

- [ ] Who actually holds each "Nabeel-owned" account, and the rotation contact.
- [ ] The `@ella` Slack user account credentials + recovery.
- [ ] Any operational quirks not in runbooks (e.g. Calendly's required custom User-Agent to dodge Cloudflare; Airtable's 7-day webhook idle-expiry that the cron refreshes; Clarity's 10-req/day cap).
- [ ] Bitwarden → company vault migration of every `*_PROD` secret.

---

## What success looks like

- All three platforms owned by the company; Drake's personal accounts can be removed without breaking prod.
- Every credential in the company vault, owner + rotation path documented in the inventory above.
- No dead env vars in Vercel. `.env.example` matches reality (done in Session 2).
- A new operator can rotate any key without asking Drake.

## Verification after transfer

- [ ] Push a trivial commit → confirm Vercel auto-deploys under the company team.
- [ ] Confirm crons fire (check `webhook_deliveries` audit rows / Vercel cron logs).
- [ ] Trigger one webhook end-to-end (e.g. edit an Airtable record) and confirm the row updates.
- [ ] Dashboard loads + reads from Supabase under the new project.
