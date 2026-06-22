# Handoff to AI Partner — Overview & Map

**Created:** 2026-06-22
**Purpose:** Drake is leaving; ownership of the Gregory system (code + infrastructure + accounts)
transfers to the company. This folder is the durable audit + execution plan so any session can
pick up without re-auditing from scratch.

This is the **master map**. Three session docs hold the actual work:

| Doc | Session | Status |
|---|---|---|
| [`01-codebase-cleanup.md`](01-codebase-cleanup.md) | **Session 1 — do first.** Delete scratch, archive one-shots, fix gitignore, sweep shipped specs/reports. | not started |
| [`02-depersonalize-and-onboarding.md`](02-depersonalize-and-onboarding.md) | **Session 2.** Remove Drake-pinned identifiers from code, reconcile `.env.example`, write human-onboarding docs. | not started |
| [`03-ownership-transfer.md`](03-ownership-transfer.md) | **Session 3.** Transfer GitHub/Vercel/Supabase + the ~16 third-party accounts. The credential inventory lives here. | not started |

---

## Why this order (cleanup → de-personalize → transfer)

Drake's call, and it's the right one. "Handover" is two things:

1. **Knowledge capture** — which accounts exist, who owns them, where keys live, the Drake-pinned
   couplings. This lives in Drake's head and walks out the door. **These documents ARE the capture** —
   the moment they're written, the knowledge is safe regardless of when the accounts actually move.
2. **Account/code transfer** — the real migrations. These genuinely get easier after cleanup: an
   organized repo with the scratch gone is less to explain and less to hand over.

Because the docs capture the knowledge up front, executing cleanup first carries no extra risk.

---

## The three platforms (core transfer — detail in `03`)

| Platform | Current personal owner | Recommended action |
|---|---|---|
| **GitHub** | `github.com/drakeynes/ai-enablement` | "Transfer repository" to a company org (preserves history + Vercel link). |
| **Vercel** | Drake's account, project `ai-enablement`, URL `ai-enablement-sigma.vercel.app` | Transfer the **existing project** to a company team. **Keep the URL** — see below. |
| **Supabase** | Drake's project `sjjovsjcfffrftnraocu` (us-east-2) | Org transfer. This is the source of truth — 50+ migrations, all live data. |

**Load-bearing recommendation:** keep the same Vercel deployment URL through the transfer. Five external
webhooks (Fathom, Calendly, Typeform, Airtable, Close) are registered against
`ai-enablement-sigma.vercel.app`. If the URL changes, all five need re-registration — several mint
one-time secrets. Transferring the existing project avoids that entirely.

---

## ~16 third-party services (detail in `03`)

- **Already on others' accounts (Nabeel):** Fathom, Wistia, Microsoft Clarity. Handoff = *document* who holds them, not migrate.
- **Verify owner / likely company:** Anthropic, OpenAI, Slack (app "Ella" + dedicated `@ella` user), Close CRM, Calendly, Typeform, Airtable (2 PATs/bases), Cortana (Meta attribution), **Deepgram** (transcription — undocumented), Google Cloud (OAuth project).
- **Glue:** Make.com (pulls accountability roster daily).

---

## Credential drift already found (the reason the audit matters)

`.env.example` documents ~28 vars but is **out of date vs. what the code actually reads**. Confirmed gaps:

- `DEEPGRAM_API_KEY` — live transcription service, entirely undocumented.
- `CORTANA_API_KEY` / `CORTANA_BUSINESS_ID`, `MAKE_OUTBOUND_ROSTER_SECRET`, `AIRTABLE_NPS_WEBHOOK_SECRET` — live, undocumented.
- `ONCEHUB_API_KEY` — still in `.env.local`, but OnceHub was removed (commit `44af239`). **Dead.**
- `FATHOM_BACKFILL_AUTH_TOKEN`, `GREGORY_BRAIN_CRON_AUTH_TOKEN`, `ACCOUNTABILITY_NOTIFICATION_CRON_AUTH_TOKEN` — superseded by single `CRON_SECRET` (M6.2). **Likely dead.**
- `AIRTABLE_API_KEY` — likely superseded by the two scoped PATs.

**Authoritative source is the Vercel Production env set, NOT `.env.local`** (which has drifted — dead OnceHub key, legacy cron tokens). Drake must export the Vercel set for `03`; this requires Drake (gate d).

---

## Open decisions needed from Drake

These block parts of Sessions 2–3. Capture answers here as they're made:

1. **Keep the Vercel URL?** (Strongly recommended yes.) → _answer:_ TBD
2. **Google-Calendar OAuth coupling** — Teams/client-meetings sync is pinned to `drake@theaipartner.io`
   (one OAuth token reads all CSM calendars). → _answer (2026-06-22):_ **keep it on that work account, no
   code change** — it's a company-controlled work account. **Dependency:** the account + its OAuth token
   must stay active through Drake's offboarding or both calendar syncs break. See Session 2 §A.1 + the
   Session 3 Google Cloud row.
3. **OnceHub table** — `0092_oncehub_bookings` migration + table are inert. Drop, or leave for archaeology? → _answer:_ TBD
4. **`docs/state.md` (686 lines)** — keep as historical log, or distill into a lean status page? → _answer:_ TBD

---

## Quick facts (snapshot 2026-06-22)

- Tracked files: 893. Untracked: ~97 (mostly `scripts/_diag_*` scratch).
- 50+ Supabase migrations. 28 Python serverless functions in `api/`. 19 Vercel cron jobs.
- Ingestion sources: fathom, slack, close, cortana(meta), wistia, calendly, typeform, clarity, airtable, setter_calls, content.
- Webhook registration helpers: `scripts/register_{airtable,calendly,close,typeform}_webhook*.py`.
