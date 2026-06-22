# Calendly Discovery
**Slug:** calendly-discovery
**Status:** in-flight
**Target branch:** main

## ⚠️ Landscape note

Close + Meta + Wistia (incl. the timeseries cutover) all live on `main`. Separate Ella worktree on `ella-worktree`. **Stay on `main`.** `git status` + `git log --oneline -10` first; re-read current file state.

## Why this exists

Calendly is the next sales-side source. The Engine sheet has SIX Calendly-sourced rows in two groups:

**Plain "Calendly" (rows 93–95, raw event counts):**
- New Scheduled Meetings
- New Rescheduled Meetings
- Follow Up Meetings

**"Calendly with logic" (rows 34–36, DERIVED — need date math + filtering):**
- Total Closer Bookings
- Closer Booking Next Day
- Closer Booking Two Days Out

**This is discovery ONLY — no schema, no migration, no ingestion module, no UI, no cron.** Output is a throwaway probe script + a findings report. The "with logic" rows are the reason discovery matters: they imply filtering Calendly events to *closer* bookings specifically, plus date math comparing booking-creation-date to meeting-date (next-day = meeting is 1 day after booking, two-days-out = 2 days). We need to confirm the raw Calendly data actually carries what's needed to compute these before designing tables. Drake + Director read the report and decide grain/viability before any ingestion spec.

## Questions discovery must answer with real data

1. **Event shape** — what does a Calendly scheduled event actually return? Fields for: created-at (when booked), start-time (when the meeting is), event type/name, host/assignee, invitee, status (active/canceled), rescheduled flag/lineage.
2. **Closer identification** — how do we distinguish a "closer booking" from other meeting types (setter calls, follow-ups, etc.)? Is it the event-type name, the host/assignee, or something else? The "with logic" rows filter to closer meetings — confirm what field does that.
3. **Date-math feasibility** — are BOTH the booking-creation timestamp AND the meeting start-time present on each event? (Needed for next-day / two-days-out: meeting_date − booking_date.) Confirm the timezone handling so "next day" is computed in the right tz (the business's, not UTC).
4. **Rescheduled vs new vs follow-up** — how does Calendly represent a reschedule (a status, a new event linked to an old one, a `rescheduled` boolean)? And what makes a meeting a "follow up" vs "new scheduled"? This distinguishes rows 93/94/95.
5. **Historical access** — can we pull historical events (for backfill), and how far back? What's the pagination + rate limit?

## Auth + API context (verify against current docs + live API)

- **Token:** `CALENDLY_API_TOKEN` in `.env.local` (Drake confirms present). Bearer auth: `Authorization: Bearer <token>`. Confirm a cheap call works before anything; **hard stop** if missing/misnamed/401.
- **Auth quirks (from earlier research — verify):**
  - No list-all-users endpoint — call `GET /users/me` FIRST to get the current user + the **organization URI**, then enumerate from there.
  - Resource IDs in requests are full URIs (e.g. `https://api.calendly.com/event_types/AAAA`), NOT bare UUIDs — a bare UUID 404s.
  - Rate limit ~60 req/min (lower plans) / 120 (Enterprise), 429 with Retry-After.
  - Webhooks require a premium-and-above plan — NOTE whether the account tier supports webhooks (affects whether eventual ingestion can be real-time push vs polling). Don't set one up; just report tier capability.
- **Base URL:** `https://api.calendly.com`. Use `urllib`, no SDK dep (matches `ingestion/close/client.py`, `ingestion/meta/sheets_client.py`).
- **Key endpoints (confirm current shapes):**
  - `GET /users/me` → current user + organization URI.
  - `GET /scheduled_events?organization=<org_uri>&...` → list scheduled events (filterable by date range, status, invitee). Paginated. This is the core data.
  - `GET /scheduled_events/{uuid}/invitees` → invitee details if needed (who booked).
  - `GET /event_types?organization=<org_uri>` → the event-type catalog (likely how "closer" vs other meetings are distinguished — there may be a named event type for closer calls).
  - Investigate how reschedules + cancellations appear (status field, `old_invitee`, rescheduled linkage).

## The investigation

Probe script `scripts/explore_calendly_api.py` (throwaway, dumps to git-ignored `.probe-out/calendly/`), read-only:

1. **Auth + org** — `GET /users/me`, capture user URI + org URI. Hard stop on 401.
2. **Event-type catalog** — list event types; surface names + URIs. This likely reveals how "closer bookings" are identified (a named type). Show the full list so Drake can point at which type(s) = closer meetings.
3. **Sample real scheduled events** — pull ~30–50 recent events over a date range. For each, capture the full shape: created_at, start_time, end_time, event-type name/uri, host/assignee, status, invitee count, any reschedule/cancel indicators. Paste 2–3 trimmed real examples.
4. **Answer the 6 sheet metrics** — map each (3 plain + 3 with-logic) to: the field(s)/filter that produces it, the grain (per-day), and historical-reconstructability. Specifically nail:
   - "Closer Bookings" → which event-type/host filter.
   - "Next Day" / "Two Days Out" → confirm created_at + start_time both present, and the date-diff logic works (with tz).
   - "New Scheduled" vs "Rescheduled" vs "Follow Up" → what distinguishes them in the data.
5. **Backfill + real-time feasibility** — how far back can we pull; what's the pagination; does the plan tier support webhooks (for live ingestion) or are we polling?

## What success looks like

Findings report at `docs/reports/calendly-discovery.md` (six-section structure):
- Event shape with real examples.
- How closer bookings are identified (the field/filter).
- Confirmation the next-day / two-days-out date math is feasible (both timestamps present + tz approach).
- How new/rescheduled/follow-up are distinguished.
- All 6 metrics mapped to raw source + grain + historical-reconstructability.
- Backfill depth + real-time capability (webhook tier vs polling) — a recommendation on the eventual ingestion shape (likely: mirror scheduled_events into a table, compute the 6 metrics + the with-logic ones via SQL/date-math on top; webhook if tier allows else polling cron).
- Framed as input to Director's call, not a settled schema.

Concrete acceptance: auth worked; org URI captured; event-type catalog listed; ≥30 real events sampled with full shape pasted; the 6 metrics mapped; the closer-identification + date-math questions answered definitively; webhook-vs-poll determined by plan tier.

## Hard stops

- `CALENDLY_API_TOKEN` missing/misnamed or unrecoverable 401/403 → stop + report.
- Repeated 429s → back off (respect Retry-After), report partial.
- Anything that writes to Calendly (creating events, webhooks, event types) → never. Read-only reconnaissance.
- No Supabase writes, no migrations, no env/Vercel changes. Local token read-only, never echoed into logs/report/commits.

## Think this through

"Closer bookings" might not map to a clean single event-type (could be multiple types, or distinguished by host rather than type — surface what's actually there). Next-day/two-days-out tz: "next day" in whose timezone — the business's, the invitee's? (Lean business tz; confirm what's available.) Reschedules might create a new event + cancel the old (double-counting risk — note how to dedup). Follow-up meetings might be a distinct event type or just repeat bookings by the same invitee (ambiguous — report what distinguishes them, flag if unclear). Cancellations — do we count a booking that was later canceled? (Report the status field so the eventual logic can decide.) Historical depth might be limited on lower plans. Surface all honestly — a discovery that finds "the with-logic rows need a definition decision from the sheet author" is a successful discovery.

## Mandatory doc updates

- The report at `docs/reports/calendly-discovery.md`.
- No CLAUDE.md / state.md / schema-doc edits (nothing shipped). Anything for a future entry → note in the report's "Out of scope / deferred."
