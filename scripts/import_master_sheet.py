"""Master sheet CSV → cloud Supabase import (M4 Chunk C).

Reads the Financial Master Sheet CSV and applies the column
transformations specified in `docs/archive/historical/client-page-schema-spec.md` § Part 5.

Default mode is dry-run (no writes; produces a report). The --apply
flag is required to actually write to the database.

Usage:
    # Dry run (default)
    .venv/bin/python scripts/import_master_sheet.py

    # Real run
    .venv/bin/python scripts/import_master_sheet.py --apply

    # Custom CSV path
    .venv/bin/python scripts/import_master_sheet.py --input path/to/sheet.csv

Idempotency: re-running with no CSV changes produces no new writes.
- clients column updates only fire when the new value differs from current.
- client_team_assignments: same person → skip; different person → end + create.
- client_upsells: skip when a row exists for (client_id, amount, sold_at).
- client_status_history / client_standing_history seed rows: dedup on
  (client_id, value, note='import seed').

History writes go directly to the tables, not through the
update_client_*_with_history RPCs from migration 0018. Reasoning per the
B2 chunk-close-out: bulk inserts in a transactional batch are cleaner
than per-row RPC overhead, and the dedicated note='import seed' marker
gives the importer its own idempotency dimension distinct from
CSM-driven edits via the dashboard.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

# Make sibling `shared` package importable when run as a script.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402

DEFAULT_CSV_PATH = (
    _REPO_ROOT
    / "data"
    / "master_sheet"
    / "Financial MasterSheet (Nabeel - Jan 26) - USA TOTALS.csv"
)
LOG_DIR = _REPO_ROOT / "data" / "master_sheet"
HISTORY_NOTE = "import seed"

# ---------------------------------------------------------------------------
# Column index map — pinned from the actual CSV header. Keeps lookups
# explicit (positional rather than name-based) so trailing-space header
# quirks ("Standing ", "DFY Setting ") don't bite.
# ---------------------------------------------------------------------------
COL = {
    "client_name": 0,
    "client_emails": 2,
    "slack_user_id": 4,
    "phone": 5,
    "date": 6,
    "uf_collected": 7,
    "contracted_rev": 8,
    "arrears": 10,
    "arrears_notes": 11,
    "status": 18,
    "owner": 19,
    "standing": 20,
    "upsells": 31,
    "trustpilot": 35,
}

STATUS_MAP = {
    "active": "active",
    "churn": "churned",
    "paused (leave)": "paused",
    "paused": "paused",
    "ghost": "ghost",
}

# Canonical CSM-standing values; case-insensitive substring matches in the
# Standing column take precedence over financial-only labels.
CSM_STANDING_MAP = {
    "happy": "happy",
    "content": "content",
    "at risk": "at_risk",
    "problem": "problem",
}
PURE_FINANCIAL_STANDINGS = {
    "owing money",
    "chargeback",
    "full refund",
    "partial refund",
    "refunded",
    "n/a (churn)",
}

TRUSTPILOT_MAP = {
    "yes": "yes",
    "no": "no",
    "ask": "ask",
    "asked": "asked",
}
# Identity map post-0020 (was master-sheet → old-DB translation;
# now the DB vocab matches Scott's column verbatim per the V1
# adoption path). Keeping the dict over a set lets the parser
# normalize-then-passthrough in one .get() call and stays a
# single point of edit if the master sheet vocab ever diverges.


# ---------------------------------------------------------------------------
# Pure transforms
# ---------------------------------------------------------------------------


def normalize_email(raw: str | None) -> str | None:
    if not raw:
        return None
    text = raw.strip().lower()
    return text if "@" in text else None


def normalize_name(raw: str | None) -> str:
    """For matching: lowercase + collapse internal whitespace."""
    if not raw:
        return ""
    return " ".join(raw.strip().lower().split())


def parse_status(raw: str | None) -> str | None:
    if raw is None:
        return None
    key = raw.strip().lower()
    return STATUS_MAP.get(key)


def parse_csm_standing(raw: str | None) -> str | None:
    """Take the CSM portion of a (possibly compound) Standing value.

    Algorithm: split on comma, trim each part, find every part that
    matches a CSM-standing keyword (case-insensitive substring), return
    the last match's mapped value. Pure-financial labels are ignored.
    Returns None when there's no CSM keyword anywhere in the value.

    Tested against the actual CSV's distinct values:
      'Content, Happy'         → 'happy'   (last CSM wins)
      'Owing Money, At risk'   → 'at_risk' (only CSM match)
      'Owing Money, Content'   → 'content' (only CSM match)
      'At risk, Owing Money'   → 'at_risk' (only CSM match)
      'Owing Money'            → None      (no CSM match)
      'Content'                → 'content' (sole CSM match)
      ''                       → None
    """
    if not raw or not raw.strip():
        return None
    parts = [p.strip().lower() for p in raw.split(",")]
    matches: list[str] = []
    for p in parts:
        if p in PURE_FINANCIAL_STANDINGS:
            continue
        for keyword, mapped in CSM_STANDING_MAP.items():
            if keyword in p:
                matches.append(mapped)
                break
    if not matches:
        return None
    return matches[-1]


def parse_trustpilot(raw: str | None) -> str | None:
    if not raw:
        return None
    return TRUSTPILOT_MAP.get(raw.strip().lower())


def parse_money(raw: str | None) -> Decimal | None:
    """Strip $ / , / whitespace and parse to Decimal. Returns None on
    empty input or unparseable strings (callers decide what to do)."""
    if raw is None:
        return None
    cleaned = raw.replace("$", "").replace(",", "").strip()
    if not cleaned:
        return None
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return None


def parse_arrears(raw: str | None) -> Decimal:
    """Arrears specifically: empty → 0, negative → 0, otherwise the
    parsed value. Mirrors the migration 0017 not-null default 0 +
    spec § Part 5's negative-normalize rule."""
    parsed = parse_money(raw)
    if parsed is None or parsed < 0:
        return Decimal("0")
    return parsed


def parse_date(raw: str | None) -> date | None:
    """Sheet date format is M/D/YYYY (e.g. '6/12/2025'). Tolerate
    leading zeros and 2-digit years just in case."""
    if not raw or not raw.strip():
        return None
    text = raw.strip()
    for fmt in ("%m/%d/%Y", "%-m/%-d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


@dataclass(frozen=True)
class OwnerParse:
    team_member_full_name: str | None  # case as it appears in team_members.full_name
    raw: str | None
    is_clean: bool  # True iff the raw cell equals the team_member name exactly


def parse_owner(raw: str | None, team_first_names: dict[str, str]) -> OwnerParse:
    """Parse the Owner (KHO!) cell.

    `team_first_names` maps lowercase first-name → team_member.full_name
    (canonical case). Resolution rules per spec § Part 5 row 19:
      - 'N/A' / 'Unassigned' / empty → no assignment
      - 'Lou (Scott Chasing)' → Lou (the leading first-name token)
      - 'Scott > Nico' → Nico (the right side of the arrow)
      - Anything else: try the rightmost first-name token; if no first
        name matches a known team_member, return team_member_full_name
        = None (caller logs an error and skips).
    """
    if raw is None:
        return OwnerParse(None, None, True)
    text = raw.strip()
    if not text or text.lower() in ("n/a", "unassigned"):
        return OwnerParse(None, None, True)

    # Right-side-of-arrow takes precedence (Scott > Nico → Nico).
    if ">" in text:
        right_side = text.split(">", 1)[1].strip()
        candidate = right_side.lower().split()[0] if right_side else ""
        full_name = team_first_names.get(candidate)
        if full_name is not None:
            return OwnerParse(full_name, text, is_clean=False)
        return OwnerParse(None, text, is_clean=False)

    # Otherwise: try the leading first-name token.
    head = text.lower().split()[0] if text else ""
    full_name = team_first_names.get(head)
    if full_name is None:
        return OwnerParse(None, text, is_clean=False)
    is_clean = text.lower() == head
    return OwnerParse(full_name, text, is_clean=is_clean)


# ---------------------------------------------------------------------------
# CSV loading
# ---------------------------------------------------------------------------


def load_csv_rows(csv_path: Path) -> list[list[str]]:
    """Return data rows (no header) from the Master Sheet CSV.

    utf-8-sig handles the BOM if present. Trailing-whitespace + smart-
    quote artifacts are tolerated by per-cell `.strip()` at use sites.
    """
    if not csv_path.exists():
        sys.exit(f"ERROR: CSV not found at {csv_path}")
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        rows = list(reader)
    return rows[1:]  # drop the header row


def filter_real_client_rows(
    data_rows: list[list[str]],
) -> tuple[list[tuple[int, list[str]]], dict[str, int]]:
    """Apply the spec § Part 5 pre-filter.

    Keep rows where Client Name is non-empty AND Status is not in
    ('', 'N/A'). Returns (kept_rows, filter_stats) where each kept row
    is paired with its 1-based CSV row number (header = 1).
    """
    kept: list[tuple[int, list[str]]] = []
    stats = Counter()
    for idx, raw in enumerate(data_rows, start=2):  # +2 because header=row 1, data starts row 2
        name = raw[COL["client_name"]].strip() if len(raw) > COL["client_name"] else ""
        status = raw[COL["status"]].strip() if len(raw) > COL["status"] else ""
        if not name:
            stats["empty_name"] += 1
            continue
        if status == "":
            stats["empty_status"] += 1
            continue
        if status.upper() == "N/A":
            stats["na_status"] += 1
            continue
        kept.append((idx, raw))
    return kept, dict(stats)


# ---------------------------------------------------------------------------
# Resolvers — built once from cloud at startup
# ---------------------------------------------------------------------------


@dataclass
class ClientResolver:
    """Match CSV rows to existing clients via the spec's 4-step ladder."""

    by_email: dict[str, str]  # email (lower) → client_id (primary or alternate)
    by_email_source: dict[str, str]  # email → 'primary' | 'alternate'
    by_name: dict[str, list[str]]  # normalized name → [client_id, ...]
    by_name_source: dict[str, str]  # normalized name → 'primary' | 'alternate'

    def lookup(self, email: str | None, name: str | None) -> tuple[str | None, str]:
        """Return (client_id, match_method) or (None, '') if no match.

        match_method ∈ {'email_primary', 'email_alternate', 'name_primary',
        'name_alternate', 'name_ambiguous'}. The caller decides whether to
        treat 'name_ambiguous' as an error.
        """
        if email:
            cid = self.by_email.get(email)
            if cid is not None:
                source = self.by_email_source.get(email, "primary")
                return cid, f"email_{source}"
        if name:
            normalized = normalize_name(name)
            ids = self.by_name.get(normalized) or []
            if len(ids) == 1:
                source = self.by_name_source.get(normalized, "primary")
                return ids[0], f"name_{source}"
            if len(ids) > 1:
                return None, "name_ambiguous"
        return None, ""


def build_client_resolver(db) -> ClientResolver:
    """Fetch all non-archived clients and build the email + name lookup
    maps, including alternates from metadata.

    Mirrors the resolver pattern in ingestion/fathom/classifier.py.
    """
    resp = (
        db.table("clients")
        .select("id, email, full_name, metadata")
        .is_("archived_at", "null")
        .execute()
    )
    rows = resp.data or []

    by_email: dict[str, str] = {}
    by_email_source: dict[str, str] = {}
    by_name: dict[str, list[str]] = {}
    by_name_source: dict[str, str] = {}

    def add_email(email: str, client_id: str, source: str) -> None:
        em = email.strip().lower()
        if not em or em in by_email:
            return
        by_email[em] = client_id
        by_email_source[em] = source

    def add_name(name: str, client_id: str, source: str) -> None:
        norm = normalize_name(name)
        if not norm:
            return
        ids = by_name.setdefault(norm, [])
        if client_id not in ids:
            ids.append(client_id)
            # First write wins for source label; ambiguous names will be
            # surfaced via len(ids) > 1 in the resolver.
            by_name_source.setdefault(norm, source)

    for row in rows:
        cid = row["id"]
        if row.get("email"):
            add_email(row["email"], cid, "primary")
        if row.get("full_name"):
            add_name(row["full_name"], cid, "primary")
        meta = row.get("metadata") or {}
        for alt_email in meta.get("alternate_emails") or []:
            if isinstance(alt_email, str):
                add_email(alt_email, cid, "alternate")
        for alt_name in meta.get("alternate_names") or []:
            if isinstance(alt_name, str):
                add_name(alt_name, cid, "alternate")

    return ClientResolver(by_email, by_email_source, by_name, by_name_source)


def load_team_members(db) -> tuple[dict[str, str], dict[str, str]]:
    """Return (id_by_full_name_lower, full_name_by_first_name_lower).

    Both maps are case-insensitive at lookup time. The first-name map
    powers parse_owner.
    """
    resp = db.table("team_members").select("id, full_name").is_("archived_at", "null").execute()
    rows = resp.data or []
    id_by_name: dict[str, str] = {}
    fullname_by_first: dict[str, str] = {}
    for r in rows:
        fn = (r.get("full_name") or "").strip()
        if not fn:
            continue
        id_by_name[fn.lower()] = r["id"]
        first = fn.lower().split()[0]
        # On collision (two team members with the same first name), the
        # last one wins — tolerated for now since our team is small and
        # collisions don't currently exist.
        fullname_by_first[first] = fn
    return id_by_name, fullname_by_first


# ---------------------------------------------------------------------------
# Per-row plan
# ---------------------------------------------------------------------------


@dataclass
class ParsedRow:
    """One filtered CSV row, all fields transformed to their target shapes."""

    csv_row_number: int
    raw_name: str
    raw_email: str | None
    email: str | None
    slack_user_id: str | None
    phone: str | None
    start_date: date | None
    upfront_cash_collected: Decimal | None
    contracted_revenue: Decimal | None
    arrears: Decimal
    arrears_note: str | None
    status: str | None
    raw_owner: str | None
    owner_team_member_name: str | None  # canonical full_name from team_members
    owner_resolution_error: str | None  # set when owner_raw is non-empty but unrecognized
    csm_standing: str | None
    upsell_amount: Decimal | None  # amount or None when the upsell text is unparseable
    upsell_notes: str | None  # populated when amount can't be parsed
    trustpilot_status: str | None
    parse_errors: list[str] = field(default_factory=list)


@dataclass
class RowPlan:
    """The proposed actions for one CSV row."""

    parsed: ParsedRow
    matched_client_id: str | None
    match_method: str  # '', 'email_primary', 'email_alternate', etc.
    is_auto_create: bool  # true when status='Churn' and no match
    column_diffs: dict[str, tuple[Any, Any]]  # field → (before, after); only fields actually changing
    fill_null_diffs: dict[str, Any]  # field → value (for fill-nulls-only fields, when current is null)
    status_history_seed: bool  # true → write a client_status_history row on apply
    standing_history_seed: bool  # true → write a client_standing_history row
    csm_assignment_change: tuple[str, str | None] | None  # ('end+create', new_team_id) | ('create', new_team_id) | None
    upsell_to_insert: dict | None  # {amount, sold_at, notes, product, recorded_by} or None
    notes: list[str] = field(default_factory=list)  # advisory notes for the report


# ---------------------------------------------------------------------------
# Build plan from parsed CSV rows + DB state
# ---------------------------------------------------------------------------


def parse_row(csv_row_number: int, raw: list[str]) -> ParsedRow:
    def cell(idx: int) -> str:
        return raw[idx].strip() if idx < len(raw) else ""

    name = cell(COL["client_name"])
    raw_email = cell(COL["client_emails"]) or None
    email = normalize_email(raw_email)
    slack_user_id = cell(COL["slack_user_id"]) or None
    phone = cell(COL["phone"]) or None
    start_date = parse_date(cell(COL["date"]))
    parse_errs: list[str] = []

    upfront = parse_money(cell(COL["uf_collected"]))
    contracted = parse_money(cell(COL["contracted_rev"]))
    arrears = parse_arrears(cell(COL["arrears"]))
    arrears_note = cell(COL["arrears_notes"]) or None

    status = parse_status(cell(COL["status"]))
    if status is None and cell(COL["status"]):
        parse_errs.append(f"unmapped status {cell(COL['status'])!r}")

    csm_standing = parse_csm_standing(cell(COL["standing"]))
    trustpilot_status = parse_trustpilot(cell(COL["trustpilot"]))

    # Upsells column: dollar amount only (per actual CSV — all 24 non-empty
    # values are clean dollar strings). If a future CSV has free-text without
    # an amount, fall back to notes=raw + amount=None.
    upsell_raw = cell(COL["upsells"])
    upsell_amount: Decimal | None = None
    upsell_notes: str | None = None
    if upsell_raw:
        amount = parse_money(upsell_raw)
        if amount is not None:
            upsell_amount = amount
        else:
            upsell_notes = upsell_raw

    return ParsedRow(
        csv_row_number=csv_row_number,
        raw_name=name,
        raw_email=raw_email,
        email=email,
        slack_user_id=slack_user_id,
        phone=phone,
        start_date=start_date,
        upfront_cash_collected=upfront,
        contracted_revenue=contracted,
        arrears=arrears,
        arrears_note=arrears_note,
        status=status,
        raw_owner=cell(COL["owner"]) or None,
        owner_team_member_name=None,  # filled in later via team-member resolver
        owner_resolution_error=None,
        csm_standing=csm_standing,
        upsell_amount=upsell_amount,
        upsell_notes=upsell_notes,
        trustpilot_status=trustpilot_status,
        parse_errors=parse_errs,
    )


def build_plan_for_row(
    parsed: ParsedRow,
    resolver: ClientResolver,
    current_clients_by_id: dict[str, dict[str, Any]],
    active_assignments_by_client: dict[str, dict[str, Any]],
    existing_upsells_by_client: dict[str, list[dict[str, Any]]],
    existing_standing_history: set[tuple[str, str]],  # (client_id, csm_standing) where note='import seed'
    team_member_id_by_full_name_lower: dict[str, str],
) -> RowPlan:
    matched_id, method = resolver.lookup(parsed.email, parsed.raw_name)
    # Drake's M4 Chunk C triage amendment: original spec restricted auto-
    # create to churned clients only, with non-churn unmatched rows logged
    # for human review. Cross-checking the first dry-run's 21 unmatched
    # confirmed they're genuinely absent from cloud (0/20 sampled emails
    # found anywhere). Drake's call: auto-create them too, with sheet-side
    # status, accept manual cleanup later. Followup logged in
    # docs/archive/historical/known-issues.md (master sheet auto-creates need cross-check).
    is_auto_create = matched_id is None and parsed.status is not None

    plan = RowPlan(
        parsed=parsed,
        matched_client_id=matched_id,
        match_method=method,
        is_auto_create=is_auto_create,
        column_diffs={},
        fill_null_diffs={},
        status_history_seed=False,
        standing_history_seed=False,
        csm_assignment_change=None,
        upsell_to_insert=None,
    )

    # Auto-create rows: brand-new clients; no diff against existing. We
    # still want history seeds + CSM assignment + upsell on the new row,
    # so set those flags here. execute_plans inserts the clients row
    # first, then runs the common path with the freshly-allocated id.
    if is_auto_create:
        plan.status_history_seed = True
        if parsed.csm_standing is not None:
            plan.standing_history_seed = True
        if parsed.owner_team_member_name is not None:
            new_team_id = team_member_id_by_full_name_lower.get(
                parsed.owner_team_member_name.lower()
            )
            if new_team_id is not None:
                plan.csm_assignment_change = ("create", new_team_id)
        if parsed.upsell_amount is not None or parsed.upsell_notes is not None:
            # client_id is filled in at apply time once the new row's id
            # is known. Dedup is unnecessary — auto-create implies no
            # prior upsells to clash with.
            plan.upsell_to_insert = {
                "amount": _decimal_str_or_none(parsed.upsell_amount),
                "sold_at": None,
                "notes": parsed.upsell_notes,
                "product": None,
                "recorded_by": None,
            }
        return plan

    # Unmatched non-churn that's NOT auto-creating (only happens if the
    # status couldn't be normalized — defensive fallback for future rule
    # changes). No writes proposed.
    if matched_id is None:
        return plan

    # Matched row: compute diffs.
    current = current_clients_by_id.get(matched_id, {})

    # Match-only fields: fill nulls, never overwrite.
    for field_name, new_value in (
        ("slack_user_id", parsed.slack_user_id),
        ("phone", parsed.phone),
        ("start_date", parsed.start_date.isoformat() if parsed.start_date else None),
    ):
        if new_value is not None and (current.get(field_name) in (None, "")):
            plan.fill_null_diffs[field_name] = new_value

    # Transformed fields: update if different from current.
    proposed_columns: dict[str, Any] = {
        "status": parsed.status,
        "csm_standing": parsed.csm_standing,
        "contracted_revenue": _decimal_str_or_none(parsed.contracted_revenue),
        "upfront_cash_collected": _decimal_str_or_none(parsed.upfront_cash_collected),
        "arrears": str(parsed.arrears),
        "arrears_note": parsed.arrears_note,
        "trustpilot_status": parsed.trustpilot_status,
    }
    for field_name, new_value in proposed_columns.items():
        if new_value is None:
            continue  # null inputs don't overwrite; intentional per spec for null-tolerant fields
        current_value = _normalize_for_diff(current.get(field_name))
        candidate = _normalize_for_diff(new_value)
        if current_value != candidate:
            plan.column_diffs[field_name] = (current.get(field_name), new_value)

    # status_history seed: write a row IFF status is changing.
    if "status" in plan.column_diffs:
        plan.status_history_seed = True

    # standing_history seed: write a row IFF csm_standing is being set to a
    # non-null value AND there's no prior import-seed row for this
    # (client_id, csm_standing) combo.
    if (
        parsed.csm_standing is not None
        and (matched_id, parsed.csm_standing) not in existing_standing_history
        and (
            current.get("csm_standing") != parsed.csm_standing
            or "csm_standing" in plan.column_diffs
        )
    ):
        plan.standing_history_seed = True

    # Owner assignment change — only applicable when the owner resolved.
    if parsed.owner_team_member_name is not None:
        new_team_id = team_member_id_by_full_name_lower.get(
            parsed.owner_team_member_name.lower()
        )
        if new_team_id is not None:
            current_assignment = active_assignments_by_client.get(matched_id)
            if current_assignment is None:
                plan.csm_assignment_change = ("create", new_team_id)
            elif current_assignment["team_member_id"] != new_team_id:
                plan.csm_assignment_change = ("end_and_create", new_team_id)
            # else same team — no change.

    # Upsell insert.
    if parsed.upsell_amount is not None or parsed.upsell_notes is not None:
        proposed = {
            "client_id": matched_id,
            "amount": _decimal_str_or_none(parsed.upsell_amount),
            "sold_at": None,
            "notes": parsed.upsell_notes,
            "product": None,
            "recorded_by": None,
        }
        existing = existing_upsells_by_client.get(matched_id, [])
        if not _upsell_already_present(proposed, existing):
            plan.upsell_to_insert = proposed

    return plan


def _upsell_already_present(
    proposed: dict[str, Any], existing: list[dict[str, Any]]
) -> bool:
    """True iff `proposed` matches an existing row on (amount, sold_at, notes)."""
    p_amount = proposed["amount"]
    p_sold_at = proposed["sold_at"]
    p_notes = proposed["notes"]
    for row in existing:
        r_amount = row.get("amount")
        # Supabase returns numeric as a string ('2500.00'); normalize.
        if r_amount is not None:
            r_amount = str(Decimal(r_amount))
        if (
            (p_amount or "") == (r_amount or "")
            and (p_sold_at or "") == (row.get("sold_at") or "")
            and (p_notes or "") == (row.get("notes") or "")
        ):
            return True
    return False


def _decimal_str_or_none(d: Decimal | None) -> str | None:
    if d is None:
        return None
    # Postgres numeric round-trips as a string via the supabase-py client;
    # serialize to keep diff comparisons exact.
    return str(d)


def _normalize_for_diff(value: Any) -> str | None:
    """Canonicalize values from PostgREST (which returns numerics as
    floats — e.g. 4616.0) and the importer's parsed Decimals (which
    preserve precision — e.g. Decimal('4616.00')) so they compare
    equal.

    Strategy: parse to Decimal when possible, format as fixed-point,
    strip trailing zeros and the bare decimal point. So 4616.0 (float),
    Decimal('4616.00'), '4616', and '4616.000' all canonicalize to
    '4616'. Decimal('123.45') stays '123.45'. Non-numeric strings pass
    through stripped.

    The naive `str(Decimal(str(x)))` approach gets bitten by the round-
    trip 4616.0 → '4616.0' → Decimal('4616.0') → '4616.0', which
    mismatches Decimal('4616.00') → '4616.00'. Idempotency on numeric
    columns relies on this canonicalization; M4 Chunk C's first
    idempotency-verification run produced 173 no-op writes before this
    helper got tightened.
    """
    if value is None:
        return None
    if isinstance(value, (int, float, Decimal)):
        try:
            d = value if isinstance(value, Decimal) else Decimal(str(value))
        except InvalidOperation:
            return str(value)
        text = format(d, "f")
        if "." in text:
            text = text.rstrip("0").rstrip(".")
        return text or "0"
    if isinstance(value, str):
        stripped = value.strip()
        try:
            d = Decimal(stripped)
            text = format(d, "f")
            if "." in text:
                text = text.rstrip("0").rstrip(".")
            return text or "0"
        except InvalidOperation:
            return stripped
    return str(value)


# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------


def execute_plans(
    db,
    plans: list[RowPlan],
    team_member_id_by_full_name_lower: dict[str, str],
) -> dict[str, int]:
    """Run all writes for the apply phase. Returns counters keyed by
    operation name. Caller renders these into the apply summary."""
    counts: dict[str, int] = {
        "auto_created": 0,
        "column_updates": 0,
        "fill_null_updates": 0,
        "csm_assignments_created": 0,
        "csm_assignments_ended": 0,
        "upsells_inserted": 0,
        "status_history_inserted": 0,
        "standing_history_inserted": 0,
    }

    now_iso = datetime.now(timezone.utc).isoformat()

    for plan in plans:
        parsed = plan.parsed

        # Resolve the effective client_id for this plan: insert first if
        # auto-creating, otherwise use the matched id.
        if plan.is_auto_create:
            new_payload: dict[str, Any] = {
                "full_name": parsed.raw_name,
                "status": parsed.status,  # Drake-amended: was hardcoded 'churned'; now uses sheet-side status
                "metadata": {
                    "import_source": "master_sheet_jan26",
                    "imported_at": now_iso,
                    "auto_created_via": "import_master_sheet.py",
                },
            }
            if parsed.email:
                new_payload["email"] = parsed.email
            else:
                # clients.email is NOT NULL (per migration 0001). Synthesize
                # a clearly-placeholder address. Drake can edit later via
                # the dashboard's Email field.
                slug = (parsed.raw_name.lower().replace(" ", "_") or "unknown")
                new_payload["email"] = f"{slug}+import@placeholder.invalid"
                counts.setdefault("placeholder_emails", 0)
                counts["placeholder_emails"] += 1
            if parsed.slack_user_id:
                new_payload["slack_user_id"] = parsed.slack_user_id
            if parsed.phone:
                new_payload["phone"] = parsed.phone
            if parsed.start_date:
                new_payload["start_date"] = parsed.start_date.isoformat()
            if parsed.contracted_revenue is not None:
                new_payload["contracted_revenue"] = str(parsed.contracted_revenue)
            if parsed.upfront_cash_collected is not None:
                new_payload["upfront_cash_collected"] = str(
                    parsed.upfront_cash_collected
                )
            new_payload["arrears"] = str(parsed.arrears)
            if parsed.arrears_note:
                new_payload["arrears_note"] = parsed.arrears_note
            if parsed.csm_standing:
                new_payload["csm_standing"] = parsed.csm_standing
            if parsed.trustpilot_status:
                new_payload["trustpilot_status"] = parsed.trustpilot_status

            resp = db.table("clients").insert(new_payload).execute()
            client_id = resp.data[0]["id"]
            counts["auto_created"] += 1
        elif plan.matched_client_id is None:
            # Defensive: with the amended auto-create rule this branch
            # should be unreachable for filtered rows, but keep the guard.
            continue
        else:
            client_id = plan.matched_client_id

            # Column updates only apply to matched clients (auto-creates
            # set their fields directly in the insert above).
            update_payload: dict[str, Any] = {}
            for field_name, (_before, after) in plan.column_diffs.items():
                update_payload[field_name] = after
            for field_name, value in plan.fill_null_diffs.items():
                update_payload[field_name] = value
            if update_payload:
                db.table("clients").update(update_payload).eq("id", client_id).execute()
                if plan.column_diffs:
                    counts["column_updates"] += 1
                if plan.fill_null_diffs:
                    counts["fill_null_updates"] += 1

        # Common path: history seeds + CSM assignment + upsell. Runs for
        # both auto-creates (using the freshly-inserted client_id) and
        # matched clients.

        if plan.status_history_seed and parsed.status:
            db.table("client_status_history").insert(
                {
                    "client_id": client_id,
                    "status": parsed.status,
                    "changed_by": None,
                    "note": HISTORY_NOTE,
                }
            ).execute()
            counts["status_history_inserted"] += 1

        if plan.standing_history_seed and parsed.csm_standing:
            db.table("client_standing_history").insert(
                {
                    "client_id": client_id,
                    "csm_standing": parsed.csm_standing,
                    "changed_by": None,
                    "note": HISTORY_NOTE,
                }
            ).execute()
            counts["standing_history_inserted"] += 1

        if plan.csm_assignment_change is not None:
            mode, new_team_id = plan.csm_assignment_change
            if new_team_id is None:
                continue  # safety; should never happen
            if mode == "end_and_create":
                db.table("client_team_assignments").update(
                    {"unassigned_at": now_iso}
                ).eq("client_id", client_id).eq("role", "primary_csm").is_(
                    "unassigned_at", "null"
                ).execute()
                counts["csm_assignments_ended"] += 1
            db.table("client_team_assignments").insert(
                {
                    "client_id": client_id,
                    "team_member_id": new_team_id,
                    "role": "primary_csm",
                    "metadata": {"import_source": "master_sheet_jan26"},
                }
            ).execute()
            counts["csm_assignments_created"] += 1

        if plan.upsell_to_insert is not None:
            payload = dict(plan.upsell_to_insert)
            # For matched clients, client_id was already in the dict; for
            # auto-creates, it was deferred and is now known.
            payload["client_id"] = client_id
            db.table("client_upsells").insert(payload).execute()
            counts["upsells_inserted"] += 1

    return counts


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------


@dataclass
class Report:
    mode: str
    csv_path: Path
    timestamp: str
    total_csv_rows: int
    filtered_stats: dict[str, int]
    real_client_rows: int
    plans: list[RowPlan]
    parse_errors: list[tuple[str, str]]  # (client_name, error)
    owner_errors: list[tuple[str, str]]  # (client_name, raw_owner)
    name_ambiguous: list[tuple[str, str | None]]  # (client_name, raw_email)


def render_report(report: Report) -> str:
    lines: list[str] = []
    lines.append("=" * 72)
    lines.append("MASTER SHEET IMPORT REPORT")
    lines.append("=" * 72)
    lines.append(f"Mode: {report.mode}")
    lines.append(f"CSV:  {report.csv_path}")
    lines.append(f"Timestamp: {report.timestamp}")
    lines.append("")

    lines.append("Row counts:")
    lines.append(f"  Total CSV rows (header excluded):  {report.total_csv_rows}")
    lines.append(f"  Filtered:                          {sum(report.filtered_stats.values())}")
    for k, v in report.filtered_stats.items():
        lines.append(f"      {k:<20}              {v}")
    lines.append(f"  Real client rows:                  {report.real_client_rows}")
    lines.append("")

    # Match breakdown.
    method_counter: Counter[str] = Counter()
    for p in report.plans:
        if p.is_auto_create:
            method_counter["auto_created (churned, no match)"] += 1
        elif p.matched_client_id is None:
            method_counter[f"unmatched ({p.match_method or 'no_match'})"] += 1
        else:
            method_counter[p.match_method] += 1
    lines.append("Matching:")
    for m in (
        "email_primary",
        "email_alternate",
        "name_primary",
        "name_alternate",
        "auto_created (churned, no match)",
    ):
        lines.append(f"  {m:<40}  {method_counter.get(m, 0)}")
    unmatched_total = sum(c for m, c in method_counter.items() if m.startswith("unmatched"))
    lines.append(f"  {'unmatched (require human review)':<40}  {unmatched_total}")
    lines.append("")

    # Unmatched detail.
    unmatched_plans = [
        p for p in report.plans if p.matched_client_id is None and not p.is_auto_create
    ]
    if unmatched_plans:
        lines.append("-" * 72)
        lines.append("UNMATCHED ROWS (require human review)")
        lines.append("-" * 72)
        for p in unmatched_plans:
            reason = p.match_method or "no email or name match"
            lines.append(
                f"  {p.parsed.raw_name:<35}"
                f"  email={p.parsed.email or '(none)':<40}"
                f"  status={p.parsed.status or '(unmapped)'}"
                f"  reason={reason}"
            )
        lines.append("")

    # Auto-created rows (churned per spec + non-churn per Drake's M4-C
    # triage amendment). Status is shown alongside name to make scanning
    # easy when both populations land in the same list.
    auto_created = [p for p in report.plans if p.is_auto_create]
    if auto_created:
        churn_count = sum(1 for p in auto_created if p.parsed.status == "churned")
        nonchurn_count = len(auto_created) - churn_count
        lines.append("-" * 72)
        lines.append(
            f"AUTO-CREATED CLIENTS ({len(auto_created)} — "
            f"{churn_count} churned, {nonchurn_count} non-churn)"
        )
        lines.append("-" * 72)
        # Sort: non-churn first (more interesting for review), then by status.
        sorted_auto = sorted(
            auto_created,
            key=lambda p: (
                0 if p.parsed.status != "churned" else 1,
                p.parsed.status or "",
                p.parsed.raw_name.lower(),
            ),
        )
        for p in sorted_auto:
            email_display = p.parsed.email or "(no email — placeholder will be synthesized on apply)"
            status = (p.parsed.status or "").ljust(8)
            lines.append(f"  [{status}] {p.parsed.raw_name:<32}  {email_display}")
        lines.append("")

    # Updates by field.
    field_counts: dict[str, dict[str, int]] = {}
    fill_null_counts: dict[str, int] = {}
    for p in report.plans:
        for f in p.column_diffs:
            field_counts.setdefault(f, {"updated": 0, "unchanged": 0})
            field_counts[f]["updated"] += 1
        for f in p.fill_null_diffs:
            fill_null_counts[f] = fill_null_counts.get(f, 0) + 1

    # Compute "unchanged" counts: matched-non-auto-create plans where the field
    # exists in proposed_columns but didn't make column_diffs.
    matched_plans = [
        p
        for p in report.plans
        if p.matched_client_id is not None and not p.is_auto_create
    ]
    transformed_fields = (
        "status",
        "csm_standing",
        "contracted_revenue",
        "upfront_cash_collected",
        "arrears",
        "arrears_note",
        "trustpilot_status",
    )
    for f in transformed_fields:
        field_counts.setdefault(f, {"updated": 0, "unchanged": 0})
        had_value = sum(1 for p in matched_plans if _has_value(p.parsed, f))
        field_counts[f]["unchanged"] = had_value - field_counts[f]["updated"]

    lines.append("Updates by field (transform fields):")
    for f in transformed_fields:
        c = field_counts.get(f, {"updated": 0, "unchanged": 0})
        lines.append(f"  {f:<28}  {c['updated']:>4} updated, {c['unchanged']:>4} unchanged")
    lines.append("")
    lines.append("Fill-null updates (overwrites only when current is null):")
    for f in ("slack_user_id", "phone", "start_date"):
        lines.append(f"  {f:<28}  {fill_null_counts.get(f, 0):>4} filled")
    lines.append("")

    # Sub-table inserts.
    csm_create = sum(
        1 for p in report.plans if p.csm_assignment_change and p.csm_assignment_change[0] in ("create", "end_and_create")
    )
    csm_end = sum(
        1 for p in report.plans if p.csm_assignment_change and p.csm_assignment_change[0] == "end_and_create"
    )
    upsells = sum(1 for p in report.plans if p.upsell_to_insert)
    # status_history_seed and standing_history_seed are set explicitly on
    # both matched and auto-create plans (post-amendment), so no double-
    # counting needed.
    status_hist = sum(1 for p in report.plans if p.status_history_seed)
    standing_hist = sum(1 for p in report.plans if p.standing_history_seed)
    lines.append("Sub-table inserts:")
    lines.append(f"  client_team_assignments (new primary_csm):  {csm_create}")
    lines.append(f"      ... of which end + create (owner change): {csm_end}")
    lines.append(f"  client_upsells:                              {upsells}")
    lines.append(f"  client_status_history (seed rows):           {status_hist}")
    lines.append(f"  client_standing_history (seed rows):         {standing_hist}")
    lines.append("")

    # Errors.
    if report.parse_errors or report.owner_errors or report.name_ambiguous:
        lines.append("-" * 72)
        lines.append("ERRORS")
        lines.append("-" * 72)
        for name, err in report.parse_errors:
            lines.append(f"  parse  | {name:<35} | {err}")
        for name, raw_owner in report.owner_errors:
            lines.append(
                f"  owner  | {name:<35} | {raw_owner!r} not in team_members — assignment skipped"
            )
        for name, email in report.name_ambiguous:
            lines.append(
                f"  match  | {name:<35} | name matches >1 client; manual review needed"
            )
        lines.append("")

    # Summary.
    total_touched = (
        sum(1 for p in report.plans if p.is_auto_create)
        + sum(1 for p in report.plans if p.column_diffs or p.fill_null_diffs)
        + sum(1 for p in report.plans if p.csm_assignment_change)
        + sum(1 for p in report.plans if p.upsell_to_insert)
        + sum(1 for p in report.plans if p.status_history_seed or p.standing_history_seed)
    )
    lines.append("Summary:")
    lines.append(f"  Net new clients (auto-created churned):       {len(auto_created)}")
    lines.append(
        f"  Net column updates (clients):                 {sum(c['updated'] for c in field_counts.values())}"
    )
    fill_total = sum(fill_null_counts.values())
    lines.append(f"  Net fill-null updates (clients):              {fill_total}")
    lines.append(f"  Net sub-table inserts:                        {csm_create + upsells + status_hist + standing_hist}")
    lines.append(f"  Plans touching the database (rough total):   {total_touched}")
    lines.append("")
    return "\n".join(lines)


def _has_value(parsed: ParsedRow, field_name: str) -> bool:
    v = getattr(parsed, field_name, None)
    if v is None:
        return False
    if isinstance(v, str) and v == "":
        return False
    if isinstance(v, Decimal):
        return True  # 0 still "has value" — meaningful for arrears
    return True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--input",
        type=Path,
        default=DEFAULT_CSV_PATH,
        help="CSV path; defaults to the master sheet location.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write changes to the database. Without this flag, dry-run only.",
    )
    args = parser.parse_args(argv)

    mode = "APPLIED" if args.apply else "DRY-RUN"
    print(f"Mode: {mode}")
    print(f"CSV:  {args.input}")
    print()

    data_rows = load_csv_rows(args.input)
    kept, filter_stats = filter_real_client_rows(data_rows)
    parsed_rows = [parse_row(idx, raw) for idx, raw in kept]

    db = get_client()

    # Build resolvers from cloud state.
    resolver = build_client_resolver(db)
    team_id_by_full, team_full_by_first = load_team_members(db)

    # Resolve each parsed row's owner against the team-member map (in-place).
    parse_errors: list[tuple[str, str]] = []
    owner_errors: list[tuple[str, str]] = []
    name_ambiguous: list[tuple[str, str | None]] = []
    for p in parsed_rows:
        for err in p.parse_errors:
            parse_errors.append((p.raw_name, err))
        op = parse_owner(p.raw_owner, team_full_by_first)
        p.owner_team_member_name = op.team_member_full_name
        if op.team_member_full_name is None and op.raw is not None:
            # Genuinely unrecognized owner value (e.g. 'Aleks').
            owner_errors.append((p.raw_name, op.raw))
            p.owner_resolution_error = f"unrecognized owner: {op.raw!r}"

    # Snapshot needed cloud state for diff/dedup computations.
    matched_ids = set()
    for p in parsed_rows:
        cid, method = resolver.lookup(p.email, p.raw_name)
        if cid is not None:
            matched_ids.add(cid)
        if method == "name_ambiguous":
            name_ambiguous.append((p.raw_name, p.email))

    current_clients_by_id = _fetch_current_clients(db, matched_ids)
    active_assignments_by_client = _fetch_active_primary_csm(db, matched_ids)
    existing_upsells_by_client = _fetch_existing_upsells(db, matched_ids)
    existing_standing_history = _fetch_import_seed_history(db, matched_ids)

    plans: list[RowPlan] = []
    for p in parsed_rows:
        plan = build_plan_for_row(
            p,
            resolver,
            current_clients_by_id,
            active_assignments_by_client,
            existing_upsells_by_client,
            existing_standing_history,
            team_id_by_full,
        )
        plans.append(plan)

    report = Report(
        mode=mode,
        csv_path=args.input,
        timestamp=datetime.now(timezone.utc).isoformat(),
        total_csv_rows=len(data_rows),
        filtered_stats=filter_stats,
        real_client_rows=len(kept),
        plans=plans,
        parse_errors=parse_errors,
        owner_errors=owner_errors,
        name_ambiguous=name_ambiguous,
    )
    report_text = render_report(report)
    print(report_text)

    if args.apply:
        print("-" * 72)
        print("APPLYING...")
        print("-" * 72)
        counts = execute_plans(db, plans, team_id_by_full)
        print()
        print("Apply summary:")
        for k, v in counts.items():
            print(f"  {k:<32}  {v}")

    # Write log file.
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log_path = LOG_DIR / f"import_report_{ts}.txt"
    log_path.write_text(report_text)
    print(f"\nLog: {log_path}")
    return 0


def _fetch_current_clients(db, ids: set[str]) -> dict[str, dict[str, Any]]:
    if not ids:
        return {}
    resp = (
        db.table("clients")
        .select(
            "id, status, csm_standing, contracted_revenue, upfront_cash_collected, "
            "arrears, arrears_note, trustpilot_status, slack_user_id, phone, start_date, "
            "metadata"
        )
        .in_("id", list(ids))
        .execute()
    )
    return {row["id"]: row for row in (resp.data or [])}


def _fetch_active_primary_csm(db, ids: set[str]) -> dict[str, dict[str, Any]]:
    if not ids:
        return {}
    resp = (
        db.table("client_team_assignments")
        .select("client_id, team_member_id, assigned_at")
        .in_("client_id", list(ids))
        .eq("role", "primary_csm")
        .is_("unassigned_at", "null")
        .execute()
    )
    return {row["client_id"]: row for row in (resp.data or [])}


def _fetch_existing_upsells(db, ids: set[str]) -> dict[str, list[dict[str, Any]]]:
    if not ids:
        return {}
    resp = (
        db.table("client_upsells")
        .select("client_id, amount, sold_at, notes, product")
        .in_("client_id", list(ids))
        .execute()
    )
    out: dict[str, list[dict[str, Any]]] = {}
    for row in resp.data or []:
        out.setdefault(row["client_id"], []).append(row)
    return out


def _fetch_import_seed_history(
    db, ids: set[str]
) -> set[tuple[str, str]]:
    """Returns {(client_id, csm_standing)} for rows already seeded by a
    prior importer run (note='import seed'). Used to dedup the
    standing_history insert on re-runs."""
    if not ids:
        return set()
    resp = (
        db.table("client_standing_history")
        .select("client_id, csm_standing")
        .in_("client_id", list(ids))
        .eq("note", HISTORY_NOTE)
        .execute()
    )
    return {(row["client_id"], row["csm_standing"]) for row in (resp.data or [])}


if __name__ == "__main__":
    sys.exit(main())
