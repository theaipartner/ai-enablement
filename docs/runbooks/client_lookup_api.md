# Client Lookup API (Zane)

Read-only JSON endpoint that takes an email and returns the **full client
record** we hold for that person. Built for Zane to pull client data
without dashboard access.

## Endpoint

```
GET https://ai-enablement-sigma.vercel.app/api/clients?email=<address>
```

- **Auth:** `Authorization: Bearer <CLIENT_LOOKUP_API_KEY>` (required).
- **`email`** (required): the client's email address. Matched
  case-insensitively against the client's **primary email first**, then
  their **`metadata.alternate_emails`** — the same identity surface the
  rest of the system uses. Archived clients are excluded.

## Example

```bash
curl -s -H "Authorization: Bearer $CLIENT_LOOKUP_API_KEY" \
  "https://ai-enablement-sigma.vercel.app/api/clients?email=jane@example.com"
```

## Response

`200` with the whole `clients` row under `client` — every column we
store (identity, status, journey stage, CSM/NPS standing, program type,
tags, financials, `slack_user_id`, the open-ended `metadata` jsonb,
timestamps, …):

```json
{
  "client": {
    "id": "…uuid…",
    "email": "jane@example.com",
    "full_name": "Jane Doe",
    "phone": "+1…",
    "timezone": "America/New_York",
    "status": "active",
    "journey_stage": "first_closed_deal",
    "csm_standing": "happy",
    "nps_standing": "promoter",
    "program_type": "9k_consumer",
    "tags": ["…"],
    "slack_user_id": "U0123ABC",
    "metadata": { "…": "…" },
    "created_at": "…",
    "updated_at": "…"
  }
}
```

The Slack **channel** id is not a column on `clients` (it lives in
`slack_channels`); it is not included in this payload. Everything else on
the row is.

## Errors

| Status | Body | Meaning |
|--------|------|---------|
| 400 | `{"error":"email_required"}` | No `email` query param. |
| 401 | `{"error":"unauthorized"}` | Missing/wrong bearer key. |
| 404 | `{"error":"not_found"}` | No non-archived client matches the email (primary or alternate). |
| 500 | `{"error":"server_misconfigured"}` | `CLIENT_LOOKUP_API_KEY` not set in the environment (deploy bug). |

## Key management

- Env var: **`CLIENT_LOOKUP_API_KEY`** (see `.env.example`).
- Generate: `openssl rand -hex 32`.
- Set in **Vercel → Production** env vars (+ `.env.local` for local
  testing), then hand the value to Zane.
- **Rotate** by changing the env var and redeploying; reissue to Zane.
  The key only unlocks this one endpoint — no Supabase/DB access.

## Scope / extension notes

- One email per request; returns the raw `clients` row only (no derived
  health/CSM/calls). To enrich, extend the route to call the same
  helpers `getClientById` uses.
- Code: `app/api/clients/route.ts`. Data layer: `lib/db/clients.ts` →
  `getClientByEmail`. Bearer check: `lib/api/bearer-auth.ts` (shared with
  `/api/speed-to-lead`).
</content>
