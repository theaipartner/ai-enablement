# Report: Calendly Discovery

**Slug:** calendly-discovery
**Spec:** docs/specs/calendly-discovery.md

## Files touched

**Created:**
- `scripts/explore_calendly_api.py` — throwaway read-only probe (6 investigation steps; dumps JSON to `.probe-out/calendly/`).

**Modified:** none. No DB / schema / ingestion / Vercel / env changes — pure investigation per spec.

## What I did, in plain English

Six-step probe against the live Calendly API on the AI Partner organization (org URI `https://api.calendly.com/organizations/511cdf9c-e6e9-4473-9671-4275e1010567`, user "Success AP <success@theaipartner.io>"):

1. **Auth + organization URI** via `GET /users/me`.
2. **Event-type catalog** via `GET /event_types?organization=<org_uri>` — reveals how "closer" bookings are likely identified.
3. **Sample 100 recent scheduled events** via `GET /scheduled_events?...&count=100` with `min_start_time = now - 30d, max_start_time = now + 7d`. Capture status distribution, event-type distribution, host distribution, full per-event field shape, and per-event `created_at → start_time` delta math.
4. **Invitee detail** on one event via `GET /scheduled_events/{uuid}/invitees` — surface reschedule/cancel signal fields.
5. **Canceled-events sample** via `GET /scheduled_events?...&status=canceled` — see what fields distinguish canceled from active (cancellation sub-object, lineage).
6. **Webhook subscriptions** via `GET /webhook_subscriptions?...&scope=organization` — plan-tier indicator + see who already has webhooks on this org.

Two operational findings before any code ran:

- **Env var name discrepancy.** Spec said `CALENDLY_API_TOKEN`; actual var in `.env.local` is `CALENDLY_API_KEY` (length 896 — a JWT token). Probe accepts either. The eventual ingestion module should standardize on one name; my lean is `CALENDLY_API_KEY` (matches the existing var; consistent with `CLOSE_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` precedent — all `_KEY`s in this codebase).
- **Cloudflare 1010 / `browser_signature_banned`** on the first request. Calendly sits behind Cloudflare which 403s default `Python-urllib/3.12` User-Agent. Fix: set a normal `User-Agent` header in the client. Documented in the probe + worth carrying forward to any future Calendly client (the existing `ingestion/wistia/client.py` + `ingestion/close/client.py` both work without a custom UA because Wistia and Close don't gate this way — Calendly is the first in this codebase to require it).

## Verification

`python3 scripts/explore_calendly_api.py` exited 0 after the UA fix. 6 JSON files written under `.probe-out/calendly/`.

---

## Findings

### Event-type catalog: 14 active types, "AI Partner Strategy Call" is the closer-call dominant

Full active list (`kind=solo` on every one; durations 15-60m):

| name | duration | uri tail |
|---|---|---|
| 15 Minute Synch | 30m | `pes/3347c1ce...` |
| 30 Minute Meeting (×3 distinct types) | 30m | `pes/{66904fc3, 31b1d7c5, 3d4fb4b3}` |
| 30 Minute Synch | 30m | `pes/691ab422...` |
| 60 Minute Synch | 30m | `pes/679cd7cc...` |
| **AI Partner Onboarding Call** | 30m | `pes/922eeb77...` |
| **AI Partner Qualification** | 45m | `pes/be9a3cfc...` |
| **AI Partner Strategy Call** | 45m | `pes/a596a1b1...` |
| **AI Partner Sync** | 30m | `pes/b93c8961...` |
| **Consultation Call With Aman** | 45m | `pes/2a60ecb8...` |
| Intro Call | 15m | `pes/7468b3a1...` |
| Sales Interview | 30m | `pes/94d1a441...` |
| Scheduled Sets | 15m | `pes/62214f7f...` |

**Dominant closer-candidate: `AI Partner Strategy Call`** (45m). 35 of the 100 sampled events. Aman runs it (65 of his bookings, the highest host count). My lean: this is the canonical "Closer Booking" type — confirm with Drake / Aman.

Possibly also a closer type: `AI Partner Qualification` (45m) — qualification call is often a closer-or-pre-closer touch.

NOT closer: synch / sales-interview / intro / scheduled-sets / onboarding types.

### Sampled events: shape + status distribution

100 events over the last ~30 days, status breakdown: **74 active / 26 canceled** (~26% cancel rate).

Event-type names from the sampled events (top 5):
- `AI Partner Strategy Call` — 35
- `8ce6d7e4-0cda-46fe-8059-8892b68ef205` — 28 (event_type URI uuid; the type ISN'T in the active catalog → probably retired/archived. Use the event's own `name` field for the human-readable label, not the catalog lookup.)
- `8f6795d3-992a-4cbd-b584-9ecaabb3938c` — 16 (same — retired type)
- `bedd670e-8988-43c3-b057-95d96439e072` — 14 (same)
- `Sales Interview` — 7

**Implication:** the `event_type` URI is stable but the catalog only returns currently-active types. Older events may reference retired event_type URIs that no longer exist in the catalog. The event's own `name` field carries the user-visible label at booking time — use that for filtering / display when the catalog lookup misses.

Host distribution:
- Aman Ali — 65 (the closer)
- Connor Malewicz — 23
- Success AP — 7
- Yasmine Manno — 5

### Event shape (verified on the live API)

```
keys: [calendar_event, created_at, end_time, event_guests, event_memberships,
       event_type, invitees_counter, location, meeting_notes_html,
       meeting_notes_plain, name, start_time, status, updated_at, uri]
```

Sample event (trimmed):
```json
{
  "uri":         "https://api.calendly.com/scheduled_events/9495a10b-0c54-...",
  "name":        "Ai Partner Strategy Call",
  "status":      "active",
  "start_time":  "2026-05-25T21:00:00.000000Z",
  "end_time":    "2026-05-25T21:45:00.000000Z",
  "created_at":  "2026-05-24T10:34:53.863549Z",
  "updated_at":  "2026-05-24T10:34:55.758912Z",
  "event_type":  "https://api.calendly.com/event_types/8f6795d3-...",
  "location":    {"location": null, "type": "custom"},
  "invitees_counter": {"active": 1, "limit": 1, "total": 1},
  "event_memberships": [{
    "user":               "https://api.calendly.com/users/...",
    "user_email":         "<host email>",
    "user_name":          "Aman Ali",
    "buffered_start_time": "2026-05-25T21:00:00.000000Z",
    "buffered_end_time":   "2026-05-25T21:45:00.000000Z"
  }]
}
```

All 100 events had BOTH `created_at` and `start_time`. **Date-math feasibility: 100/100** — Next Day / Two Days Out are computable cleanly.

### Date-math samples (real deltas)

Real `created → start` deltas observed on the 10 most recent active events:

| created | start | delta | type |
|---|---|---|---|
| 2026-05-24 | 2026-05-25 | **1d** | Ai Partner Strategy Call |
| 2026-05-24 | 2026-05-25 | **1d** | Ai Partner Strategy Call |
| 2026-05-22 | 2026-05-25 | 3d | Partnership Call w/ Aman |
| 2026-05-23 | 2026-05-25 | **2d** | Ai Partner Strategy Call |
| 2026-05-24 | 2026-05-25 | **1d** | Ai Partner Strategy Call |
| 2026-05-24 | 2026-05-25 | **1d** | Ai Partner Strategy Call |
| 2026-05-24 | 2026-05-25 | **1d** | Ai Partner Strategy Call |
| 2026-05-23 | 2026-05-25 | **2d** | Ai Partner Strategy Call |
| 2026-05-23 | 2026-05-25 | **2d** | Ai Partner Strategy Call |
| 2026-05-23 | 2026-05-24 | **1d** | Ai Partner Strategy Call |

"Next Day" + "Two Days Out" are both genuinely common in the data. Math works.

**Timezone caveat:** the dates above are computed in UTC. The business is in EDT. A booking created at 22:00 UTC on day N starts at 02:00 UTC on day N+1 = midnight EDT day N+1 = "same day" in business tz. For the Engine sheet metrics, the aggregation layer should parse both timestamps in the business timezone (`America/New_York`) before subtracting dates. Same pattern as ADR 0003. Stored values stay UTC; rendering tz is the dashboard's responsibility.

### Invitee detail — reschedule/cancel signals

```
keys: [cancel_url, created_at, email, event, first_name, invitee_scheduled_by,
       last_name, name, new_invitee, no_show, old_invitee, payment,
       questions_and_answers, reconfirmation, reschedule_url, rescheduled,
       routing_form_submission, scheduling_method, status,
       text_reminder_number, timezone, tracking, updated_at, uri]
```

Load-bearing fields:
- **`status`** — active / canceled
- **`rescheduled`** — boolean; `true` when this invitee was created via a reschedule of a prior invitee
- **`old_invitee`** — URI of the prior invitee (lineage; populated when `rescheduled=true`)
- **`new_invitee`** — URI of the replacing invitee on a canceled event that was rescheduled
- **`no_show`** — boolean
- **`timezone`** — the invitee's local tz
- **`cancellation`** sub-object (on canceled events only): `{canceled_by, canceler_type, created_at, reason}`

### Canceled events — distinct field

Canceled events return one extra top-level field vs active: `cancellation` sub-object on the EVENT itself (not just the invitee):
```json
"cancellation": {
  "canceled_by": "Aman Ali",
  "canceler_type": "host",
  "created_at": "2026-05-23T15:24:15.317362Z",
  "reason": ""
}
```

26 of 100 events in window were canceled. The cancellation timestamp is independently tracked.

### Webhook subscriptions: tier supports it, 10 already active

The org has **10 active webhook subscriptions** pointing at Make.com (one disabled for adaudit.io). All subscribed to `invitee.created` and/or `invitee.canceled`. Plan tier supports webhooks → **real-time push ingestion is feasible**, mirroring the Close webhook pattern we shipped.

Existing subscriptions (paraphrased):
- 8 active subscriptions on `invitee.created` + `invitee.canceled` → Make.com
- 1 active on `invitee.created` only → Make.com
- 1 disabled (`invitee_no_show.*` included) → adaudit.io

Adding an 11th subscription for our ingestion endpoint does not disrupt the existing Make.com hooks — Calendly fans out to every subscription.

---

## The 6 Engine-sheet metrics, mapped

### Plain Calendly (rows 93-95)

| # | Metric | Source filter | Grain | Reconstructable historically? |
|---|---|---|---|---|
| 93 | **New Scheduled Meetings** | `event.status = 'active'` AND `invitee.rescheduled = false` | per `invitee.created_at` date | ✅ Yes, via /scheduled_events pagination |
| 94 | **New Rescheduled Meetings** | `event.status = 'active'` AND `invitee.rescheduled = true` AND `invitee.old_invitee IS NOT NULL` | per `invitee.created_at` date | ✅ Yes |
| 95 | **Follow Up Meetings** | **AMBIGUOUS** — see § Surprises | per `invitee.created_at` date | depends on definition |

### "Calendly with logic" (rows 34-36)

| # | Metric | Source filter | Grain | Reconstructable? |
|---|---|---|---|---|
| 34 | **Total Closer Bookings** | `event.name IN (closer-event-type set — likely 'AI Partner Strategy Call' [+ 'AI Partner Qualification'?])` AND `status = 'active'` AND `invitee.rescheduled = false` | per `invitee.created_at` date (in EDT) | ✅ Yes |
| 35 | **Closer Booking Next Day** | (closer filter from #34) AND `start_time.date - created_at.date == 1` (in EDT) | per `created_at` date | ✅ Yes |
| 36 | **Closer Booking Two Days Out** | (closer filter from #34) AND `start_time.date - created_at.date == 2` (in EDT) | per `created_at` date | ✅ Yes |

All six metrics are buildable. Two open questions for Drake before any schema spec:

1. **Which event-type names count as "closer"?** My lean: `AI Partner Strategy Call` alone. Possibly also `AI Partner Qualification`. NOT the 30m synch / intro / onboarding types.
2. **What's a "Follow Up Meeting"?** Calendly doesn't have a distinct concept. Possible interpretations:
   - Any meeting by an invitee email who has had prior bookings (= "this person has already met with us"). Buildable.
   - A specific event-type named "Follow Up" — none exists today; would require Aman/team to create one.
   - The same invitee re-booking the SAME event type within N days.
   The aggregation layer can't pick without a definition.

## Surprises and judgment calls

- **Env var name** is `CALENDLY_API_KEY`, not `CALENDLY_API_TOKEN`. Spec drift. Probe handles both; future ingestion module should standardize on `CALENDLY_API_KEY` (matches the existing var + `CLOSE_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` precedent).

- **Cloudflare 1010 (browser_signature_banned)** on default Python-urllib UA — first time this codebase has hit it. Fix is one header (`User-Agent: ai-enablement/1.0 (+drake@theaipartner.io)`). Documented in the probe. Carry forward to the eventual ingestion client.

- **`event_type` URI vs event `name`.** Event objects carry `event_type` as a URI pointing to the event-type catalog. But ~58 of 100 sampled events had `event_type` URIs that DON'T appear in the active `/event_types` response (retired/archived types). Their `name` field carries the user-visible label at booking time. **Recommendation:** filter "closer bookings" by event `name` (case-insensitive match against the closer-type set) rather than by `event_type` URI alone — the URI-based filter would miss old retired-type bookings that should still count.

- **"Ai Partner Strategy Call"** appears in event names but **"AI Partner Strategy Call"** in the catalog — note the casing difference. Calendly may title-case at booking time. Filter case-insensitively.

- **Date math timezone — recommend business tz (`America/New_York`).** "Next Day" + "Two Days Out" semantics make sense in the business's calendar day, not UTC. Aligns with ADR 0003. The Engine sheet renders by day; book in EDT, count in EDT.

- **The webhook subscription density is high already.** 10 existing subscriptions, mostly Make.com hooks. Adding an 11th for our ingestion is fine (Calendly fans out cleanly), but worth knowing: the existing Make.com automations are LIVE and the team may not realize how many. If we ever want to consolidate, the existing hooks are a known surface to discuss with the team.

- **Cancellation has its own timestamp + canceler attribution.** Useful future-signal: which canceler types (host, invitee, system) dominate, and what's the time-to-cancel distribution. Out of scope for the 6 sheet metrics today, but the data is rich.

- **`no_show` is a Calendly-native field on invitee**, mirroring the Engine sheet's "No Show" metric (currently sourced from a different system per Drake's previous notes). Worth flagging: if Calendly's `no_show` is reliable, we might be able to consolidate. Out of scope for this discovery; mentioning for future spec consideration.

- **Webhooks fire on `invitee.created` + `invitee.canceled`** (and `invitee_no_show.created/.deleted` for the disabled adaudit hook). Reschedules fire as `invitee.created` on the new invitee + `invitee.canceled` on the old — same shape as how the API exposes them. Real-time ingestion will need to handle both events per reschedule.

## Out of scope / deferred

For the eventual ingestion spec (separate Director scope):

- **Mirror schema sketch** (NOT a schema design — input for the next spec to decide):
  - `calendly_event_types` (reference table; ~14 rows; keyed `uri text PK` + name + duration + kind + active flag)
  - `calendly_scheduled_events` (per-event mirror; keyed `uri text PK`; full event JSON in `raw_payload`; denormalize hot fields: `name`, `status`, `start_time`, `end_time`, `created_at`, `updated_at`, `event_type_uri`, `cancellation` jsonb, host info from first event_membership)
  - `calendly_invitees` (per-invitee mirror; keyed `uri text PK`; FK-loose to event; carries `email`, `name`, `status`, `created_at`, `rescheduled`, `old_invitee`, `new_invitee`, `no_show`, `timezone`, `cancel/reschedule URLs`)
- **Live ingestion via webhook subscription** (`invitee.created`, `invitee.canceled`, `invitee_no_show.created/deleted`). Mirror the Close webhook receiver shape (signature verification, audit row, fast 2xx). Calendly signs webhooks with HMAC SHA256 — confirm scheme during ingestion spec design.
- **30-day backfill** on first ship, expandable.
- **Aggregation layer** builds the 6 sheet metrics as views/queries on top.
- **Event-type-name standardization** — case-insensitive matching on a known closer-type list (probably hardcoded in the aggregation layer, since Aman/team rarely add new types).
- **Webhook subscription registration** — Drake's gate (d); helper script similar to `scripts/register_close_webhook.py`.
- **WISTIA/CLOSE/CALENDLY env-var naming convergence** — minor cleanup; standardize on `_API_KEY` across these three sources.

Not in this report (would need a different probe):

- **Plan tier confirmation explicitly** — webhooks work so it's at least Standard; not probed which tier.
- **Group event types** — all 14 active types are `kind=solo`. If the team ever uses group bookings, additional shape decisions needed.
- **Routing form submissions** — `routing_form_submission` field on invitee suggests Calendly supports pre-meeting forms. If the team uses them, that's another data layer worth knowing.

## Side effects

- **Calendly API:** ~7 read-only calls during the probe (1 users/me + 1 event_types + 2 scheduled_events pages + 1 invitees + 1 canceled-events + 1 webhook_subscriptions). Well under any rate limit. No writes.
- **Supabase:** zero reads, zero writes.
- **Slack / external services:** none touched.
- **Local filesystem:** 6 JSON files in `.probe-out/calendly/` (~30 KB total). Git-ignored via the existing `.probe-out/` rule.
- **No `.env.local` modifications.** Token read-only.
- **No Vercel changes**, no env var changes, no cron edits, no code-path changes beyond the new throwaway probe script.
