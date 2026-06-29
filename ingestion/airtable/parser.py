"""Pure projection from Airtable record shape → mirror row dicts.

Each parser takes one Airtable record (`{id, createdTime, fields: {...}}`)
and returns a row dict matching the corresponding mirror table's column
set. The COMPLETE `fields{}` dict is preserved in `fields_raw` regardless
of whether each individual field is promoted to a typed column — so the
dashboard can read any field, including the five aggregation-layer-
pending ambiguities, without a schema migration.

Key behaviors:
  * Empty Airtable fields are OMITTED from the record's `fields{}` by
    Airtable's API. So `record["fields"].get("Closed?")` correctly
    returns None for an unanswered field — no special handling needed.
  * `multipleRecordLinks` → `list[str]` of `recXXX` ids.
  * `multipleLookupValues` → `list[str]` of display strings.
  * `currency` and `number` → numeric.
  * `singleSelect` → str (the choice name).
  * `checkbox` → boolean.
  * `dateTime` → ISO 8601 str (already in that format from Airtable).
  * `date` → ISO date str (e.g. "2026-05-23").
  * `multilineText` and `singleLineText` → str.
  * `formula` → whatever the formula result type is — pass through.

Cast helpers are defensive: bad/missing values become None, never raise.
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger("ai_enablement.airtable.parser")


# ---------------------------------------------------------------------------
# Cast helpers — defensive, return None on any failure
# ---------------------------------------------------------------------------


def _to_str(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, str):
        return v or None
    return str(v)


# Close lead ids are `lead_<alnum>`. Setters sometimes paste the full Close
# lead URL (https://app.close.com/lead/lead_XXX/) into the form's Lead ID field
# instead of the bare id, which then matches nothing downstream. Extract the
# bare `lead_*` token. (SARRA paste error, 2026-05-31.)
_LEAD_ID_RE = re.compile(r"lead_[A-Za-z0-9]+")


def _to_lead_id(v: Any) -> str | None:
    s = _to_str(v)
    if s is None:
        return None
    m = _LEAD_ID_RE.search(s)
    return m.group(0) if m else s


def _to_bool(v: Any) -> bool | None:
    """Airtable checkbox returns True/False (or omits the key). Defensive
    against str 'true'/'false' too, in case a webhook payload encodes
    differently."""
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        s = v.strip().lower()
        if s in ("true", "yes", "1"):
            return True
        if s in ("false", "no", "0"):
            return False
        return None
    if isinstance(v, (int, float)):
        return bool(v)
    return None


def _to_numeric(v: Any) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, str):
        s = v.strip().replace(",", "")
        if not s:
            return None
        try:
            return float(s)
        except ValueError:
            return None
    return None


def _to_str_array(v: Any) -> list[str] | None:
    """Airtable's multipleRecordLinks / multipleLookupValues / multipleSelects
    return lists. Defensive against scalar str (collapse to single-element)."""
    if v is None:
        return None
    if isinstance(v, list):
        out = [str(x) for x in v if x is not None]
        return out or None
    if isinstance(v, str):
        return [v] if v else None
    return None


def _to_iso_dt(v: Any) -> str | None:
    """Pass-through for dateTime ISO strings. Returns None on empty."""
    s = _to_str(v)
    return s if s else None


def _to_iso_date(v: Any) -> str | None:
    """Pass-through for date strings (YYYY-MM-DD). Returns None on empty."""
    s = _to_str(v)
    return s if s else None


# ---------------------------------------------------------------------------
# Sales Team Member parser — feeds the verify-page candidate mirror
# ---------------------------------------------------------------------------


def parse_sales_team_member(record: dict[str, Any]) -> dict[str, Any] | None:
    """Map one Airtable "Sales Team Member" record to a sales_rep_candidates row.

    The record id is the `rec*` value that team_members.airtable_user_id holds.
    The table carries no email / Close id / Calendly — only name, Job Title, and
    Active — so the verify page resolves the rest. `createdTime` (record metadata,
    not a field) drives the forward-only cutoff.
    """
    record_id = record.get("id")
    if not record_id:
        return None
    fields = record.get("fields", {})
    return {
        "airtable_record_id": record_id,
        "full_name": _to_str(fields.get("Name")),
        "first_name": _to_str(fields.get("First Name")),
        "last_name": _to_str(fields.get("Last Name")),
        "job_title": _to_str(fields.get("Job Title")),
        "is_active": _to_bool(fields.get("Active")),
        "airtable_created_at": _to_iso_dt(record.get("createdTime")),
    }


# ---------------------------------------------------------------------------
# Rep EOD parser (Setter EOD's + Closer EOD's -> airtable_rep_eods)
# ---------------------------------------------------------------------------


def parse_rep_eod(record: dict[str, Any], kind: str) -> dict[str, Any] | None:
    """Map one Setter/Closer EOD record to an airtable_rep_eods row.

    `kind` is 'setter' or 'closer' (the table it came from). The rep link is
    "Sales Person" (setter) / "Closer" (closer) — a Sales Team Member rec id
    that equals team_members.airtable_user_id. The date is "Date" (setter) /
    "Submitted At" (closer). The full field set is preserved in fields_raw so the
    dashboard can render whatever the (evolving) form contains.
    """
    record_id = record.get("id")
    if not record_id:
        return None
    fields = record.get("fields") or {}
    link = fields.get("Sales Person") if kind == "setter" else fields.get("Closer")
    rep_record_id = link[0] if isinstance(link, list) and link else None
    date = fields.get("Date") if kind == "setter" else fields.get("Submitted At")
    return {
        "record_id": record_id,
        "kind": kind,
        "rep_record_id": rep_record_id,
        "eod_date": _to_iso_date(date),
        "airtable_created_at": record.get("createdTime"),
        "fields_raw": fields,
    }


# ---------------------------------------------------------------------------
# Setter Triage Calls parser
# ---------------------------------------------------------------------------


def parse_setter_triage(record: dict[str, Any]) -> dict[str, Any] | None:
    """Map one Airtable record from tblaoMsiE3FSkHjQt to a row dict for
    airtable_setter_triage_calls.

    Returns None if the record is unparseable (missing id) — caller
    treats as a parse failure and continues."""
    record_id = record.get("id")
    if not record_id:
        return None

    fields = record.get("fields") or {}
    created_time = record.get("createdTime")

    return {
        "record_id": record_id,
        "airtable_created_at": created_time,
        "lead_id": _to_lead_id(fields.get("Lead ID")),
        "prospect_name": _to_str(fields.get("Prospect Name")),
        "outcome": _to_str(fields.get("Outcome")),
        # CURRENT disposition (form redesign ~2026-05-26): ONE form with
        # a Form Type discriminator + a shared Call Status outcome.
        "form_type": _to_str(fields.get("Form Type")),
        "call_status": _to_str(fields.get("Call Status")),
        # Legacy fields, no longer populated on the Airtable side after
        # the 2026-05-26 redesign (kept for pre-redesign rows): the older
        # single Booking Status, and the 2026-05-27 Setter/Closer Status
        # split that Call Status now supersedes.
        "booking_status": _to_str(fields.get("Booking Status")),
        "setter_status": _to_str(fields.get("Setter Status")),
        "closer_status": _to_str(fields.get("Closer Status")),
        "showed_pct": _to_bool(fields.get("Showed %")),
        "no_show_pct": _to_bool(fields.get("No Show %")),
        "booked_with_closer": _to_bool(fields.get("Booked with Closer?")),
        "setter_record_ids": _to_str_array(fields.get("Setter Name")),
        "setter_names": _to_str_array(fields.get("Name (from Setter Name)")),
        "event_date_time": _to_iso_dt(fields.get("Event Date & Time")),
        "confirmed_call_date_time": _to_iso_dt(
            fields.get("Confirmed Call Date&Time"),
        ),
        "booked_at": _to_iso_dt(fields.get("Booked At")),
        "submitted_at": _to_iso_date(fields.get("Submitted At")),
        "notes": _to_str(fields.get("Notes")),
        "fields_raw": fields,
    }


# ---------------------------------------------------------------------------
# Full Closer Report parser (US + AUS unioned via region)
# ---------------------------------------------------------------------------


def parse_full_closer(
    record: dict[str, Any],
    *,
    region: str,
) -> dict[str, Any] | None:
    """Map one Airtable record from tblYsh3fxTpXuPdIW (US) or
    tblcC25y6lMrtgcty (AUS) to a row dict for airtable_full_closer_report.

    `region` is the discriminator column value ('US' or 'AUS') — supplied
    by the caller based on which Airtable table the record came from.
    The field NAMES are ~identical across US/AUS; AUS-only fields land
    in fields_raw via the catch-all (no typed-column promotion).

    Returns None on missing id."""
    record_id = record.get("id")
    if not record_id:
        return None
    if region not in ("US", "AUS"):
        # Defensive — caller is supposed to pin region per source table.
        # An unknown region is a bug, not an upsert-as-NULL case.
        raise ValueError(
            f"parse_full_closer requires region 'US'|'AUS', got {region!r}"
        )

    fields = record.get("fields") or {}
    created_time = record.get("createdTime")

    # Provisional is_setter_led derivation per spec — populated
    # setter_record_ids = setter-led, empty = direct-booking-led.
    # Hypothesis UNCONFIRMED (Setter Name was empty on all 3 discovery
    # samples). Stored as None when there's no signal at all (avoids
    # false False).
    setter_ids = _to_str_array(fields.get("Setter Name"))
    if setter_ids is None:
        # No Setter Name field present at all on this record. Mark
        # is_setter_led as None — we can't distinguish "no setter" from
        # "field genuinely absent" without the fill-rate study.
        is_setter_led: bool | None = None
    else:
        is_setter_led = len(setter_ids) > 0

    return {
        "record_id": record_id,
        "region": region,
        "airtable_created_at": created_time,
        # Identity
        "lead_id": _to_lead_id(fields.get("Lead ID")),
        "prospect_name": _to_str(fields.get("Prospect Name")),
        "prospect_email": _to_str(fields.get("Prospect Email")),
        "prospect_phone": _to_str(fields.get("Prospect Phone")),
        # Call meta
        "call_type": _to_str(fields.get("Call Type")),
        "date_time_of_call": _to_iso_dt(fields.get("Date & Time of Call")),
        "call_recording": _to_str(fields.get("Call Recording")),
        "call_notes": _to_str(fields.get("Call Notes")),
        "call_notes_lost": _to_str(fields.get("Call Notes (Lead lost):")),
        # Attribution
        "closer_record_ids": _to_str_array(fields.get("Closer Name")),
        "closer_names": _to_str_array(fields.get("Name (from Closer Name)")),
        "setter_record_ids": setter_ids,
        "setter_names": _to_str_array(fields.get("Name (from Setter Name)")),
        # Dispositions
        "showed": _to_str(fields.get("Showed?")),
        "closed": _to_str(fields.get("Closed?")),
        "lost_deal": _to_str(fields.get("Lost Deal?")),
        "no_show_reason": _to_str(fields.get("No Show Reason?")),
        "paid_on_call": _to_bool(fields.get("Paid On Call?")),
        "contract_sent": _to_bool(fields.get("Contract Sent?")),
        "follow_up": _to_str(fields.get("Follow Up")),
        # Money — BOTH cash-paid-today fields stored separately
        # (ambiguity #3; dashboard picks canonical).
        "amount_paid_today_currency": _to_numeric(
            fields.get(
                "How much did they pay today?/How much are they paying upfront?"
            ),
        ),
        "amount_paid_today_number": _to_numeric(
            fields.get("Amount they paid today?"),
        ),
        "deposit_amount": _to_numeric(fields.get("Deposit?")),
        "total_contract_amount": _to_numeric(
            fields.get("Total Contract Amount"),
        ),
        "income": _to_numeric(fields.get("Income")),
        # Plan structure
        "payment_status": _to_str(fields.get("Payment Status")),
        "payment_plan_type": _to_str(fields.get("Payment Plan Type?")),
        "program_type": _to_str(
            fields.get("Which program is the client going for?"),
        ),
        # Context
        "industry": _to_str(fields.get("Industry")),
        "location": _to_str(fields.get("Location")),
        # Provisional derived attribution (flagged in schema comment)
        "is_setter_led": is_setter_led,
        # New-form (2026-05-30 redesign) disposition + plan/payment fields.
        # Old rows leave these None. Form Type discriminates New vs Old;
        # Call Outcome is the single disposition the dashboard derives
        # showed/closed/rescheduled from. Everything else here is the
        # conditional sub-fields per outcome.
        "form_type": _to_str(fields.get("Form Type")),
        "call_outcome": _to_str(fields.get("Call Outcome")),
        "cancel_reason": _to_str(fields.get("Reason")),
        "digital_college_closed": _to_str(fields.get("Digital College Closed")),
        "dc_plans": _to_str_array(
            fields.get("What plan did we get them on? (select multiple)"),
        ),
        "normal_plan": _to_str(fields.get("Select normal plan")),
        "payment_type": _to_str(fields.get("What type of payment was it?")),
        "payments_same_date": _to_str(
            fields.get("Will all payment be made on same date of each month?"),
        ),
        "creative_plan_months": _to_str(
            fields.get("How many monthly payments will there be? (creative plan)"),
        ),
        "deposit_topup_amount": _to_numeric(
            fields.get(
                "How much to collect on top of this deposit to get them started?"
            ),
        ),
        "contract_amount_to_send": _to_numeric(
            fields.get("What contract amount should be sent to the client?"),
        ),
        "follow_up_date": _to_iso_date(fields.get("Follow Up Date?")),
        "likely_start_date": _to_iso_date(
            fields.get("What's their likely start date?")
        ),
        "payment_1_amount": _to_numeric(fields.get("Amount of 1st payment?")),
        "payment_1_date": _to_iso_date(fields.get("Date of 1st payment?")),
        "payment_2_amount": _to_numeric(fields.get("Amount of 2nd payment?")),
        "payment_2_date": _to_iso_date(fields.get("Date of 2nd payment?")),
        "payment_3_amount": _to_numeric(fields.get("Amount of 3rd payment?")),
        "payment_3_date": _to_iso_date(fields.get("Date of 3rd payment?")),
        "payment_4_amount": _to_numeric(fields.get("Amount of 4th payment?")),
        "payment_4_date": _to_iso_date(fields.get("Date of 4th payment?")),
        "payment_5_amount": _to_numeric(fields.get("Amount of 5th payment?")),
        "payment_5_date": _to_iso_date(fields.get("Date of 5th payment?")),
        # Catch-all — SOURCE OF TRUTH for every field, including:
        #   - the 5 aggregation-layer-pending ambiguities
        #   - the 10 payment-installment fields
        #   - Partner-* fields
        #   - the dup payment-on-call fields (Did they pay on the call?,
        #     Have you already sent a contract?)
        #   - the typo'd Financed/Cash/Both fields
        #   - any AUS-only field
        "fields_raw": fields,
    }


# ---------------------------------------------------------------------------
# Digital College (low-ticket) sale form parser
# ---------------------------------------------------------------------------


def parse_digital_college(record: dict[str, Any]) -> dict[str, Any] | None:
    """Map one Airtable record from tbljmzRoMoE5B26lt (the Digital College
    sale form) to a row dict for airtable_digital_college_sales.

    The dedicated low-ticket closer (Robby Bryant) fills this form
    end-to-end. Closer/Setter names resolve INLINE via the lookup fields
    ('Name (from Closer Name)' / 'Name (from Setter)') — no record-id->name
    resolver needed here (unlike the Full Closer Report, whose new form
    dropped the closer-name lookup).

    Close model: `Closed?` = Yes is the explicit close flag; `plans`
    (Base/Wix x Monthly/Yearly) gives the per-product breakdown. There is
    no no-show field on the form, so show/no-show is derived downstream
    (a filed form = showed).

    Returns None on missing id."""
    record_id = record.get("id")
    if not record_id:
        return None

    fields = record.get("fields") or {}
    created_time = record.get("createdTime")

    return {
        "record_id": record_id,
        "airtable_created_at": created_time,
        "lead_id": _to_lead_id(fields.get("Lead ID")),
        "prospect_name": _to_str(fields.get("Prospect Name")),
        "date_time_of_call": _to_iso_dt(fields.get("Date & Time of Call")),
        "closer_record_ids": _to_str_array(fields.get("Closer Name")),
        "closer_names": _to_str_array(fields.get("Name (from Closer Name)")),
        "setter_record_ids": _to_str_array(fields.get("Setter")),
        "setter_names": _to_str_array(fields.get("Name (from Setter)")),
        "closed": _to_str(fields.get("Closed?")),
        "plans": _to_str_array(fields.get("What plan did we get them on?")),
        "follow_up": _to_str(fields.get("Follow Up?")),
        "follow_up_date": _to_iso_date(fields.get("Follow Up Date")),
        "call_notes": _to_str(fields.get("Call Notes")),
        "fields_raw": fields,
    }
