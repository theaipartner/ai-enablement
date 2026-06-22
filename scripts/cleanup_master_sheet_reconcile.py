"""Master sheet (USA + AUS) → Gregory cleanup reconciler.

Two-phase tool that diffs Scott's two Financial Master Sheet tabs (USA
and AUS) against Gregory's clients table and applies the high-confidence
delta via existing RPCs.

Phase 1 (default): read-only diff. Reads both CSVs, matches each row to
a Gregory client via the same 4-step ladder as import_master_sheet.py
(email → email-alternate → name → name-alternate), classifies each
proposed change into Tier 1 (auto-apply), Tier 2 (eyeball required), or
Tier 3 (Scott meeting), and writes:
  - docs/data/m5_cleanup_diff.md      — the structured diff
  - docs/data/m5_cleanup_scott_notes.md — Bucket A pre-apply ambiguities

Phase 2 (--apply): tiered apply pass. Status flips → re-read → csm_standing
flips → primary_csm reassignments → trustpilot direct UPDATE → notes
append. Re-diffs post-apply; any remaining Gregory-vs-CSV mismatch lands
in scott_notes Bucket B (cascade-introduced or override-blocked).

Attribution: all RPC calls pass the Gregory Bot UUID
(cfcea32a-062d-4269-ae0f-959adac8f597) as p_changed_by + the structured
note 'cleanup:m5_master_sheet_reconcile' for SQL-side joinability. This
is a deliberate choice — see module-top constants for the rationale.

Idempotency: re-running --apply against unchanged CSVs is a near-no-op.
RPCs are no-op-when-unchanged; trustpilot/notes UPDATEs check current
value before writing; cascade re-fires on negative→negative are
documented intentional (audit trail benefits from "the cascade fired
again" being visible).

Usage:
    # Phase 1: dry-run diff
    .venv/bin/python scripts/cleanup_master_sheet_reconcile.py

    # Phase 2: apply Tier 1 changes
    .venv/bin/python scripts/cleanup_master_sheet_reconcile.py --apply

    # Override CSV paths
    .venv/bin/python scripts/cleanup_master_sheet_reconcile.py \\
        --usa-csv /path/to/usa.csv --aus-csv /path/to/aus.csv

CSV header detection: tab type (USA vs AUS) is detected by the first
header field — 'Client Name' (USA) vs 'Customer Name' (AUS). Filename
is informational only.
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Make sibling `shared` package importable when run as a script.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402


# ---------------------------------------------------------------------------
# Sentinels + attribution
# ---------------------------------------------------------------------------

GREGORY_BOT_UUID = "cfcea32a-062d-4269-ae0f-959adac8f597"
SCOTT_CHASING_UUID = "ccea0921-7fc1-4375-bcc7-1ab91733be73"

# All RPC writes use this attribution. The note format is SQL-joinable
# the same way the M5.6 cascade rows are (`cascade:status_to_<x>:by:<uuid>`).
# The Gregory Bot attribution ALSO means the override-sticky csm_standing
# logic in update_client_from_nps_segment treats these as auto-derive-
# eligible going forward — i.e. a future NPS segment can flip them. That
# matches the spirit of "we're seeding from CSV, not asserting human
# manual override."
RPC_NOTE = "cleanup:m5_master_sheet_reconcile"

# Canonical CSV location (in-repo). Drop fresh exports under
# `data/master_sheet/master-sheet-<MM-DD>/` going forward — the prior
# `/mnt/c/Users/drake/Downloads/` defaults pointed at stale Windows-side
# downloads. The 2026-05-04 canonical export superseded that ad-hoc set.
DEFAULT_USA_CSV = (
    _REPO_ROOT
    / "data/master_sheet/master-sheet-05-04"
    / "Financial MasterSheet (Nabeel - Jan 26) - USA TOTALS.csv"
)
DEFAULT_AUS_CSV = (
    _REPO_ROOT
    / "data/master_sheet/master-sheet-05-04"
    / "Financial MasterSheet (Nabeel - Jan 26) - AUS TOTALS.csv"
)

DEFAULT_DIFF_OUT = _REPO_ROOT / "docs/data/m5_cleanup_diff.md"
DEFAULT_NOTES_OUT = _REPO_ROOT / "docs/data/m5_cleanup_scott_notes.md"


# ---------------------------------------------------------------------------
# Vocab maps
# ---------------------------------------------------------------------------

# Status: CSV → Gregory. Includes 'Paused (Leave)' → 'leave' (M5.3 vocab),
# 'Churn (Aus)' → 'churned' (AUS-tab variant), and the SKIP sentinels.
_STATUS_MAP: dict[str, str | None] = {
    "active": "active",
    "paused": "paused",
    "paused (leave)": "leave",
    "ghost": "ghost",
    "churn": "churned",
    "churn (aus)": "churned",
    "n/a": None,  # sentinel: SKIP, log Tier 3
    "": None,  # sentinel: SKIP, log Tier 3
}

# csm_standing: same parser as import_master_sheet.py — handles compound
# values like 'Owing Money, At risk' and returns the CSM portion. Kept
# inline rather than imported because the cleanup-vs-import semantics
# diverge slightly (we surface "Owing Money"-only as Tier 2 for Scott
# eyeball; the importer treats it as no-csm-info).
_CSM_STANDING_KEYWORDS: dict[str, str] = {
    "happy": "happy",
    "content": "content",
    "at risk": "at_risk",
    "problem": "problem",
}
_FINANCIAL_STANDINGS = frozenset(
    {
        "owing money",
        "chargeback",
        "full refund",
        "partial refund",
        "refunded",
        "n/a (churn)",
    }
)

# Trustpilot: identity map post-0020. Case-insensitive lookup.
_TRUSTPILOT_VALUES = frozenset({"yes", "no", "ask", "asked"})

# Owner: exact-match longest-string-first lookup. Order matters because
# 'Scott Chasing' contains 'Scott'; we match the full string before
# falling back to first-name. AUS data has 'Scott Chasing' as a real
# Owner value (Shyam Srinivas) so this isn't theoretical.
_OWNER_EXACT: dict[str, str] = {
    "scott chasing": "Scott Chasing",
    "lou": "Lou Perez",
    "nico": "Nico Sandoval",
    "scott": "Scott Wilson",
    "nabeel": "Nabeel Junaid",
}
_OWNER_SKIP = frozenset({"", "n/a", "unassigned"})
_OWNER_TIER3 = frozenset({"aleks"})  # known M4 Chunk C followup


# ---------------------------------------------------------------------------
# Internal-note add (per Scott's morning message)
# ---------------------------------------------------------------------------

# Names from Scott's message → resolved to full names from CSV. The
# 9 clients listed below get the literal HANDOVER_NOTE text appended to
# clients.notes. The spec mentioned a 10th ("Lou") that's genuinely
# ambiguous (no client named Lou in either CSV) — surfaced to Tier 3.
HANDOVER_TARGETS: list[str] = [
    "Marcus Miller",
    "Mac McLaughlin",
    "Srilekha Sikhinam",
    "Kurt Buechler",
    "Michael Garner(Arthur Taylor)",  # CSV form — note text uses canonical "Michael Garner"
    "Sierra Waldrep",
    "Matthew Gibson",  # spec said "Matt G" — resolved
    "Shivam Patel",
    "Nico Bubalo",  # spec said "Nico" — disambiguated from CSM Nico Sandoval
]

# Literal note text (same on every recipient). Idempotency check before
# append: if the existing notes contain this exact text, skip.
HANDOVER_NOTE = (
    "These clients have been handed over to advisors.\n"
    "Nico-owned handovers: Marcus Miller, Mac McLaughlin, Srilekha Sikhinam, "
    "Kurt Buechler, Michael Garner, Sierra Waldrep, Matthew Gibson\n"
    "Lou-owned handover: Shivam Patel"
)


# ---------------------------------------------------------------------------
# Pure normalization
# ---------------------------------------------------------------------------


def normalize_email(raw: str | None) -> str | None:
    if not raw:
        return None
    text = raw.strip().lower()
    return text if "@" in text else None


def normalize_name_for_match(raw: str | None) -> str:
    """For client matching: lowercase + collapse internal whitespace."""
    if not raw:
        return ""
    return " ".join(raw.strip().lower().split())


def normalize_status(raw: str | None) -> tuple[str | None, bool]:
    """Returns (gregory_status, is_skip_sentinel).

    is_skip_sentinel=True for blank/N/A inputs (caller routes to Tier 3).
    is_skip_sentinel=False with gregory_status=None means "value present
    but unknown" (caller routes to Tier 2). gregory_status non-None
    means clean translation.
    """
    if raw is None:
        return None, True
    key = raw.strip().lower()
    if key in _STATUS_MAP:
        mapped = _STATUS_MAP[key]
        is_skip = mapped is None and key in ("", "n/a")
        return mapped, is_skip
    return None, False  # value present but unmapped → Tier 2


def normalize_csm_standing(raw: str | None) -> tuple[str | None, str]:
    """Returns (gregory_csm_standing, classification).

    classification ∈ {'clean', 'compound_with_financial', 'financial_only',
    'unknown', 'blank'}. Caller uses classification for tier routing.
    """
    if raw is None or not raw.strip():
        return None, "blank"
    parts = [p.strip().lower() for p in raw.split(",")]
    csm_matches: list[str] = []
    saw_financial = False
    saw_unknown = False
    for p in parts:
        if not p:
            continue
        if p in _FINANCIAL_STANDINGS:
            saw_financial = True
            continue
        matched = False
        for keyword, mapped in _CSM_STANDING_KEYWORDS.items():
            if keyword in p:
                csm_matches.append(mapped)
                matched = True
                break
        if not matched:
            saw_unknown = True
    if csm_matches:
        # Last CSM token wins (matches import_master_sheet.py semantics).
        result = csm_matches[-1]
        if saw_financial:
            return result, "compound_with_financial"
        return result, "clean"
    if saw_financial:
        return None, "financial_only"
    if saw_unknown:
        return None, "unknown"
    return None, "blank"


def normalize_trustpilot(raw: str | None) -> tuple[str | None, str]:
    """Returns (gregory_value, classification ∈ {'clean','blank','unknown'})."""
    if raw is None or not raw.strip():
        return None, "blank"
    key = raw.strip().lower()
    if key in _TRUSTPILOT_VALUES:
        return key, "clean"
    return None, "unknown"


def normalize_owner(raw: str | None) -> tuple[str | None, str]:
    """Returns (gregory_team_member_full_name, classification).

    classification ∈ {'clean', 'skip', 'tier3_known' (Aleks), 'unknown'}.
    """
    if raw is None:
        return None, "skip"
    key = raw.strip().lower()
    if key in _OWNER_SKIP:
        return None, "skip"
    if key in _OWNER_TIER3:
        return None, "tier3_known"
    if key in _OWNER_EXACT:
        return _OWNER_EXACT[key], "clean"
    # Fallback: try first token as a first name.
    first = key.split()[0] if key else ""
    if first in _OWNER_EXACT:
        # E.g. 'Lou (Scott Chasing)' → 'Lou Perez'. The exact match
        # caught 'Scott Chasing' above so this only fires on
        # first-name-prefix oddities.
        return _OWNER_EXACT[first], "clean"
    return None, "unknown"


# ---------------------------------------------------------------------------
# CSV ingestion
# ---------------------------------------------------------------------------


@dataclass
class CsvHeader:
    """Resolved header positions for one CSV tab. Header keys are the
    canonical lowercased trimmed strings; values are the column index in
    the row tuple."""

    tab: str  # 'USA' | 'AUS'
    fields: dict[str, int]


def detect_tab(headers: list[str]) -> str:
    """Detect tab type by first header. Per spec, the contract is the
    header content, not the filename."""
    first = (headers[0] if headers else "").strip().lower()
    if first == "client name":
        return "USA"
    if first == "customer name":
        return "AUS"
    raise ValueError(
        f"Unknown CSV tab — first header is {first!r}. "
        "Expected 'Client Name' (USA) or 'Customer Name' (AUS)."
    )


# Per-tab header → canonical key. The canonical key drives downstream
# logic. Trailing whitespace ("Owner ", "Standing ", "Meetings May ") is
# tolerated by stripping at lookup.
_USA_HEADER_KEYS: dict[str, str] = {
    "client name": "name",
    "client emails": "email",
    "slack channel id": "slack_channel_id",
    "slack user id": "slack_user_id",
    "client phone no.": "phone",
    "date": "date",
    "status": "status",
    "owner": "owner",
    "standing": "standing",
    "nps standing": "nps_standing",
    "trustpilot": "trustpilot",
    "scott notes.": "scott_notes",
    "stage": "stage",
    "ghl adoption": "ghl_adoption",
}
_AUS_HEADER_KEYS: dict[str, str] = {
    "customer name": "name",
    "client emails": "email",
    "slack channel id": "slack_channel_id",
    "slack user id": "slack_user_id",
    "date": "date",
    "status": "status",
    "owner": "owner",
    "standing": "standing",
    "nps standing": "nps_standing",
    "trustpilot": "trustpilot",
    "stage": "stage",
    "ghl adoption": "ghl_adoption",
    "notes": "notes",
}


def build_header_index(headers: list[str], tab: str) -> CsvHeader:
    keys_map = _USA_HEADER_KEYS if tab == "USA" else _AUS_HEADER_KEYS
    fields: dict[str, int] = {}
    for idx, raw_header in enumerate(headers):
        key = raw_header.strip().lower()
        canon = keys_map.get(key)
        if canon and canon not in fields:
            fields[canon] = idx
    return CsvHeader(tab=tab, fields=fields)


@dataclass
class CsvRow:
    tab: str
    csv_row_number: int  # 1-based, header is row 1
    name: str
    email: str | None
    slack_channel_id: str | None
    slack_user_id: str | None
    phone: str | None
    raw_status: str
    raw_owner: str
    raw_standing: str
    raw_nps_standing: str
    raw_trustpilot: str
    raw_scott_notes: str  # USA only; AUS doesn't have this column
    raw_date: str = ""  # CSV's Date column — start_date source for completeness pass

    def get(self, key: str, default: str = "") -> str:
        return getattr(self, key, default) or default


def load_csv(path: Path) -> tuple[CsvHeader, list[CsvRow]]:
    """Load a master sheet CSV. Filters trailing/aggregator rows where
    Client Name / Customer Name is blank (the master sheet's footer
    panel — 'Referrals', 'Upsells', percentage rows, etc.)."""
    if not path.exists():
        sys.exit(f"ERROR: CSV not found at {path}")
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        rows = list(reader)
    if not rows:
        sys.exit(f"ERROR: empty CSV at {path}")
    header = rows[0]
    tab = detect_tab(header)
    hdr = build_header_index(header, tab)

    def cell(row: list[str], canon: str) -> str:
        idx = hdr.fields.get(canon)
        if idx is None or idx >= len(row):
            return ""
        return row[idx].strip()

    out: list[CsvRow] = []
    for csv_row_number, raw in enumerate(rows[1:], start=2):
        name = cell(raw, "name")
        if not name:
            continue  # silent drop — totally blank rows
        email = normalize_email(cell(raw, "email"))
        raw_status = cell(raw, "status")
        raw_owner = cell(raw, "owner")
        raw_standing = cell(raw, "standing")
        # Aggregator/footer rows in the master sheet (TOTALS, BE Collection
        # Opportunity, Referrals, etc.) carry a non-empty name but no
        # email, no status, no owner, and no standing. Real clients have
        # at least one of these populated even when the status is N/A.
        # Distinguishing rule: drop as aggregator if email/status/owner/
        # standing are ALL blank.
        if not (email or raw_status or raw_owner or raw_standing):
            continue
        out.append(
            CsvRow(
                tab=tab,
                csv_row_number=csv_row_number,
                name=name,
                email=email,
                slack_channel_id=cell(raw, "slack_channel_id") or None,
                slack_user_id=cell(raw, "slack_user_id") or None,
                phone=cell(raw, "phone") or None,
                raw_status=raw_status,
                raw_owner=raw_owner,
                raw_standing=raw_standing,
                raw_nps_standing=cell(raw, "nps_standing"),
                raw_trustpilot=cell(raw, "trustpilot"),
                raw_scott_notes=cell(raw, "scott_notes"),
                raw_date=cell(raw, "date"),
            )
        )
    return hdr, out


# ---------------------------------------------------------------------------
# Resolver — mirror the ClientResolver in import_master_sheet.py
# ---------------------------------------------------------------------------


@dataclass
class ClientResolver:
    by_email: dict[str, str]
    by_email_source: dict[str, str]
    by_name: dict[str, list[str]]
    by_name_source: dict[str, str]
    clients_by_id: dict[str, dict[str, Any]]

    def lookup(self, email: str | None, name: str | None) -> tuple[str | None, str]:
        """Return (client_id, match_method). match_method ∈
        {'email_primary', 'email_alternate', 'name_primary',
        'name_alternate', 'name_ambiguous', ''}."""
        if email:
            cid = self.by_email.get(email)
            if cid is not None:
                source = self.by_email_source.get(email, "primary")
                return cid, f"email_{source}"
        if name:
            normalized = normalize_name_for_match(name)
            ids = self.by_name.get(normalized) or []
            if len(ids) == 1:
                source = self.by_name_source.get(normalized, "primary")
                return ids[0], f"name_{source}"
            if len(ids) > 1:
                return None, "name_ambiguous"
        return None, ""


def build_resolver(db) -> ClientResolver:
    """Snapshot non-archived clients. Same shape as import_master_sheet's
    resolver, plus we keep the full rows in clients_by_id for diff
    computation."""
    resp = (
        db.table("clients")
        .select(
            "id, email, full_name, status, csm_standing, "
            "trustpilot_status, slack_user_id, notes, metadata, "
            "accountability_enabled, nps_enabled"
        )
        .is_("archived_at", "null")
        .execute()
    )
    rows = resp.data or []

    by_email: dict[str, str] = {}
    by_email_source: dict[str, str] = {}
    by_name: dict[str, list[str]] = {}
    by_name_source: dict[str, str] = {}
    clients_by_id: dict[str, dict[str, Any]] = {}

    def add_email(email: str, client_id: str, source: str) -> None:
        em = email.strip().lower()
        if not em or em in by_email:
            return
        by_email[em] = client_id
        by_email_source[em] = source

    def add_name(name: str, client_id: str, source: str) -> None:
        norm = normalize_name_for_match(name)
        if not norm:
            return
        ids = by_name.setdefault(norm, [])
        if client_id not in ids:
            ids.append(client_id)
            by_name_source.setdefault(norm, source)

    for row in rows:
        cid = row["id"]
        clients_by_id[cid] = row
        if row.get("email"):
            add_email(row["email"], cid, "primary")
        if row.get("full_name"):
            add_name(row["full_name"], cid, "primary")
        meta = row.get("metadata") or {}
        for alt in meta.get("alternate_emails") or []:
            if isinstance(alt, str):
                add_email(alt, cid, "alternate")
        for alt in meta.get("alternate_names") or []:
            if isinstance(alt, str):
                add_name(alt, cid, "alternate")

    return ClientResolver(
        by_email=by_email,
        by_email_source=by_email_source,
        by_name=by_name,
        by_name_source=by_name_source,
        clients_by_id=clients_by_id,
    )


def load_team_members(db) -> dict[str, str]:
    """Map team_member full_name → id (case-sensitive on full_name as
    stored). Includes archived team members so backfilled CSV owner
    references still resolve, but the diff routes those to Tier 3 via
    the is_archived check upstream."""
    resp = db.table("team_members").select("id, full_name").execute()
    return {(r["full_name"] or ""): r["id"] for r in (resp.data or [])}


def load_active_primary_csm(db) -> dict[str, str]:
    """Map client_id → currently-active primary_csm team_member_id."""
    resp = (
        db.table("client_team_assignments")
        .select("client_id, team_member_id")
        .eq("role", "primary_csm")
        .is_("unassigned_at", "null")
        .execute()
    )
    return {r["client_id"]: r["team_member_id"] for r in (resp.data or [])}


def load_slack_channels_by_client(db) -> dict[str, list[str]]:
    """Map client_id → list[slack_channel_id] for non-archived channels.
    Used to filter the slack_channel_id Tier 2 surfacing — only flag
    rows where Gregory has zero channels for the client."""
    resp = (
        db.table("slack_channels")
        .select("client_id, slack_channel_id, is_archived")
        .eq("is_archived", False)
        .execute()
    )
    out: dict[str, list[str]] = {}
    for row in resp.data or []:
        cid = row.get("client_id")
        if cid:
            out.setdefault(cid, []).append(row["slack_channel_id"])
    return out


# ---------------------------------------------------------------------------
# Diff data structures
# ---------------------------------------------------------------------------


@dataclass
class FieldChange:
    """One proposed change to one client."""

    csv_row: CsvRow
    client_id: str | None  # None for unmatched-but-otherwise-meaningful rows
    client_name: str  # current Gregory name OR CSV name if unmatched
    field: str
    current_value: Any
    proposed_value: Any
    tier: int  # 1 / 2 / 3
    reason: str  # human-readable explanation

    @property
    def gregory_label(self) -> str:
        return self.client_name or self.csv_row.name


@dataclass
class HandoverNotePlan:
    """One client receiving the handover-note append (Tier 1)."""

    client_id: str
    client_name: str
    csv_row: CsvRow
    current_notes: str | None
    will_skip_idempotent: bool  # true if existing notes already contain HANDOVER_NOTE


@dataclass
class DiffResult:
    csv_rows_total: int
    matched_rows: int
    unmatched_rows: list[CsvRow]  # match miss (no client_id resolved)
    skipped_drake_rows: int
    field_changes: list[FieldChange]  # all proposed changes, all tiers
    handover_plans: list[HandoverNotePlan]
    handover_unresolved: list[str]  # spec names that couldn't be resolved (e.g. "Lou")
    name_ambiguous: list[CsvRow]
    duplicate_csv_emails: list[tuple[str, list[CsvRow]]]
    redundant_with_cascade: list[
        tuple[str, Any, Any]
    ]  # (client_name, current_csm, csv_csm) — skipped because cascade does it
    generated_at: str


# ---------------------------------------------------------------------------
# Diff computation
# ---------------------------------------------------------------------------


def _is_negative_status(status: str | None) -> bool:
    return status in ("ghost", "paused", "leave", "churned")


def compute_diff(
    csv_rows: list[CsvRow],
    resolver: ClientResolver,
    team_members_by_name: dict[str, str],
    active_primary_csm: dict[str, str],
    slack_channels_by_client: dict[str, list[str]] | None = None,
    is_post_apply: bool = False,
) -> DiffResult:
    """Build the full diff. is_post_apply=True flags every Tier 1 to be
    re-classified as 'post-apply mismatch' if it surfaces — used by the
    re-diff after Phase 2 writes to populate scott_notes Bucket B.

    slack_channels_by_client: client_id → list[active slack_channel_id].
    Used to filter the CSV slack_channel_id surfacing — only flag CSV
    rows where Gregory has NO active channel for that client. Empty
    dict / None disables the filter (legacy behavior — surfaces every
    CSV channel ID)."""
    if slack_channels_by_client is None:
        slack_channels_by_client = {}
    field_changes: list[FieldChange] = []
    unmatched: list[CsvRow] = []
    name_ambiguous: list[CsvRow] = []
    redundant_with_cascade: list[tuple[str, Any, Any]] = []
    matched_rows = 0
    skipped_drake_rows = 0

    # Track CSV email duplicates — same email used by >1 row.
    email_to_rows: dict[str, list[CsvRow]] = {}
    for row in csv_rows:
        if row.email:
            email_to_rows.setdefault(row.email, []).append(row)
    duplicate_csv_emails = [
        (email, rows) for email, rows in email_to_rows.items() if len(rows) > 1
    ]

    for row in csv_rows:
        # Drake silent-skip: per spec "row 1 — internal/test row, skip
        # silently." Treat any USA row whose name is exactly "Drake" as
        # the test row (post-strip). The blank-status filter would have
        # caught it anyway, but be explicit so the reason shows up in
        # the report counter.
        if row.tab == "USA" and row.name.strip().lower() == "drake":
            skipped_drake_rows += 1
            continue

        client_id, method = resolver.lookup(row.email, row.name)
        if method == "name_ambiguous":
            name_ambiguous.append(row)
            continue
        if client_id is None:
            unmatched.append(row)
            continue

        matched_rows += 1
        current = resolver.clients_by_id.get(client_id, {})
        gregory_name = current.get("full_name") or row.name

        # ----- Status -----
        status_value, status_skip = normalize_status(row.raw_status)
        if status_value is None and status_skip:
            # blank or 'N/A' status → Tier 3 ("Scott meeting — confirm
            # what to do with this client")
            field_changes.append(
                FieldChange(
                    csv_row=row,
                    client_id=client_id,
                    client_name=gregory_name,
                    field="status",
                    current_value=current.get("status"),
                    proposed_value=row.raw_status or "(blank)",
                    tier=3,
                    reason="CSV status is blank or N/A — needs Scott decision",
                )
            )
        elif status_value is None and not status_skip:
            # value present but unmapped → Tier 2 (eyeball)
            field_changes.append(
                FieldChange(
                    csv_row=row,
                    client_id=client_id,
                    client_name=gregory_name,
                    field="status",
                    current_value=current.get("status"),
                    proposed_value=row.raw_status,
                    tier=2,
                    reason=f"unmapped status {row.raw_status!r}",
                )
            )
        elif status_value is not None and status_value != current.get("status"):
            # Real status flip → Tier 1
            tier = (
                1 if not is_post_apply else 1
            )  # re-diff also reports Tier 1 for joinable display
            field_changes.append(
                FieldChange(
                    csv_row=row,
                    client_id=client_id,
                    client_name=gregory_name,
                    field="status",
                    current_value=current.get("status"),
                    proposed_value=status_value,
                    tier=tier,
                    reason=(
                        "status flip"
                        + (
                            " → cascade will fire"
                            if _is_negative_status(status_value)
                            else ""
                        )
                    ),
                )
            )

        # ----- csm_standing -----
        csm_value, csm_class = normalize_csm_standing(row.raw_standing)
        if csm_class == "blank":
            pass  # skip silently — no CSV signal
        elif csm_class == "financial_only":
            # 'Owing Money' alone — Tier 2 (Drake eyeball; this isn't a
            # Gregory standing value but it's intentional CSV-side info)
            field_changes.append(
                FieldChange(
                    csv_row=row,
                    client_id=client_id,
                    client_name=gregory_name,
                    field="csm_standing",
                    current_value=current.get("csm_standing"),
                    proposed_value=row.raw_standing,
                    tier=2,
                    reason="financial-only standing (no CSM tier) — eyeball",
                )
            )
        elif csm_class == "unknown":
            field_changes.append(
                FieldChange(
                    csv_row=row,
                    client_id=client_id,
                    client_name=gregory_name,
                    field="csm_standing",
                    current_value=current.get("csm_standing"),
                    proposed_value=row.raw_standing,
                    tier=2,
                    reason=f"unparseable standing value {row.raw_standing!r}",
                )
            )
        elif csm_value is not None and csm_value != current.get("csm_standing"):
            # Cascade-redundancy filter (Drake's adjustment). Three cases:
            #
            # 1) status going negative AND CSV csm_standing == 'at_risk':
            #    SKIP the explicit write. The cascade trigger sets
            #    csm_standing='at_risk' for free; an extra RPC produces
            #    a duplicate history row for no behavior delta.
            #
            # 2) status going negative AND CSV csm_standing != 'at_risk'
            #    (e.g. CSV says 'happy'): KEEP the write. The cascade
            #    will overwrite to 'at_risk' anyway, but the post-apply
            #    re-diff surfaces this as a Bucket B contradiction Scott
            #    confirms — that's signal, not noise.
            #
            # 3) status NOT going negative (positive or no-change): KEEP
            #    the write. The cascade does NOT auto-revert csm_standing
            #    on positive transitions, so we MUST write CSV's value
            #    explicitly. This is Marcus Miller (ghost→active) and
            #    Allison Jayme Boeshans (paused→active).
            status_now_negative = _is_negative_status(status_value) and (
                status_value != current.get("status")
            )
            if status_now_negative and csm_value == "at_risk":
                redundant_with_cascade.append(
                    (gregory_name, current.get("csm_standing"), csm_value)
                )
                # Don't add to field_changes — the cascade does it.
            else:
                tier_note = ""
                if status_now_negative and csm_value != "at_risk":
                    tier_note = (
                        " (cascade will overwrite to at_risk — Bucket B contradiction)"
                    )
                elif not _is_negative_status(status_value) and _is_negative_status(
                    current.get("status")
                ):
                    tier_note = " (positive transition — cascade does NOT auto-revert; explicit write required)"
                field_changes.append(
                    FieldChange(
                        csv_row=row,
                        client_id=client_id,
                        client_name=gregory_name,
                        field="csm_standing",
                        current_value=current.get("csm_standing"),
                        proposed_value=csm_value,
                        tier=1,
                        reason=f"csm_standing flip{tier_note}",
                    )
                )

        # ----- primary_csm (owner) -----
        owner_full_name, owner_class = normalize_owner(row.raw_owner)
        current_team_id = active_primary_csm.get(client_id)
        if owner_class == "skip":
            pass  # don't blank Gregory's existing owner
        elif owner_class == "tier3_known":
            field_changes.append(
                FieldChange(
                    csv_row=row,
                    client_id=client_id,
                    client_name=gregory_name,
                    field="primary_csm",
                    current_value=_team_id_to_name(
                        current_team_id, team_members_by_name
                    ),
                    proposed_value=row.raw_owner,
                    tier=3,
                    reason="Aleks-owned (M4 Chunk C carry-over — Scott reassignment)",
                )
            )
        elif owner_class == "unknown":
            field_changes.append(
                FieldChange(
                    csv_row=row,
                    client_id=client_id,
                    client_name=gregory_name,
                    field="primary_csm",
                    current_value=_team_id_to_name(
                        current_team_id, team_members_by_name
                    ),
                    proposed_value=row.raw_owner,
                    tier=2,
                    reason=f"unrecognized owner {row.raw_owner!r}",
                )
            )
        elif owner_full_name is not None:
            target_team_id = team_members_by_name.get(owner_full_name)
            if target_team_id is None:
                # Owner string maps to a name we recognize but the
                # team_member row doesn't exist by that name — defensive,
                # surface to Tier 2.
                field_changes.append(
                    FieldChange(
                        csv_row=row,
                        client_id=client_id,
                        client_name=gregory_name,
                        field="primary_csm",
                        current_value=_team_id_to_name(
                            current_team_id, team_members_by_name
                        ),
                        proposed_value=owner_full_name,
                        tier=2,
                        reason=f"resolved name {owner_full_name!r} not in team_members",
                    )
                )
            elif current_team_id != target_team_id:
                tier_note = ""
                if (
                    _is_negative_status(status_value)
                    and target_team_id != SCOTT_CHASING_UUID
                ):
                    tier_note = " (cascade will likely set to Scott Chasing)"
                field_changes.append(
                    FieldChange(
                        csv_row=row,
                        client_id=client_id,
                        client_name=gregory_name,
                        field="primary_csm",
                        current_value=_team_id_to_name(
                            current_team_id, team_members_by_name
                        ),
                        proposed_value=owner_full_name,
                        tier=1,
                        reason=f"primary_csm reassignment{tier_note}",
                    )
                )

        # ----- trustpilot -----
        tp_value, tp_class = normalize_trustpilot(row.raw_trustpilot)
        if tp_class == "blank":
            pass
        elif tp_class == "unknown":
            field_changes.append(
                FieldChange(
                    csv_row=row,
                    client_id=client_id,
                    client_name=gregory_name,
                    field="trustpilot_status",
                    current_value=current.get("trustpilot_status"),
                    proposed_value=row.raw_trustpilot,
                    tier=2,
                    reason=f"unparseable trustpilot {row.raw_trustpilot!r}",
                )
            )
        elif tp_value is not None and tp_value != current.get("trustpilot_status"):
            field_changes.append(
                FieldChange(
                    csv_row=row,
                    client_id=client_id,
                    client_name=gregory_name,
                    field="trustpilot_status",
                    current_value=current.get("trustpilot_status"),
                    proposed_value=tp_value,
                    tier=1,
                    reason="trustpilot flip",
                )
            )

        # ----- email mismatch (Tier 2) -----
        # If CSV has an email that doesn't match Gregory's primary email
        # AND we resolved this client via name (not email), flag it.
        if (
            row.email
            and current.get("email")
            and row.email != (current.get("email") or "").strip().lower()
            and method.startswith("name_")
        ):
            meta_alts = (current.get("metadata") or {}).get("alternate_emails") or []
            if row.email not in [str(a).strip().lower() for a in meta_alts]:
                field_changes.append(
                    FieldChange(
                        csv_row=row,
                        client_id=client_id,
                        client_name=gregory_name,
                        field="email",
                        current_value=current.get("email"),
                        proposed_value=row.email,
                        tier=2,
                        reason="CSV email differs from Gregory primary; not in alternate_emails",
                    )
                )

        # ----- slack ID gaps (Tier 2 — never auto-populate) -----
        if row.slack_user_id and not current.get("slack_user_id"):
            field_changes.append(
                FieldChange(
                    csv_row=row,
                    client_id=client_id,
                    client_name=gregory_name,
                    field="slack_user_id",
                    current_value=current.get("slack_user_id"),
                    proposed_value=row.slack_user_id,
                    tier=2,
                    reason="CSV has slack_user_id; Gregory does not",
                )
            )
        # slack_channel_id (Tier 2 — coverage gap signal). slack_channels
        # is a separate table per migration 0002; we loaded the
        # client_id → [channel_ids] map via load_slack_channels_by_client.
        # Only flag rows where CSV has a channel ID AND Gregory has zero
        # channels for the client. Drake's adjustment: previously this
        # surfaced every CSV channel which was 126 rows of mostly noise.
        if row.slack_channel_id:
            existing_channels = slack_channels_by_client.get(client_id) or []
            if not existing_channels:
                field_changes.append(
                    FieldChange(
                        csv_row=row,
                        client_id=client_id,
                        client_name=gregory_name,
                        field="slack_channel_id",
                        current_value="(none — no slack_channels row)",
                        proposed_value=row.slack_channel_id,
                        tier=2,
                        reason="Gregory has no slack_channels row for this client; CSV has one",
                    )
                )

        # ----- NPS Standing (Tier 3 — never auto-apply) -----
        if row.raw_nps_standing.strip():
            field_changes.append(
                FieldChange(
                    csv_row=row,
                    client_id=client_id,
                    client_name=gregory_name,
                    field="nps_standing",
                    current_value=(
                        current.get("nps_standing")
                        if "nps_standing" in current
                        else "(not loaded)"
                    ),
                    proposed_value=row.raw_nps_standing.strip(),
                    tier=3,
                    reason="NPS Standing in CSV — Path 1 owns this column; surfaces only for Drake/Scott eyeball",
                )
            )

    # Resolve handover targets.
    handover_plans, handover_unresolved = _resolve_handover_targets(csv_rows, resolver)

    return DiffResult(
        csv_rows_total=len(csv_rows),
        matched_rows=matched_rows,
        unmatched_rows=unmatched,
        skipped_drake_rows=skipped_drake_rows,
        field_changes=field_changes,
        handover_plans=handover_plans,
        handover_unresolved=handover_unresolved,
        name_ambiguous=name_ambiguous,
        duplicate_csv_emails=duplicate_csv_emails,
        redundant_with_cascade=redundant_with_cascade,
        generated_at=datetime.now(timezone.utc).isoformat(),
    )


def _team_id_to_name(
    team_id: str | None, team_members_by_name: dict[str, str]
) -> str | None:
    if team_id is None:
        return None
    # Reverse the map. team_members_by_name has duplicates from archived
    # rows in some cases; first hit wins.
    for name, tid in team_members_by_name.items():
        if tid == team_id:
            return name
    return f"(unknown team_member {team_id})"


def _resolve_handover_targets(
    csv_rows: list[CsvRow], resolver: ClientResolver
) -> tuple[list[HandoverNotePlan], list[str]]:
    """For each name in HANDOVER_TARGETS, resolve to a Gregory client_id
    via the CSV (use the CSV row's email if present, else name match).
    Returns (resolved_plans, unresolved_spec_names)."""
    # Index CSV rows by exact name (lowercase) for fast lookup.
    by_lower_name: dict[str, CsvRow] = {}
    for row in csv_rows:
        by_lower_name[row.name.strip().lower()] = row

    plans: list[HandoverNotePlan] = []
    unresolved: list[str] = []
    for target in HANDOVER_TARGETS:
        csv_row = by_lower_name.get(target.lower())
        if csv_row is None:
            unresolved.append(f"{target} (not in either CSV)")
            continue
        client_id, method = resolver.lookup(csv_row.email, csv_row.name)
        if client_id is None:
            unresolved.append(
                f"{target} (in CSV row {csv_row.tab}/{csv_row.csv_row_number} "
                f"but no Gregory client matches — needs to be created first)"
            )
            continue
        client = resolver.clients_by_id.get(client_id, {})
        current_notes = client.get("notes") or ""
        will_skip = HANDOVER_NOTE in current_notes
        plans.append(
            HandoverNotePlan(
                client_id=client_id,
                client_name=client.get("full_name") or csv_row.name,
                csv_row=csv_row,
                current_notes=current_notes or None,
                will_skip_idempotent=will_skip,
            )
        )
    # The literal spec listed "Lou" as a 10th name; it doesn't appear
    # in any CSV. Surface it explicitly in the unresolved list so
    # scott_notes flags it.
    unresolved.append("Lou (no client by that name in either CSV — spec ambiguous)")
    return plans, unresolved


# ---------------------------------------------------------------------------
# Output rendering — diff
# ---------------------------------------------------------------------------


def _tier_changes(diff: DiffResult, tier: int) -> list[FieldChange]:
    return [c for c in diff.field_changes if c.tier == tier]


def render_diff_md(diff: DiffResult) -> str:
    lines: list[str] = []
    tier1 = _tier_changes(diff, 1)
    tier2 = _tier_changes(diff, 2)
    tier3 = _tier_changes(diff, 3)

    lines.append("# M5 cleanup — master sheet vs Gregory diff")
    lines.append("")
    lines.append(f"Generated: `{diff.generated_at}`")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(
        f"- CSV rows total (after blank-name filter): **{diff.csv_rows_total}**"
    )
    lines.append(f"- Matched to Gregory clients: **{diff.matched_rows}**")
    lines.append(f"- Unmatched: **{len(diff.unmatched_rows)}**")
    lines.append(f"- Drake silent-skipped: **{diff.skipped_drake_rows}**")
    lines.append(f"- Name-ambiguous (>1 Gregory match): **{len(diff.name_ambiguous)}**")
    lines.append(
        f"- Field changes proposed: **{len(diff.field_changes)}** (Tier 1: {len(tier1)} / Tier 2: {len(tier2)} / Tier 3: {len(tier3)})"
    )
    lines.append(
        f"- Handover note appends: **{len(diff.handover_plans)}** ({sum(1 for p in diff.handover_plans if p.will_skip_idempotent)} idempotent skips)"
    )
    lines.append(
        f"- Cascade-redundant csm_standing skips: **{len(diff.redundant_with_cascade)}** (cascade sets at_risk; explicit RPC would duplicate the history row)"
    )
    lines.append("")

    # Tier 1 sub-tables.
    lines.append("## Tier 1 — high-confidence auto-applies")
    lines.append("")
    if not tier1:
        lines.append("_(none)_")
    else:
        for category in ("status", "csm_standing", "primary_csm", "trustpilot_status"):
            cat_rows = [c for c in tier1 if c.field == category]
            if not cat_rows:
                continue
            lines.append(f"### {category} ({len(cat_rows)})")
            lines.append("")
            lines.append("| Client | Tab | Current | → Proposed | Reason |")
            lines.append("|---|---|---|---|---|")
            for c in sorted(cat_rows, key=lambda r: r.client_name.lower()):
                lines.append(
                    f"| {_md_escape(c.client_name)} "
                    f"| {c.csv_row.tab} "
                    f"| `{_md_inline(c.current_value)}` "
                    f"| `{_md_inline(c.proposed_value)}` "
                    f"| {_md_escape(c.reason)} |"
                )
            lines.append("")

        if diff.handover_plans:
            lines.append(f"### handover note append ({len(diff.handover_plans)})")
            lines.append("")
            lines.append(
                "Each listed client gets the following text appended to `clients.notes`:"
            )
            lines.append("")
            lines.append("```")
            lines.append(HANDOVER_NOTE)
            lines.append("```")
            lines.append("")
            lines.append("| Client | Existing notes? | Idempotent skip? |")
            lines.append("|---|---|---|")
            for plan in diff.handover_plans:
                existing = "yes" if plan.current_notes else "no"
                idem = (
                    "yes (already contains the text)"
                    if plan.will_skip_idempotent
                    else "no — will append"
                )
                lines.append(
                    f"| {_md_escape(plan.client_name)} | {existing} | {idem} |"
                )
            lines.append("")
    lines.append("")

    # Tier 2.
    lines.append("## Tier 2 — eyeball required")
    lines.append("")
    if not tier2:
        lines.append("_(none)_")
    else:
        # Group by field then by reason for tighter scanning.
        by_field: dict[str, list[FieldChange]] = {}
        for c in tier2:
            by_field.setdefault(c.field, []).append(c)
        for field_name, items in by_field.items():
            lines.append(f"### {field_name} ({len(items)})")
            lines.append("")
            lines.append("| Client | Tab | Current | CSV value | Reason |")
            lines.append("|---|---|---|---|---|")
            for c in sorted(items, key=lambda r: r.client_name.lower()):
                lines.append(
                    f"| {_md_escape(c.client_name)} "
                    f"| {c.csv_row.tab} "
                    f"| `{_md_inline(c.current_value)}` "
                    f"| `{_md_inline(c.proposed_value)}` "
                    f"| {_md_escape(c.reason)} |"
                )
            lines.append("")
    lines.append("")

    # Tier 3.
    lines.append("## Tier 3 — Scott meeting items (defer auto-apply)")
    lines.append("")
    if not tier3:
        lines.append("_(none)_")
    else:
        by_field: dict[str, list[FieldChange]] = {}
        for c in tier3:
            by_field.setdefault(c.field, []).append(c)
        for field_name, items in by_field.items():
            lines.append(f"### {field_name} ({len(items)})")
            lines.append("")
            lines.append("| Client | Tab | Current | CSV value | Reason |")
            lines.append("|---|---|---|---|---|")
            for c in sorted(items, key=lambda r: r.client_name.lower()):
                lines.append(
                    f"| {_md_escape(c.client_name)} "
                    f"| {c.csv_row.tab} "
                    f"| `{_md_inline(c.current_value)}` "
                    f"| `{_md_inline(c.proposed_value)}` "
                    f"| {_md_escape(c.reason)} |"
                )
            lines.append("")
    lines.append("")

    # Unmatched.
    if diff.unmatched_rows:
        lines.append(f"## Unmatched CSV rows ({len(diff.unmatched_rows)})")
        lines.append("")
        lines.append("| Tab | CSV row | Name | Email |")
        lines.append("|---|---|---|---|")
        for row in sorted(diff.unmatched_rows, key=lambda r: r.name.lower()):
            lines.append(
                f"| {row.tab} | {row.csv_row_number} "
                f"| {_md_escape(row.name)} | {_md_escape(row.email or '(none)')} |"
            )
        lines.append("")

    # Name-ambiguous.
    if diff.name_ambiguous:
        lines.append(f"## Name-ambiguous CSV rows ({len(diff.name_ambiguous)})")
        lines.append("")
        for row in diff.name_ambiguous:
            lines.append(
                f"- **{_md_escape(row.name)}** ({row.tab} row {row.csv_row_number}, email={row.email or '(none)'}) — matches >1 Gregory client"
            )
        lines.append("")

    # Duplicate CSV emails.
    if diff.duplicate_csv_emails:
        lines.append(f"## Duplicate CSV emails ({len(diff.duplicate_csv_emails)})")
        lines.append("")
        for email, rows in diff.duplicate_csv_emails:
            lines.append(
                f"- `{email}` used by {len(rows)} rows: "
                + ", ".join(f"{r.name} ({r.tab} row {r.csv_row_number})" for r in rows)
            )
        lines.append("")

    return "\n".join(lines) + "\n"


def render_scott_notes_md(
    diff: DiffResult,
    post_apply_mismatches: list[FieldChange] | None = None,
    apply_summary: dict[str, int] | None = None,
    status_directives: list[FieldChange] | None = None,
) -> str:
    """Bucket A (pre-apply ambiguities) + Bucket B (post-apply
    mismatches, populated only after Phase 2 runs) + Quick reference
    (status directives applied)."""
    lines: list[str] = []
    tier3 = _tier_changes(diff, 3)
    tier2 = _tier_changes(diff, 2)

    lines.append("# M5 cleanup — Scott meeting notes")
    lines.append("")
    lines.append(f"Generated: `{diff.generated_at}`")
    lines.append("")
    if apply_summary is not None:
        lines.append(
            "_Apply phase ran. Counts: "
            + ", ".join(f"{k}={v}" for k, v in apply_summary.items())
            + "_"
        )
        lines.append("")

    # ---------- Bucket A ----------
    lines.append("## Bucket A — pre-apply ambiguities (Scott decides)")
    lines.append("")

    # A1. Blank / N/A status.
    blank_status = [c for c in tier3 if c.field == "status"]
    lines.append(f"### A1. Blank or N/A status ({len(blank_status)})")
    lines.append("")
    if blank_status:
        lines.append("| Client | Tab | Current Gregory | CSV value |")
        lines.append("|---|---|---|---|")
        for c in sorted(blank_status, key=lambda r: r.client_name.lower()):
            lines.append(
                f"| {_md_escape(c.client_name)} | {c.csv_row.tab} "
                f"| `{_md_inline(c.current_value)}` | `{_md_inline(c.proposed_value)}` |"
            )
        lines.append("")
    else:
        lines.append("_(none)_")
        lines.append("")

    # A2. Aleks-owned.
    aleks = [c for c in tier3 if c.field == "primary_csm"]
    lines.append(f"### A2. Aleks-owned rows ({len(aleks)})")
    lines.append("")
    if aleks:
        for c in sorted(aleks, key=lambda r: r.client_name.lower()):
            lines.append(
                f"- **{_md_escape(c.client_name)}** ({c.csv_row.tab}) — current owner `{_md_inline(c.current_value)}`"
            )
        lines.append("")
    else:
        lines.append("_(none)_")
        lines.append("")

    # A3. Name ambiguities.
    lines.append(f"### A3. Name-ambiguous CSV rows ({len(diff.name_ambiguous)})")
    lines.append("")
    if diff.name_ambiguous:
        for row in diff.name_ambiguous:
            lines.append(
                f"- **{_md_escape(row.name)}** ({row.tab} row {row.csv_row_number}, "
                f"email={row.email or '(none)'}) — matches >1 Gregory client"
            )
        lines.append("")
    else:
        lines.append("_(none)_")
        lines.append("")

    # A4. NPS Standing differences.
    nps_diffs = [c for c in tier3 if c.field == "nps_standing"]
    lines.append(f"### A4. NPS Standing CSV-vs-Gregory ({len(nps_diffs)})")
    lines.append("")
    lines.append(
        "_(Path 1 owns `clients.nps_standing`; CSV's NPS Standing column is Scott's read. "
        "Surfaced for eyeball — never auto-applied.)_"
    )
    lines.append("")
    if nps_diffs:
        lines.append("| Client | Tab | Gregory NPS Standing | CSV NPS Standing |")
        lines.append("|---|---|---|---|")
        for c in sorted(nps_diffs, key=lambda r: r.client_name.lower())[:50]:
            lines.append(
                f"| {_md_escape(c.client_name)} | {c.csv_row.tab} "
                f"| `{_md_inline(c.current_value)}` | `{_md_inline(c.proposed_value)}` |"
            )
        if len(nps_diffs) > 50:
            lines.append("")
            lines.append(
                f"_(...truncated; {len(nps_diffs) - 50} more — see full diff)_"
            )
        lines.append("")

    # A5. Owing Money + other Tier 2 standing.
    owing = [c for c in tier2 if c.field == "csm_standing"]
    lines.append(f'### A5. "Owing Money" / unparseable standing ({len(owing)})')
    lines.append("")
    if owing:
        for c in sorted(owing, key=lambda r: r.client_name.lower()):
            lines.append(
                f"- **{_md_escape(c.client_name)}** ({c.csv_row.tab}) — "
                f"CSV value `{_md_inline(c.proposed_value)}`, current Gregory `{_md_inline(c.current_value)}`"
            )
        lines.append("")
    else:
        lines.append("_(none)_")
        lines.append("")

    # A6. Handover unresolved.
    if diff.handover_unresolved:
        lines.append(
            f"### A6. Handover-note targets unresolved ({len(diff.handover_unresolved)})"
        )
        lines.append("")
        for name in diff.handover_unresolved:
            lines.append(f"- **{_md_escape(name)}**")
        lines.append("")

    # A7. Duplicate CSV emails.
    if diff.duplicate_csv_emails:
        lines.append(f"### A7. Duplicate CSV emails ({len(diff.duplicate_csv_emails)})")
        lines.append("")
        for email, rows in diff.duplicate_csv_emails:
            lines.append(
                f"- `{email}` — used by {len(rows)} rows: "
                + ", ".join(f"{r.name} ({r.tab} row {r.csv_row_number})" for r in rows)
            )
        lines.append("")

    # A8. Email mismatches surfaced as Tier 2 — handle per the M5.4
    # backfill runbook (per-client triage to alternate_emails).
    email_mismatches = [c for c in tier2 if c.field == "email"]
    if email_mismatches:
        lines.append(f"### A8. Email mismatches ({len(email_mismatches)})")
        lines.append("")
        lines.append(
            "_(CSV email differs from Gregory primary AND not in `alternate_emails`. "
            "Handle per `docs/archive/historical/backfill_nps_from_airtable.md` § Failure modes — "
            "per-client triage to alternate_emails. Don't bulk-apply.)_"
        )
        lines.append("")
        for c in sorted(email_mismatches, key=lambda r: r.client_name.lower()):
            lines.append(
                f"- **{_md_escape(c.client_name)}** ({c.csv_row.tab}) — "
                f"Gregory `{_md_inline(c.current_value)}`, CSV `{_md_inline(c.proposed_value)}`"
            )
        lines.append("")

    # A9 + A10. Unmatched CSV rows split by whether they have an email.
    # Drake's adjustment: rows with emails are likely real new clients
    # (manual create-or-merge); rows without emails are Scott-decision.
    if diff.unmatched_rows:
        with_email = [r for r in diff.unmatched_rows if r.email]
        without_email = [r for r in diff.unmatched_rows if not r.email]

        if with_email:
            lines.append(
                f"### A9. Unmatched CSV rows WITH email — likely new clients ({len(with_email)})"
            )
            lines.append("")
            lines.append(
                "_(These have emails but no matching Gregory client. Likely real "
                "new clients that need a manual create-or-merge decision.)_"
            )
            lines.append("")
            for row in sorted(with_email, key=lambda r: r.name.lower()):
                lines.append(
                    f"- **{_md_escape(row.name)}** ({row.tab} row {row.csv_row_number}) — "
                    f"email={row.email}, status={row.raw_status or '(blank)'}, owner={row.raw_owner or '(blank)'}"
                )
            lines.append("")

        if without_email:
            lines.append(
                f"### A10. Unmatched CSV rows WITHOUT email — Scott decision ({len(without_email)})"
            )
            lines.append("")
            lines.append(
                "_(No email in CSV — match-by-name failed. Scott decides whether each "
                "is a real client to create, a duplicate to merge, or noise to skip.)_"
            )
            lines.append("")
            for row in sorted(without_email, key=lambda r: r.name.lower()):
                lines.append(
                    f"- **{_md_escape(row.name)}** ({row.tab} row {row.csv_row_number}) — "
                    f"status={row.raw_status or '(blank)'}, owner={row.raw_owner or '(blank)'}"
                )
            lines.append("")

    # ---------- Bucket B ----------
    lines.append("## Bucket B — post-apply mismatches (Scott confirms)")
    lines.append("")
    if post_apply_mismatches is None:
        lines.append(
            "_(Phase 2 has not run yet. Run with `--apply` to populate this section.)_"
        )
        lines.append("")
    elif not post_apply_mismatches:
        lines.append("_(none — Gregory state matches CSV after apply)_")
        lines.append("")
    else:
        lines.append(
            "_(After applying Tier 1 changes, these fields still don't match the CSV. "
            "Most are cascade-introduced — the cascade overrides csm_standing / primary_csm "
            "/ toggles for negative-status transitions. Scott confirms each is correct.)_"
        )
        lines.append("")
        lines.append(
            "| Client | Field | Gregory (post-apply) | CSV value | Likely cause |"
        )
        lines.append("|---|---|---|---|---|")
        for c in sorted(post_apply_mismatches, key=lambda r: r.client_name.lower()):
            cause = c.reason or "unknown"
            lines.append(
                f"| {_md_escape(c.client_name)} | {c.field} "
                f"| `{_md_inline(c.current_value)}` "
                f"| `{_md_inline(c.proposed_value)}` "
                f"| {_md_escape(cause)} |"
            )
        lines.append("")

    # ---------- Quick reference ----------
    lines.append("## Quick reference — status directives applied")
    lines.append("")
    if status_directives is None:
        # Phase 1 mode: list all proposed Tier 1 status changes as the
        # directives that Scott's CSV implies.
        status_changes = [c for c in _tier_changes(diff, 1) if c.field == "status"]
    else:
        status_changes = status_directives
    if status_changes:
        lines.append(
            "_(Each row reflects one Tier 1 status flip from the CSV — these are the "
            "operational status decisions Scott has made between the previous master sheet "
            "import and this cleanup pass.)_"
        )
        lines.append("")
        lines.append("| Client | Tab | Was | Is now |")
        lines.append("|---|---|---|---|")
        for c in sorted(
            status_changes, key=lambda r: (str(r.proposed_value), r.client_name.lower())
        ):
            lines.append(
                f"| {_md_escape(c.client_name)} | {c.csv_row.tab} "
                f"| `{_md_inline(c.current_value)}` | `{_md_inline(c.proposed_value)}` |"
            )
        lines.append("")
    else:
        lines.append("_(no status flips proposed)_")
        lines.append("")

    return "\n".join(lines) + "\n"


def _md_escape(text: Any) -> str:
    if text is None:
        return ""
    s = str(text)
    return s.replace("|", "\\|").replace("\n", " ")


def _md_inline(text: Any) -> str:
    """Inline-code-escape: substitute backticks and clamp newlines."""
    if text is None:
        return "null"
    s = str(text).replace("`", "'").replace("\n", " ")
    return s


# ---------------------------------------------------------------------------
# Apply phase (Phase 2)
# ---------------------------------------------------------------------------


def apply_changes(
    db,
    diff: DiffResult,
    team_members_by_name: dict[str, str],
) -> tuple[dict[str, int], list[FieldChange]]:
    """Run the tiered apply pass. Returns (counts, post_apply_mismatches).

    Order: status → re-read → csm_standing → primary_csm → trustpilot →
    notes append. The re-read between status and csm_standing captures
    the cascade-set values so we don't overwrite a cascade-set 'at_risk'
    with a stale CSV-said-non-at_risk write that the cascade would just
    re-set.
    """
    counts: Counter[str] = Counter()
    tier1 = _tier_changes(diff, 1)

    # ---- 1. Status flips ----
    status_changes = [c for c in tier1 if c.field == "status"]
    print(f"[apply] {len(status_changes)} status flips...")
    for c in status_changes:
        if c.client_id is None:
            continue
        try:
            db.rpc(
                "update_client_status_with_history",
                {
                    "p_client_id": c.client_id,
                    "p_new_status": c.proposed_value,
                    "p_changed_by": GREGORY_BOT_UUID,
                    "p_note": RPC_NOTE,
                },
            ).execute()
            counts["status_applied"] += 1
        except Exception as exc:
            print(f"  ERR status {c.client_name}: {exc}")
            counts["status_errors"] += 1

    # ---- 2. Re-read affected client state ----
    affected_ids = {c.client_id for c in tier1 if c.client_id}
    if affected_ids:
        re_read = (
            db.table("clients")
            .select("id, status, csm_standing, trustpilot_status, notes")
            .in_("id", list(affected_ids))
            .execute()
        )
        post_status_state = {r["id"]: r for r in (re_read.data or [])}
    else:
        post_status_state = {}

    # Re-read primary_csm assignments too — cascade may have moved them.
    if affected_ids:
        re_assignments = (
            db.table("client_team_assignments")
            .select("client_id, team_member_id")
            .in_("client_id", list(affected_ids))
            .eq("role", "primary_csm")
            .is_("unassigned_at", "null")
            .execute()
        )
        post_status_primary = {
            r["client_id"]: r["team_member_id"] for r in (re_assignments.data or [])
        }
    else:
        post_status_primary = {}

    # ---- 3. csm_standing flips ----
    csm_changes = [c for c in tier1 if c.field == "csm_standing"]
    print(f"[apply] {len(csm_changes)} csm_standing flips (after re-read)...")
    for c in csm_changes:
        if c.client_id is None:
            continue
        post_state = post_status_state.get(c.client_id, {})
        # If post-cascade Gregory already matches CSV, no-op.
        if post_state.get("csm_standing") == c.proposed_value:
            counts["csm_already_match"] += 1
            continue
        try:
            db.rpc(
                "update_client_csm_standing_with_history",
                {
                    "p_client_id": c.client_id,
                    "p_new_csm_standing": c.proposed_value,
                    "p_changed_by": GREGORY_BOT_UUID,
                    "p_note": RPC_NOTE,
                },
            ).execute()
            counts["csm_applied"] += 1
        except Exception as exc:
            print(f"  ERR csm_standing {c.client_name}: {exc}")
            counts["csm_errors"] += 1

    # ---- 4. primary_csm reassignments ----
    primary_changes = [c for c in tier1 if c.field == "primary_csm"]
    print(f"[apply] {len(primary_changes)} primary_csm reassignments...")
    for c in primary_changes:
        if c.client_id is None:
            continue
        target_team_id = team_members_by_name.get(c.proposed_value)
        if target_team_id is None:
            counts["primary_csm_unresolved"] += 1
            continue
        # If post-cascade primary already matches CSV target, no-op.
        if post_status_primary.get(c.client_id) == target_team_id:
            counts["primary_csm_already_match"] += 1
            continue
        try:
            db.rpc(
                "change_primary_csm",
                {
                    "p_client_id": c.client_id,
                    "p_new_team_member_id": target_team_id,
                },
            ).execute()
            counts["primary_csm_applied"] += 1
        except Exception as exc:
            print(f"  ERR primary_csm {c.client_name}: {exc}")
            counts["primary_csm_errors"] += 1

    # ---- 5. Trustpilot direct UPDATE ----
    tp_changes = [c for c in tier1 if c.field == "trustpilot_status"]
    print(f"[apply] {len(tp_changes)} trustpilot flips...")
    for c in tp_changes:
        if c.client_id is None:
            continue
        try:
            db.table("clients").update({"trustpilot_status": c.proposed_value}).eq(
                "id", c.client_id
            ).execute()
            counts["trustpilot_applied"] += 1
        except Exception as exc:
            print(f"  ERR trustpilot {c.client_name}: {exc}")
            counts["trustpilot_errors"] += 1

    # ---- 6. Handover note appends ----
    print(f"[apply] {len(diff.handover_plans)} handover note appends...")
    for plan in diff.handover_plans:
        if plan.will_skip_idempotent:
            counts["handover_already_present"] += 1
            continue
        # Re-read current notes (may have changed if a client appears in
        # both diffs).
        latest = (
            db.table("clients")
            .select("notes")
            .eq("id", plan.client_id)
            .single()
            .execute()
        )
        current_notes = (latest.data or {}).get("notes") or ""
        if HANDOVER_NOTE in current_notes:
            counts["handover_already_present"] += 1
            continue
        if current_notes.strip():
            new_notes = current_notes + "\n\n" + HANDOVER_NOTE
        else:
            new_notes = HANDOVER_NOTE
        try:
            db.table("clients").update({"notes": new_notes}).eq(
                "id", plan.client_id
            ).execute()
            counts["handover_applied"] += 1
        except Exception as exc:
            print(f"  ERR handover {plan.client_name}: {exc}")
            counts["handover_errors"] += 1

    # ---- 7. Re-diff: build a list of post-apply mismatches ----
    post_apply_mismatches: list[FieldChange] = []
    if affected_ids:
        # Final re-read of everything that changed.
        final_state = (
            db.table("clients")
            .select("id, status, csm_standing, trustpilot_status, notes")
            .in_("id", list(affected_ids))
            .execute()
        )
        final_state_map = {r["id"]: r for r in (final_state.data or [])}
        final_assignments = (
            db.table("client_team_assignments")
            .select("client_id, team_member_id")
            .in_("client_id", list(affected_ids))
            .eq("role", "primary_csm")
            .is_("unassigned_at", "null")
            .execute()
        )
        final_primary = {
            r["client_id"]: r["team_member_id"] for r in (final_assignments.data or [])
        }
        for c in tier1:
            if c.client_id is None:
                continue
            final = final_state_map.get(c.client_id, {})
            if c.field == "primary_csm":
                final_team_id = final_primary.get(c.client_id)
                target = team_members_by_name.get(c.proposed_value)
                if target is not None and final_team_id != target:
                    cause = (
                        "cascade reassigned to Scott Chasing"
                        if final_team_id == SCOTT_CHASING_UUID
                        else "unknown"
                    )
                    post_apply_mismatches.append(
                        FieldChange(
                            csv_row=c.csv_row,
                            client_id=c.client_id,
                            client_name=c.client_name,
                            field=c.field,
                            current_value=_team_id_to_name(
                                final_team_id, team_members_by_name
                            ),
                            proposed_value=c.proposed_value,
                            tier=2,
                            reason=cause,
                        )
                    )
            elif c.field in ("status", "csm_standing", "trustpilot_status"):
                final_value = final.get(c.field)
                if final_value != c.proposed_value:
                    cause = ""
                    if c.field == "csm_standing" and final_value == "at_risk":
                        cause = "cascade overrode to at_risk"
                    elif c.field == "csm_standing":
                        cause = "override-blocked or apply error"
                    else:
                        cause = "apply error or unexpected state"
                    post_apply_mismatches.append(
                        FieldChange(
                            csv_row=c.csv_row,
                            client_id=c.client_id,
                            client_name=c.client_name,
                            field=c.field,
                            current_value=final_value,
                            proposed_value=c.proposed_value,
                            tier=2,
                            reason=cause,
                        )
                    )

    return dict(counts), post_apply_mismatches


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--apply", action="store_true", help="Run Tier 1 writes (default: dry-run)."
    )
    parser.add_argument("--usa-csv", type=Path, default=DEFAULT_USA_CSV)
    parser.add_argument("--aus-csv", type=Path, default=DEFAULT_AUS_CSV)
    parser.add_argument("--diff-out", type=Path, default=DEFAULT_DIFF_OUT)
    parser.add_argument("--notes-out", type=Path, default=DEFAULT_NOTES_OUT)
    args = parser.parse_args(argv)

    print("=" * 72)
    print(f"Mode: {'APPLY' if args.apply else 'DRY-RUN'}")
    print(f"USA CSV: {args.usa_csv}")
    print(f"AUS CSV: {args.aus_csv}")
    print("=" * 72)

    # Load CSVs.
    _, usa_rows = load_csv(args.usa_csv)
    _, aus_rows = load_csv(args.aus_csv)
    print(f"USA: {len(usa_rows)} data rows after blank-name filter")
    print(f"AUS: {len(aus_rows)} data rows after blank-name filter")
    csv_rows = usa_rows + aus_rows

    # Build resolver from cloud.
    db = get_client()
    print("Loading Gregory state...")
    resolver = build_resolver(db)
    team_by_name = load_team_members(db)
    active_primary = load_active_primary_csm(db)
    slack_channels = load_slack_channels_by_client(db)
    print(f"  {len(resolver.clients_by_id)} non-archived clients")
    print(f"  {len(team_by_name)} team_members")
    print(f"  {len(active_primary)} active primary_csm assignments")
    print(
        f"  {sum(len(v) for v in slack_channels.values())} non-archived slack_channels rows ({len(slack_channels)} clients have ≥1)"
    )

    # Phase 1 — diff.
    print("Computing diff...")
    diff = compute_diff(
        csv_rows,
        resolver,
        team_by_name,
        active_primary,
        slack_channels_by_client=slack_channels,
    )
    print(
        f"  Tier 1: {len(_tier_changes(diff, 1))}  "
        f"Tier 2: {len(_tier_changes(diff, 2))}  "
        f"Tier 3: {len(_tier_changes(diff, 3))}  "
        f"Cascade-redundant skips: {len(diff.redundant_with_cascade)}"
    )

    # Write Phase 1 outputs (always).
    args.diff_out.parent.mkdir(parents=True, exist_ok=True)
    args.diff_out.write_text(render_diff_md(diff))
    print(f"Wrote diff:        {args.diff_out}")

    notes_text = render_scott_notes_md(diff)
    args.notes_out.write_text(notes_text)
    print(f"Wrote scott_notes: {args.notes_out}")

    if not args.apply:
        print()
        print("Dry-run complete. Re-run with --apply to execute Tier 1 writes.")
        return 0

    # Phase 2 — apply.
    print()
    print("=" * 72)
    print("APPLYING Tier 1 changes...")
    print("=" * 72)
    apply_counts, post_apply_mismatches = apply_changes(db, diff, team_by_name)

    print()
    print("Apply summary:")
    for k, v in sorted(apply_counts.items()):
        print(f"  {k:<28}  {v}")

    # Re-write scott_notes with post-apply Bucket B populated.
    notes_text = render_scott_notes_md(
        diff,
        post_apply_mismatches=post_apply_mismatches,
        apply_summary=apply_counts,
        status_directives=[c for c in _tier_changes(diff, 1) if c.field == "status"],
    )
    args.notes_out.write_text(notes_text)
    print(f"Updated scott_notes with Bucket B: {args.notes_out}")

    if post_apply_mismatches:
        print(
            f"\n{len(post_apply_mismatches)} post-apply mismatches "
            f"surfaced to Bucket B (mostly cascade-introduced; verify in scott_notes)."
        )
    else:
        print("\nNo post-apply mismatches — Gregory matches CSV.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
