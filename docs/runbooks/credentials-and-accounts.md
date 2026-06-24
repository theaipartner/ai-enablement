# Credentials & Accounts

The map of every account, key, and webhook the system depends on — what it's for, which env var
reads it, who owns the account, and where to rotate it. The actual secret **values** live in the
company password vault (Bitwarden); this doc is the index + rotation paths, not the values. Never
commit secrets — see `CLAUDE.md` § Critical Rules.

## Where the system runs

| Platform | Location | Notes |
|---|---|---|
| **GitHub** | `github.com/theaipartner/ai-enablement` | Source repo. Deploys auto-trigger on push to `main`. |
| **Vercel** | team **`success-projects-9dcde12c`** ("success' projects"), project `ai-enablement` | URL `ai-enablement-sigma.vercel.app`. Next.js app + Python serverless functions in `api/` + the 19 crons in `vercel.json`. |
| **Supabase** | project ref **`sjjovsjcfffrftnraocu`** (us-east-2 / Ohio) | Source of truth — all migrations + live data. Keys: `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`, `SUPABASE_DB_POOL_URL`. Rotate service_role + DB password from the Supabase dashboard → Settings → API / Database. |

Env vars are configured in **Vercel → Project → Settings → Environment Variables** (Production). The
authoritative set is what's in Vercel; `.env.local` is the local-dev copy and can drift.

## Load-bearing production dependency — the calendar-sync Google account

Both calendar syncs (`teams_calendar_sync_cron` and `client_meetings_sync_cron`) are pinned to the
**work account `drake@theaipartner.io`**. One OAuth token (in `oauth_tokens`, keyed to that account's
`team_member_id`, `access_tier='creator'`) reads **all** CSM calendars, because the CSMs share their
calendars with that account at the Google Workspace level.

Hardcoded at:
- `api/teams_calendar_sync_cron.py` — `_DRAKE_EMAIL = "drake@theaipartner.io"`
- `api/client_meetings_sync_cron.py` — `_DRAKE_EMAIL = "drake@theaipartner.io"`
- `lib/db/teams.ts` — `getDrakeOAuthState()` reads that token row

**This account and its OAuth token must stay active**, or both calendar syncs silently break (the cron
writes an `oauth_token_unavailable` audit row to `webhook_deliveries`). Two ways to keep it healthy:
- **Keep the account alive** — the simplest path; treat it as a service identity, not a normal
  departing-employee account.
- **Re-pin to a successor identity or a shared service account** — swap `_DRAKE_EMAIL` (make it an env
  var), add a `team_members` + `oauth_tokens` row for the new identity, and have the CSMs re-share their
  calendars to it.

**Recovery if the token is ever lost:** a `creator`-tier operator re-runs `/api/auth/google/connect`
to mint a fresh token, then the CSMs re-share calendars to that identity.

## Third-party accounts

For each: purpose · env var(s) · account owner · where to mint/rotate.

### Owned on others' accounts — document, don't migrate
| Service | Purpose | Var(s) | Owner | Mint/rotate |
|---|---|---|---|---|
| **Fathom** | Call recordings/transcripts | `FATHOM_API_KEY`, `FATHOM_WEBHOOK_SECRET` | **Nabeel** (account-owner-only) | Fathom Settings → API Access. Webhook secret = delete+recreate the webhook. |
| **Wistia** | Video analytics | `WISTIA_API_TOKEN` | **Nabeel** (account-owner-only) | Wistia → Account Settings → API Access. |
| **Microsoft Clarity** | Page metrics | `CLARITY_API_KEY` | **Admin-only (Nabeel)** | Clarity → Settings → Data Export. 10 req/project/day cap. |

### Company accounts
| Service | Purpose | Var(s) | Owner | Mint/rotate |
|---|---|---|---|---|
| **Anthropic** | All Claude calls | `ANTHROPIC_API_KEY` | Company | console.anthropic.com → Keys |
| **OpenAI** | Embeddings (`text-embedding-3-small`) | `OPENAI_API_KEY` | Company | platform.openai.com → API keys |
| **Slack** | Ella bot + ingestion | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_USER_TOKEN` | Company (workspace admin) | api.slack.com/apps. `SLACK_USER_TOKEN` ties to the dedicated `@ella` **user** account — confirm who controls that login. |
| **Google Cloud** | Calendar OAuth (Teams + client-meetings sync) | `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `NEXT_PUBLIC_APP_URL` | Company GCP project | console.cloud.google.com → Credentials. Redirect URI must be `{APP_URL}/api/auth/google/callback`. See the calendar-OAuth dependency above. |
| **Close CRM** | Lead/activity mirror | `CLOSE_API_KEY`, `CLOSE_WEBHOOK_SECRET` | Company | Close → Settings → Developer. Auth = key as Basic-auth username, empty password. |
| **Calendly** | Bookings/invitees | `CALENDLY_API_KEY`, `CALENDLY_WEBHOOK_SECRET` | Company (Admin/Owner tier) | Calendly → Integrations → API & Webhooks. |
| **Typeform** | Lead opt-in forms | `TYPEFORM_API_KEY`, `TYPEFORM_WEBHOOK_SECRET` | Company | Typeform → Settings → Personal tokens. |
| **Airtable (sales)** | Setter/Closer funnel, base `appCWa6TV6p7EBarC` | `AIRTABLE_SALES_PAT`, `AIRTABLE_WEBHOOK_ID`, `AIRTABLE_WEBHOOK_MAC_SECRET` | Company | airtable.com/create/tokens. Needs `data.records:read` + `webhook:manage`. |
| **Airtable (accountability)** | Accountability table, base `appR566PxMuP71mD6` | `AIRTABLE_ACCOUNTABILITY_PAT`, `_BASE_ID`, `_TABLE_ID` | Company | Separate PAT, read-only. |
| **Cortana** | Meta ad attribution | `CORTANA_API_KEY`, `CORTANA_BUSINESS_ID` | Company | Cortana settings. |
| **Deepgram** | Setter-call transcription | `DEEPGRAM_API_KEY` | Company (confirm billing owner) | console.deepgram.com. |

### Glue / internal-issued secrets (rotate, hand to the right person)
| Var | Purpose | Notes |
|---|---|---|
| `CRON_SECRET` | Single Bearer token for ALL cron endpoints | Rotate = change in Vercel + redeploy. |
| `MAKE_OUTBOUND_ROSTER_SECRET` | Make.com auth to `/api/accountability_roster` | Shared secret; must match Make.com's HTTP header. |
| `AIRTABLE_ONBOARDING_WEBHOOK_SECRET` | Make.com onboarding receiver | Shared with Make.com. |
| `AIRTABLE_NPS_WEBHOOK_SECRET` | NPS webhook receiver | Shared with Make.com. |
| `SPEED_TO_LEAD_API_KEY` | Bearer for `/api/speed-to-lead` (Zain) | Hand the new value to Zain after rotation. |

## Webhooks — re-register ONLY if the Vercel URL changes

All five are registered against `ai-enablement-sigma.vercel.app`. **As long as that URL stays, leave
them alone.** If the URL ever changes, re-run each helper with the new URL, then update the returned
secret in Vercel (several mint one-time secrets):

| Service | Endpoint | Helper | Notes |
|---|---|---|---|
| Fathom | `/api/fathom_events` | (manual) | Secret not rotatable via API; rotation = delete + recreate the webhook. |
| Calendly | `/api/calendly_events` | `scripts/register_calendly_webhook.py` | Caller-supplied secret. |
| Typeform | `/api/typeform_events` | `scripts/register_typeform_webhooks.py` | Per-form; auto-selects forms active in the last 30 days. |
| Airtable | `/api/airtable_events` | `scripts/register_airtable_webhook.py` | Base-level; `macSecretBase64` returned once. Needs `webhook:manage` scope on the PAT. |
| Close | `/api/close_events` | `scripts/register_close_webhook.py` | Registration infra ready; not yet live. |

## Make.com

Daily pull from `/api/accountability_roster` for accountability + NPS automation. Confirm account
ownership; the shared-secret header (`MAKE_OUTBOUND_ROSTER_SECRET`) must match on both sides after any
rotation.

## Operational quirks (easy to miss)

- **Calendly** requires a custom `User-Agent` header or Cloudflare blocks the request (see
  `ingestion/calendly/client.py`).
- **Airtable** webhooks expire after **7 days idle** — the `airtable_sync_cron` refreshes them; if the
  cron stops, the webhook quietly dies.
- **Clarity** caps API export at **10 requests/project/day**.

## Knowledge to confirm with the team

- Who holds each **Nabeel-owned** account (Fathom, Wistia, Clarity) and the rotation contact.
- The `@ella` Slack **user** account login + recovery.
- **Deepgram** account + billing owner.
- That every `*_PROD` secret is in the company vault with the right access.
