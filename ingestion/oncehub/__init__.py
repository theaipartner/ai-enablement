"""OnceHub ingestion adapter.

Mirrors OnceHub v2 bookings into `public.oncehub_bookings` (core principle #3:
external tools are replaceable adapters — the dashboard / future booking_cycles
spine read OUR table, never api.oncehub.com). Webhook-primary (real-time) +
API backstop, the same shape as every other source under `ingestion/`.

Modules:
  - parser.py    — normalize a v2 booking object -> oncehub_bookings row.
  - client.py    — thin OnceHub v2 REST client (API-Key auth).
  - pipeline.py  — upsert helpers (webhook + backfill).
"""
