"""Typeform ingestion module — mirror Typeform forms + responses to Supabase.

Public surface:
    from ingestion.typeform.client import TypeformClient, TypeformAPIError
    from ingestion.typeform.parser import parse_form_definition, parse_response
    from ingestion.typeform.pipeline import (
        SyncOutcome,
        sync_form_definition,
        sync_all_form_definitions,
        sync_responses,
        sync_all_responses,
        upsert_response_from_webhook,
    )

See docs/specs/typeform-ingestion.md + docs/runbooks/typeform_ingestion.md.
"""
