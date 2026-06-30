# oncehub_bookings — DEPRECATED (OnceHub removed 2026-06-22)

Raw mirror of OnceHub v2 bookings (migration `0092_oncehub_bookings.sql`). **The OnceHub
integration was removed — we're not going with OnceHub.** Nothing reads or writes this
table anymore; the ingestion, read layer, and tagger wiring are all deleted.

The table is **left in place but inert** (dropping it is a separate, destructive step). It
may be dropped later. A registered OnceHub webhook (`WHK-9JXMFZKAH5`) and the
`ONCEHUB_WEBHOOK_SECRET` Vercel var may still exist on the provider side and can be
deactivated.

Calendly is the scheduling platform; the booking→close linkage is handled by read-time
reconstruction (`lib/db/funnel-closing.ts`) + `lead_cycles` — see `docs/sales/logic.md`
§ Booking → lead matching.
