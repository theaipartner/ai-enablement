"""GoHighLevel (GHL) ingestion — read-only mirror of the GHL sub-account.

Mirrors GHL contacts + conversations + messages (SMS & calls) into Supabase
(`ghl_contacts`, `ghl_conversations`, `ghl_messages`), the GHL counterpart of the
Close mirror. The outbound funnel reads our mirror, never GHL directly.

See `docs/runbooks/ghl_ingestion.md`.
"""
