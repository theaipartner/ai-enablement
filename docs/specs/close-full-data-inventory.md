# Close CRM Full Data Inventory
**Slug:** close-full-data-inventory
**Status:** in-flight

## Why this exists

Follow-up to `close-smartview-discovery`. That pass read Close's *structure* (statuses, custom-field definitions, activity types) but did NOT pull real populated data, so we don't know which custom fields actually carry values or whether dials/emails really flow through Close. Nabeel has now confirmed (in person, 2026-05-23) that the appointment-setting metrics ARE in Close and that dialing/activity is real — so we are NOT building Smartviews as a data source. We read Close's raw objects directly and will build our own filters/aggregations inside Gregory.

**This is still discovery — no schema, no migration, no ingestion module, no UI.** Goal: a definitive map of every Engine-sheet metric we can source from Close, grounded in REAL data (not structure alone), so the next spec (ingestion data model) is written against reality. Output is a probe script + findings report only.

The Engine-sheet sections to test against: APPOINTMENT SETTING (~33 rows — the primary target), CLOSING (~23 rows — test which meeting-outcome/dollar fields live in Close vs Closer EOC Forms), and flag anything from SALES DATA / BACK END REV that unexpectedly turns out to be in Close. Ignore ADVERTISING / CONTENT / FUNNELS (those are Meta/Typeform/Calendly/analytics — separate sources) and FULFILLMENT (already in Gregory).

## Context Builder needs

- Read the prior report `docs/reports/close-smartview-discovery.md` first — it has verified endpoint paths, the 11-status pipeline, the 5 referenced custom-field IDs, and the auth detail. Don't re-derive what's already there.
- Auth: `CLOSE_API_KEY` in `.env.local`, HTTP Basic, key-as-username + empty-password (trailing colon). Confirm `GET /me/` 200 first; **hard stop** if the key is missing/misnamed or auth 401s in a way the trailing-colon detail doesn't fix.
- Probe script: extend or sit beside `scripts/explore_close_api.py`. Dumps to the git-ignored `.probe-out/close/`. Read-only — never POST/PUT to Close, never write Supabase.
- The Engine-sheet metric list lives in the CSV Drake provided; the appointment-setting + closing rows are enumerated in chat history. If Builder doesn't have the exact row list, work from the lead-status pipeline + activity types and map what's derivable; flag any metric you can't place.

## The investigation

1. **Pull real populated data.** ~20-30 real leads spanning the funnel (some new opt-ins, some booked, some clients, some no-shows, some DQ'd — use the status IDs from the prior report). For each, pull the FULL object incl. populated custom-field values AND the full activity timeline (`GET /api/v1/activity/?lead_id=...` or the per-type endpoints). Don't over-pull — 20-30 leads is enough; respect 429s.
2. **Classify what activity data actually exists and how densely.** The load-bearing question: are `Call` activities real and populated (direction, user_id, duration, timestamp)? Are `Email` activities real? Or is Close mostly holding lead records + status changes with thin activity? Report counts — e.g. "of 25 leads, X have call activities, median Y calls each." This determines whether dial-count metrics are buildable.
3. **Inventory which of the 88 lead custom fields actually carry values** on real leads (definitions alone don't tell us usage). Surface the ones relevant to Engine-sheet metrics — especially the Tier 1/Tier 2 split, deposit/cash fields, funnel/source attribution, booking flags. Give field ID + name + type + a sample real value.
4. **Check opportunities for real dollar data.** Pull real `Opportunity` rows — do they carry deal value / cash amounts, or are they empty? This decides whether ANY of the closing-funnel money (deposits, cash collected, contracted revenue) is in Close vs entirely Closer EOC Forms. Be concrete — paste a trimmed real opportunity.
5. **Map EVERY appointment-setting + closing Engine-sheet metric** to one of: (a) directly buildable from Close raw data — name the object/activity/field + grain + historical-reconstructability; (b) partially buildable — say what's missing; (c) not in Close — name where it likely lives (EOC Forms / Calendly / Meta). This full map is the primary deliverable.
6. **Note the activity/status-change history depth** — how far back does Close retain status-change + call + email activity (for the backfill scope in the next spec)? Custom-field-value history is ~30 days via Event Log per the prior report; confirm.

## What success looks like

Findings report at `docs/reports/close-full-data-inventory.md` (six-section structure) containing:
- A complete metric-by-metric map (every appointment-setting + closing row → buildable / partial / not-in-Close, with the raw source named).
- Real evidence on activity density (call/email counts on actual leads).
- Which custom fields actually carry data, with sample values + IDs.
- Whether opportunities hold real dollar figures.
- History-depth note for backfill scoping.
- A headline count: "X of the ~33 appointment-setting metrics buildable from Close, Y partial, Z not in Close" — same for closing.

Frame conclusions as input to Director's call on the ingestion data model, not a settled schema.

## Hard stops

- `CLOSE_API_KEY` missing/misnamed, or unrecoverable 401/403 → stop + report.
- Anything that writes to Close → never.
- Repeated 429s → back off, report partial.
- No Supabase writes, no migrations, no env/Vercel changes. Local key read-only, never echoed into logs/report/commits.

## Think this through — what could go wrong

What if call/email activity is sparse because the team dials through a separate tool and only logs status in Close (despite Nabeel's confirmation)? What if the Tier split lives in a field that's only ~30 days reconstructable? What if opportunities are empty and ALL money is EOC Forms? Surface honestly — a discovery that narrows what Close can do is still a success.

## Mandatory doc updates

- The report at `docs/reports/close-full-data-inventory.md`.
- No CLAUDE.md / state.md / schema-doc edits (nothing shipped). Anything that should become a future entry → note in the report's "Out of scope / deferred."
