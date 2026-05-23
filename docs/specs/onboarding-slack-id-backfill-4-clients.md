# Onboarding webhook — backfill slack IDs for 4 clients via curl
**Slug:** onboarding-slack-id-backfill-4-clients
**Status:** shipped

**Target branch: main**

> NOT Ella-worktree work. Run from the MAIN checkout. This is an EXECUTION task (fire 4 specific onboarding-webhook calls + verify), not a code change. The four payloads are exact and provided below — do NOT invent, modify, or add clients beyond these four. The Close backfill is a separate local OS process; unaffected.

## Why this exists

Four clients exist in Gregory but are missing their Slack IDs. The onboarding webhook (`api/airtable_onboarding_webhook.py`) is idempotent on email — re-firing with the same email + slack IDs backfills the IDs onto the existing row via `action='updated'` (see `docs/runbooks/airtable_onboarding_webhook.md` § "Re-fire to add slack IDs"). Drake wants these four backfilled without hand-running each curl.

## What to do

Fire these FOUR exact POSTs to `https://ai-enablement-sigma.vercel.app/api/airtable_onboarding_webhook`, header `X-Webhook-Secret: $AIRTABLE_ONBOARDING_WEBHOOK_SECRET` (read from `.env.local` — do NOT print the secret value anywhere, including logs/report), `Content-Type: application/json`. Fire them ONE AT A TIME, check each response before the next.

1. Matt Solomon
```json
{"full_name":"Matt Solomon","email":"loumantis@gmail.com","country":"USA","date_joined":"2026-05-09","slack_user_id":"U0B3M2F0AM6","slack_channel_id":"C0B3M1YML0G"}
```

2. Catrina Bodamer — **uses her CURRENT (intentionally not-yet-corrected) email so the email-match hits the existing row.** Do NOT change this email.
```json
{"full_name":"Catrina Bodamer","email":"katiebdee@gmail.com","country":"USA","date_joined":"2026-05-08","slack_user_id":"U0B2HAH69GD","slack_channel_id":"C0B2E89QEHZ"}
```

3. Britney Fields-Feliz
```json
{"full_name":"Britney Fields-Feliz","email":"britney@fieldsfelizent.com","country":"USA","date_joined":"2026-05-22","slack_user_id":"U0B57RZU18F","slack_channel_id":"C0B57RFEA9M"}
```

4. Steve Lowery
```json
{"full_name":"Steve Lowery","email":"sal2177@gmail.com","country":"USA","date_joined":"2026-05-21","slack_user_id":"U0B5A08Q1SP","slack_channel_id":"C0B6AG23QF2"}
```

## Expected result per call

- **`200` with `"action":"updated"`** = success. The client existed (matched on email), slack IDs backfilled. This is the expected outcome for all four.
- Capture each response's `action` + `client_id` + status code in the report.

## STOP-and-surface (do NOT push through)

- **`"action":"created"`** (instead of `updated`) on ANY call → the email did NOT match an existing client and a NEW row was just created (possible duplicate). STOP, do not fire the rest, report which one + that a duplicate may have been created so Drake can check.
- **`409` conflict** (`slack_user_id_conflict` / `slack_channel_id_*`) → that client already has a different ID stored. STOP that one, report the conflict detail, continue to the others only if they're independent.
- **`400` / `401` / `500`** → report the exact error. `401` = secret not loaded correctly. Do not retry blindly.
- Any `created`/409/4xx/5xx is a surface-to-Drake event, not a fix-and-continue.

## Verify after firing

For each of the four, confirm via a read-only cloud SELECT that the row now has the slack_user_id set:
```sql
select email, slack_user_id, slack_channel_id from clients
where lower(trim(email)) in (
  'loumantis@gmail.com','katiebdee@gmail.com',
  'britney@fieldsfelizent.com','sal2177@gmail.com'
);
```
Report the four rows' slack_user_id values (confirm non-null + matching the payloads).

## Hard stops

- Fire ONLY these four exact payloads. Do not add, modify, or invent clients.
- Never print the webhook secret.
- One at a time; stop on the first unexpected response.
- Do NOT correct Catrina's email — that's a separate Drake dashboard action AFTER this backfill. Using the current email here is intentional (it's the match key).
- MAIN checkout. No Ella/Close touches.

## Report

`docs/reports/onboarding-slack-id-backfill-4-clients.md`: the 4 statuses + actions + the verify-query result. Flip spec to shipped if all four `updated` + verified; leave in-flight + flag if any stopped.
