"""Parse Close API JSON payloads → internal records for upsert.

Two responsibilities:

1. **Field projection** — pull the typed columns we mirror from the
   raw Close JSON. Funnel-relevant lead custom fields are denormalized
   by `_CF_NAME_TO_COLUMN`; everything else lands in `custom_fields_raw`.

2. **Tier derivation** — apply Drake's confirmed business logic
   (≥ $2k disposable income → tier_1) to the `investment` cf, write
   the result to `close_leads.tier`. Conservative on unknowns (leaves
   tier null rather than guessing).

Money cf values (`amount_of_Nth_payment?`) are passed through as text —
the source is text-typed and may carry dirt (e.g. `'$1,133'`). The
aggregation layer does numeric coercion at read time so we preserve
audit-original values here.
"""

from __future__ import annotations

import re
from typing import Any

# Map Close custom-field NAMES (as set in the Close UI) → close_leads
# column. The lookup is by name, not by cf_* id, because field IDs are
# org-specific and an org admin could recreate the field with a new ID
# while keeping the same name. Resolving by name keeps the mirror
# resilient to that.
#
# Names match what surfaced in the inventory probe — see
# .probe-out/close-data/05_custom_field_inventory.json (when present)
# or docs/reports/close-full-data-inventory.md § Layer B/C tables.
_CF_NAME_TO_COLUMN: dict[str, str] = {
    # Attribution
    "utm medium": "utm_medium",
    "utm campaign": "utm_campaign",
    "utm term": "utm_term",
    "Source": "source",
    "Funnel Name": "funnel_name",
    "Funnel Type": "funnel_type",
    "Ad Name": "ad_name",
    "ad_id": "ad_id",
    "adset_id": "adset_id",
    "campaign_id": "campaign_id",
    # Opt-in lifecycle
    "Date First opted in": "date_first_opted_in",
    "Latest Opt-In Date": "latest_opt_in_date",
    "Number of opt ins": "number_of_opt_ins",
    # Qualification
    "Investment": "investment",
    "Monthly Income": "monthly_income",
    "Marketing Qualified": "marketing_qualified",
    "Overnight Lead": "overnight_lead",
    # Booking lifecycle
    "Date of First Booked Call": "date_of_first_booked_call",
    "Latest Date of Booked Call": "latest_date_of_booked_call",
    "Date Call Scheduled For": "date_call_scheduled_for",
    "Direct Call Booked?": "direct_call_booked",
    "Confirmed Booking": "confirmed_booking",
    "Call Connected": "call_connected",
    "Date first connected": "date_first_connected",
    "Showed?": "showed",
    "Triage Showed": "triage_showed",
    # Ownership
    "Closer Owner": "closer_owner_id",
    "Setter Owner": "setter_owner_id",
    # Cancellation
    "No Show / Cancellation?": "no_show_or_cancellation",
    "No Show / Cancellation Date": "no_show_or_cancellation_date",
    "Number of reschedules": "number_of_reschedules",
    # Closing / payment
    "Type of Payment On Call": "type_of_payment_on_call",
    "Date Contract Sent": "date_contract_sent",
    "Contract Sent?": "contract_sent",
    "Closed?": "closed",
    "Lost Deal?": "lost_deal",
    "Date closed": "date_closed",
    "Payment Plan Type?": "payment_plan_type",
    "Total monthly-creative payments?": "total_monthly_creative_payments",
    "Amount of 1st payment?": "amount_of_1st_payment",
    "Amount of 2nd payment?": "amount_of_2nd_payment",
    "Amount of 3rd payment?": "amount_of_3rd_payment",
    "Amount of 4th payment?": "amount_of_4th_payment",
    "Amount of 5th payment?": "amount_of_5th_payment",
    "Date of 1st payment?": "date_of_1st_payment",
    "Date of 2nd payment?": "date_of_2nd_payment",
    "Date of 3rd payment?": "date_of_3rd_payment",
    "Date of 4th payment?": "date_of_4th_payment",
    "Date of 5th payment?": "date_of_5th_payment",
    # Cross-system
    "Airtable Student Record ID": "airtable_student_record_id",
}

# Columns that need integer coercion (custom-field source is loose).
_INT_COLUMNS = {"number_of_opt_ins", "number_of_reschedules"}


def _coerce_int(val: Any) -> int | None:
    if val is None or val == "":
        return None
    if isinstance(val, int):
        return val
    if isinstance(val, str):
        # Strip thousand-separators and currency markers conservatively;
        # if the result isn't a clean int, return None.
        cleaned = val.strip().replace(",", "").replace("$", "")
        try:
            return int(float(cleaned))
        except (ValueError, TypeError):
            return None
    return None


def derive_tier(investment_value: str | None) -> str | None:
    """Drake's confirmed Tier split: ≥ $2k disposable → tier_1, < $2k → tier_2.

    The `investment` cf carries Typeform output strings like
    `'Under $2,000'`, `'$2,000 - $5,000'`, etc. Real values aren't
    exhaustively known; rule:

      - Contains 'under' + a value at or below $2k → tier_2
      - Contains a $ amount and the lowest visible amount ≥ $2k → tier_1
      - Empty / unrecognized → None (don't guess)
    """
    if not investment_value:
        return None
    raw = investment_value.strip()
    lowered = raw.lower()

    # Pull out every dollar amount (e.g. "$2,000" → 2000).
    amounts = []
    for match in re.finditer(r"\$([0-9,]+)", raw):
        try:
            amounts.append(int(match.group(1).replace(",", "")))
        except ValueError:
            continue

    if not amounts:
        return None

    # "Under $X" → tier_2 if X ≤ 2000, else tier_1 (the ceiling is what
    # qualifies). "Under $5,000" means "anything below $5k" which
    # *includes* unqualified leads, but the Typeform bucket name treats
    # this as "this lead has under $5k" — so the *ceiling* is what
    # qualifies. ≤ 2k ceiling → tier_2; > 2k ceiling → tier_1.
    if "under" in lowered:
        return "tier_2" if amounts[0] <= 2000 else "tier_1"

    # "$2,000 - $5,000" or "$5k+" patterns: the lowest amount is the
    # floor. Floor ≥ 2000 → tier_1; floor < 2000 → tier_2.
    floor = min(amounts)
    if floor >= 2000:
        return "tier_1"
    return "tier_2"


def parse_lead(lead_json: dict[str, Any]) -> dict[str, Any]:
    """Project a Close /lead/ JSON into a close_leads row dict.

    Output keys match `close_leads` table columns. Caller passes the
    dict to supabase-py upsert.
    """
    row: dict[str, Any] = {
        "close_id": lead_json.get("id"),
        "display_name": lead_json.get("display_name"),
        "description": lead_json.get("description"),
        "url": lead_json.get("url"),
        "status_id": lead_json.get("status_id"),
        "status_label": lead_json.get("status_label"),
        "contacts": lead_json.get("contacts") or [],
        "addresses": lead_json.get("addresses") or [],
        "created_by": lead_json.get("created_by"),
        "updated_by": lead_json.get("updated_by"),
        "date_created": lead_json.get("date_created"),
        "date_updated": lead_json.get("date_updated"),
        # utm_source isn't always a Close cf — some orgs use "Source"
        # only. Try both.
        "utm_source": None,
        "raw_payload": lead_json,
        "custom_fields_raw": {},
    }

    cf_raw: dict[str, Any] = {}
    # Build a name-lookup over the cf_* defs the lead carries. The lead
    # JSON has both:
    #   - top-level `custom.cf_xxxxx` keys (raw values)
    #   - sometimes a `custom` dict (newer endpoints) keyed by name
    # We accept either; prefer the dotted-cf keys because they always
    # carry the cf_id (stable across renames) which the catch-all jsonb
    # uses.
    cf_id_to_value: dict[str, Any] = {}
    for key, val in lead_json.items():
        if key.startswith("custom.cf_"):
            cf_id = key.split(".", 1)[1]
            cf_id_to_value[cf_id] = val
            cf_raw[cf_id] = val

    row["custom_fields_raw"] = cf_raw

    # Resolve cf names → columns via the cf_* metadata that the get_lead
    # endpoint includes (`custom` dict where keyed by name on some
    # endpoints; otherwise we project from cf_id_to_value via a name
    # map the caller has to provide).
    #
    # For the V1 pipeline we project by NAME using the schema we fetch
    # separately. Caller passes the cf-id-to-name map; if absent, the
    # denormalized columns stay null and the catch-all jsonb has the
    # full data. That's the safe failure mode.
    return row


def project_cf_columns(
    row: dict[str, Any],
    cf_id_to_name: dict[str, str],
) -> dict[str, Any]:
    """Pour cf values into typed columns based on the name → column map.

    Mutates `row` in place AND returns it. Pulls from
    `row['custom_fields_raw']` (already populated by `parse_lead`) and
    cross-references each cf_id against `cf_id_to_name` then against
    `_CF_NAME_TO_COLUMN`.

    Derives `tier` from `investment` per Drake's logic.
    """
    cf_raw = row.get("custom_fields_raw") or {}
    for cf_id, val in cf_raw.items():
        name = cf_id_to_name.get(cf_id)
        if not name:
            continue
        col = _CF_NAME_TO_COLUMN.get(name)
        if not col:
            continue
        if col in _INT_COLUMNS:
            row[col] = _coerce_int(val)
        else:
            row[col] = val
    # Tier derivation (always re-run; cheap, idempotent).
    row["tier"] = derive_tier(row.get("investment"))
    return row


def parse_lead_status_change(activity_json: dict[str, Any]) -> dict[str, Any]:
    """Project a LeadStatusChange activity into a close_lead_status_changes row.

    Filters to LeadStatusChange only; caller passes the activity payload.
    """
    return {
        "close_id": activity_json.get("id"),
        "lead_id": activity_json.get("lead_id"),
        "old_status_id": activity_json.get("old_status_id"),
        "old_status_label": activity_json.get("old_status_label"),
        "new_status_id": activity_json.get("new_status_id"),
        "new_status_label": activity_json.get("new_status_label"),
        "user_id": activity_json.get("user_id"),
        "date_created": activity_json.get("date_created"),
        "raw_payload": activity_json,
    }


def parse_call(activity_json: dict[str, Any]) -> dict[str, Any]:
    """Project a Call activity into a close_calls row."""
    return {
        "close_id": activity_json.get("id"),
        "lead_id": activity_json.get("lead_id"),
        "contact_id": activity_json.get("contact_id"),
        "user_id": activity_json.get("user_id"),
        "direction": activity_json.get("direction"),
        "status": activity_json.get("status"),
        "duration": activity_json.get("duration"),
        "disposition": activity_json.get("disposition"),
        "voicemail_url": activity_json.get("voicemail_url"),
        "recording_url": activity_json.get("recording_url"),
        "phone": activity_json.get("phone"),
        "local_phone": activity_json.get("local_phone"),
        "remote_phone": activity_json.get("remote_phone"),
        "note": activity_json.get("note"),
        "dialer_id": activity_json.get("dialer_id"),
        "source": activity_json.get("source"),
        "date_created": activity_json.get("date_created"),
        "activity_at": activity_json.get("activity_at"),
        "raw_payload": activity_json,
    }


def parse_sms(activity_json: dict[str, Any]) -> dict[str, Any]:
    """Project an SMS activity into a close_sms row."""
    return {
        "close_id": activity_json.get("id"),
        "lead_id": activity_json.get("lead_id"),
        "contact_id": activity_json.get("contact_id"),
        "user_id": activity_json.get("user_id"),
        "direction": activity_json.get("direction"),
        "status": activity_json.get("status"),
        "text": activity_json.get("text"),
        "local_phone": activity_json.get("local_phone"),
        "remote_phone": activity_json.get("remote_phone"),
        "date_created": activity_json.get("date_created"),
        "date_sent": activity_json.get("date_sent"),
        "activity_at": activity_json.get("activity_at"),
        "raw_payload": activity_json,
    }


def parse_opportunity(opp_json: dict[str, Any]) -> dict[str, Any]:
    """Project an Opportunity into a close_opportunities row."""
    return {
        "close_id": opp_json.get("id"),
        "lead_id": opp_json.get("lead_id"),
        "status_id": opp_json.get("status_id"),
        "status_label": opp_json.get("status_label"),
        "status_type": opp_json.get("status_type"),
        "value": opp_json.get("value"),
        "value_currency": opp_json.get("value_currency"),
        "value_period": opp_json.get("value_period"),
        "value_formatted": opp_json.get("value_formatted"),
        "annualized_value": opp_json.get("annualized_value"),
        "expected_value": opp_json.get("expected_value"),
        "note": opp_json.get("note"),
        "user_id": opp_json.get("user_id"),
        "contact_id": opp_json.get("contact_id"),
        "created_by": opp_json.get("created_by"),
        "updated_by": opp_json.get("updated_by"),
        "date_created": opp_json.get("date_created"),
        "date_updated": opp_json.get("date_updated"),
        "date_won": opp_json.get("date_won"),
        "date_lost": opp_json.get("date_lost"),
        "confidence": opp_json.get("confidence"),
        "raw_payload": opp_json,
    }


def parse_custom_field_definition(
    cf_json: dict[str, Any],
    object_type: str,
) -> dict[str, Any]:
    """Project a custom_field_schema entry into close_custom_field_definitions."""
    return {
        "close_id": cf_json.get("id"),
        "object_type": object_type,
        "name": cf_json.get("name"),
        "type": cf_json.get("type"),
        "choices": cf_json.get("choices"),
        "accepts_multiple_values": cf_json.get("accepts_multiple_values"),
        "is_shared": cf_json.get("is_shared"),
        "description": cf_json.get("description"),
    }
