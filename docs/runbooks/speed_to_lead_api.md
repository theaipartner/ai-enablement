# Speed-to-Lead API (Zain)

Read-only JSON endpoint that returns the day's **average speed-to-lead**
— overall and for leads called within 3 hours. Built for Zain to pull
the number without dashboard access.

## Endpoint

```
GET https://ai-enablement-sigma.vercel.app/api/speed-to-lead
GET https://ai-enablement-sigma.vercel.app/api/speed-to-lead?date=2026-05-29
```

- **Auth:** `Authorization: Bearer <SPEED_TO_LEAD_API_KEY>` (required).
- **`date`** (optional): an ET calendar day `YYYY-MM-DD`. Omitted or
  invalid → **today (ET)**. The cohort is the leads who opted in that ET
  day; speed-to-lead is opt-in → first outbound call.
- Floor: data starts **2026-05-24**; earlier dates clamp/return empty.

The numbers come from the same `getSpeedToLeadCohort` the dashboard's
Appointment-Setting page uses, so they match exactly.

## Example

```bash
curl -s -H "Authorization: Bearer $SPEED_TO_LEAD_API_KEY" \
  "https://ai-enablement-sigma.vercel.app/api/speed-to-lead?date=2026-05-29"
```

## Response

```json
{
  "date": "2026-05-29",
  "timezone": "America/New_York",
  "averageSpeedToLead": { "seconds": 5400, "minutes": 90 },
  "cohortSize": 12,
  "leadsCalled": 10
}
```

- `averageSpeedToLead` — mean opt-in → first-call across all called
  leads in the day's cohort, counting **only business-hours time
  (10am–10pm ET)**: overnight waits don't count, so a lead that opts in
  at 1am and is first dialled at noon is a 2h speed-to-lead. 24h cap on
  outliers per lead. `seconds`/`minutes` are `null` when no leads were
  called.
- `cohortSize` / `leadsCalled` — context for the average.

> **Changed 2026-06-16:** the metric switched from wall-clock to a
> business-hours clock, and the separate `averageSpeedToLeadUnder3h`
> object was **removed** (the business-hours clock supersedes the old
> "< 3h" overnight-stripping). Update any consumer that read that field.

## Errors

| Status | Body | Meaning |
|--------|------|---------|
| 401 | `{"error":"unauthorized"}` | Missing/wrong bearer key. |
| 500 | `{"error":"server_misconfigured"}` | `SPEED_TO_LEAD_API_KEY` not set in the environment (deploy bug). |

## Key management (gate (d) — Drake)

- Env var: **`SPEED_TO_LEAD_API_KEY`** (see `.env.example`).
- Generate: `openssl rand -hex 32`.
- Set in **Vercel → Production** env vars (+ `.env.local` for local
  testing), then hand the value to Zain.
- **Rotate** by changing the env var and redeploying; reissue to Zain.
  The key only unlocks this one endpoint — no Supabase/DB access.

## Scope / extension notes

- One ET day per request. For a range or per-rep breakdown, extend the
  route (the underlying `getSpeedToLeadCohort` already supports a
  `DateRange` and a caller filter).
- Code: `app/api/speed-to-lead/route.ts`. Data layer:
  `lib/db/funnel-appointment-setting.ts` → `getSpeedToLeadCohort`.
