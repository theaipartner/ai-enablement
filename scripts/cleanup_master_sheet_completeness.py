"""Master sheet completeness pass — autocreate unmatched + fill crucial gaps.

Sibling to `cleanup_master_sheet_reconcile.py`. Where the reconcile
script handles deltas (status/csm_standing/trustpilot/primary_csm
flips) on already-matched clients, this script closes the remaining
two gaps:

  1. Autocreate the unmatched CSV rows so every row resolves to a
     Gregory client. Zero unmatched at end of run.
  2. Fill NULL gaps in crucial fields where CSV has a value. Crucial
     fields covered here (the subset reconcile doesn't already
     handle):
        - full_name   (replace only if missing — extremely rare)
        - email       (replace if Gregory ends in '@placeholder.invalid')
        - phone       (NULL → CSV)
        - slack_user_id (NULL → CSV, UNIQUE collision aware)
        - slack_channels insert (zero rows → CSV's channel id)
        - start_date  (NULL → CSV)
        - country     (NULL → 'USA' or 'AUS' per CSV tab)

We fill gaps; we do NOT overwrite Gregory values that are already
non-null. The `@placeholder.invalid` email replacement is the one
exception — those are synthesized stubs from `import_master_sheet.py`
that should be replaced with real CSV emails.

Status/csm_standing/trustpilot_status/primary_csm flips on matched
clients live in `cleanup_master_sheet_reconcile.py`. Run that first;
this script after.

ATTRIBUTION

  - All RPC calls + INSERTs use Gregory Bot UUID as the actor.
  - History rows carry note='cleanup:m5_completeness'.
  - Autocreated `clients` rows carry:
        metadata.created_via = 'm5_cleanup_completeness'
        metadata.original_master_sheet_status = '<raw CSV status>'
            (preserved as the literal CSV string — useful forensics
             for the 4 N/A rows that get coerced to status='churned')

USAGE

  # Dry-run (default)
  .venv/bin/python scripts/cleanup_master_sheet_completeness.py

  # Apply
  .venv/bin/python scripts/cleanup_master_sheet_completeness.py --apply

Outputs:
  - docs/data/m5_completeness_diff.md (always, on every run)
  - docs/data/m5_cleanup_scott_notes.md APPENDED with a "Completeness
    pass" section (only when --apply has run; the section captures the
    actual create/fill counts + any anomalies surfaced)
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402

from scripts.cleanup_master_sheet_reconcile import (  # noqa: E402
    DEFAULT_AUS_CSV,
    DEFAULT_USA_CSV,
    GREGORY_BOT_UUID,
    CsvRow,
    build_resolver,
    load_active_primary_csm,
    load_csv,
    load_slack_channels_by_client,
    load_team_members,
    normalize_csm_standing,
    normalize_owner,
    normalize_status,
    normalize_trustpilot,
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

RPC_NOTE = "cleanup:m5_completeness"
CREATED_VIA = "m5_cleanup_completeness"

DEFAULT_DIFF_OUT = _REPO_ROOT / "docs/data/m5_completeness_diff.md"
DEFAULT_NOTES_OUT = _REPO_ROOT / "docs/data/m5_cleanup_scott_notes.md"

PLACEHOLDER_EMAIL_SUFFIX = "@placeholder.invalid"


# ---------------------------------------------------------------------------
# Date parsing — mirror import_master_sheet.py.parse_date
# ---------------------------------------------------------------------------


def parse_csv_date(raw: str | None) -> date | None:
    """Master sheet dates: M/D/YYYY (e.g. '6/12/2025'). Tolerates
    leading-zero stripping + 2-digit years. AUS file has values like
    '11/16/25' (last data row) which need %y handling."""
    if not raw or not raw.strip():
        return None
    text = raw.strip()
    for fmt in ("%m/%d/%Y", "%-m/%-d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def synthesize_placeholder_email(name: str) -> str:
    """Mirror import_master_sheet.py's placeholder synthesis. Used when
    a Tier 3 (N/A status) autocreate has no CSV email."""
    slug = name.strip().lower().replace(" ", "_") or "unknown"
    # Strip non-alphanumeric/underscore/dot/hyphen so the placeholder is
    # well-formed even for edge-case names (e.g., trailing punctuation).
    slug = "".join(c for c in slug if c.isalnum() or c in ("_", ".", "-"))
    if not slug:
        slug = "unknown"
    return f"{slug}+import{PLACEHOLDER_EMAIL_SUFFIX}"


# ---------------------------------------------------------------------------
# Plan dataclasses
# ---------------------------------------------------------------------------


@dataclass
class AutocreatePlan:
    """One unmatched CSV row → new Gregory client."""

    csv_row: CsvRow
    full_name: str
    email: str  # real or synthesized placeholder
    email_is_placeholder: bool
    status: str  # post-normalization (N/A → 'churned' per spec)
    raw_status_for_metadata: str  # exact CSV string preserved
    csm_standing: str | None
    trustpilot_status: str | None
    slack_user_id: str | None
    slack_channel_id: str | None
    phone: str | None
    start_date: date | None
    country: str  # 'USA' or 'AUS'
    primary_csm_team_member_id: str | None
    notes: list[str] = field(default_factory=list)


@dataclass
class FillGapPlan:
    """One existing Gregory client → fill NULL crucial fields from CSV."""

    csv_row: CsvRow
    client_id: str
    client_name: str
    fills: dict[str, Any]  # column_name → new value (only for fields actually filling)
    placeholder_email_replacement: tuple[str, str] | None  # (old, new) when applicable
    insert_slack_channel: (
        tuple[str, str] | None
    )  # (channel_id, csv_name) when applicable
    country_conflict: (
        tuple[str, str] | None
    )  # (current, proposed) — surfaces to anomalies
    slack_user_id_collision: (
        tuple[str, str] | None
    )  # (existing_owner_client_name, csv_user_id)


@dataclass
class CompletenessPlan:
    """Aggregate plan for the whole run."""

    autocreates: list[AutocreatePlan]
    fills: list[FillGapPlan]
    anomalies: list[str]  # human-readable strings for scott_notes
    generated_at: str


# ---------------------------------------------------------------------------
# Plan generation
# ---------------------------------------------------------------------------


def _country_for_tab(tab: str) -> str:
    return {"USA": "USA", "AUS": "AUS"}.get(tab, tab)


def _resolve_owner_to_team_id(
    raw_owner: str, team_members_by_name: dict[str, str]
) -> str | None:
    full_name, owner_class = normalize_owner(raw_owner)
    if owner_class != "clean" or full_name is None:
        return None
    return team_members_by_name.get(full_name)


def build_autocreate_plan(
    row: CsvRow, team_members_by_name: dict[str, str]
) -> AutocreatePlan:
    """For an unmatched row, build the autocreate payload.

    N/A statuses → 'churned' per spec. The literal CSV string is
    preserved on metadata.original_master_sheet_status for forensics."""
    status_value, status_is_skip = normalize_status(row.raw_status)
    raw_status_str = row.raw_status.strip() if row.raw_status else ""
    if status_value is None:
        # N/A or blank — coerce to 'churned' for the autocreate; real
        # CSV string preserved in metadata.
        coerced_status = "churned"
    else:
        coerced_status = status_value

    csm_value, _ = normalize_csm_standing(row.raw_standing)
    tp_value, _ = normalize_trustpilot(row.raw_trustpilot)

    # Email: real if present, else placeholder.
    if row.email:
        email = row.email
        email_is_placeholder = False
    else:
        email = synthesize_placeholder_email(row.name)
        email_is_placeholder = True

    primary_csm_id = _resolve_owner_to_team_id(row.raw_owner, team_members_by_name)

    return AutocreatePlan(
        csv_row=row,
        full_name=row.name.strip(),
        email=email,
        email_is_placeholder=email_is_placeholder,
        status=coerced_status,
        raw_status_for_metadata=raw_status_str,
        csm_standing=csm_value,
        trustpilot_status=tp_value,
        slack_user_id=row.slack_user_id or None,
        slack_channel_id=row.slack_channel_id or None,
        phone=row.phone or None,
        start_date=parse_csv_date(row.raw_date),
        country=_country_for_tab(row.tab),
        primary_csm_team_member_id=primary_csm_id,
    )


def build_fill_gap_plan(
    row: CsvRow,
    client_id: str,
    current_client: dict[str, Any],
    slack_channels_by_client: dict[str, list[str]],
    db,
) -> FillGapPlan | None:
    """Compute NULL-only fills for one matched client. Returns None if
    nothing to do."""
    fills: dict[str, Any] = {}
    placeholder_replacement: tuple[str, str] | None = None
    insert_channel: tuple[str, str] | None = None
    country_conflict: tuple[str, str] | None = None
    slack_user_id_collision: tuple[str, str] | None = None

    # Email: replace `@placeholder.invalid` if CSV has a real email.
    current_email = current_client.get("email") or ""
    if (
        row.email
        and current_email.endswith(PLACEHOLDER_EMAIL_SUFFIX)
        and row.email != current_email
    ):
        fills["email"] = row.email
        placeholder_replacement = (current_email, row.email)

    # Phone (fill NULL only).
    if row.phone and not current_client.get("phone"):
        fills["phone"] = row.phone

    # Slack user id (fill NULL only). UNIQUE collision-aware: check if
    # another client already owns the CSV's slack_user_id.
    if row.slack_user_id and not current_client.get("slack_user_id"):
        existing = (
            db.table("clients")
            .select("id, full_name")
            .eq("slack_user_id", row.slack_user_id)
            .is_("archived_at", "null")
            .execute()
        )
        if existing.data:
            other = existing.data[0]
            if other["id"] != client_id:
                slack_user_id_collision = (
                    other.get("full_name") or "(unknown)",
                    row.slack_user_id,
                )
            # else: someone else's row matched ours via slack_user_id —
            # shouldn't happen since we checked Gregory NULL above, but
            # defensive
        else:
            fills["slack_user_id"] = row.slack_user_id

    # start_date (fill NULL only). Parsed from CSV's Date column.
    csv_date = parse_csv_date(row.raw_date)
    if csv_date and not current_client.get("start_date"):
        fills["start_date"] = csv_date.isoformat()

    # Country (fill NULL only; surface conflicts).
    proposed_country = _country_for_tab(row.tab)
    current_country = current_client.get("country")
    if current_country is None or current_country == "":
        fills["country"] = proposed_country
    elif current_country.strip().upper() != proposed_country.upper():
        country_conflict = (current_country, proposed_country)

    # Slack channels insert (only when client has zero existing channels).
    if row.slack_channel_id:
        existing_channels = slack_channels_by_client.get(client_id) or []
        if not existing_channels:
            insert_channel = (row.slack_channel_id, row.name.strip())

    if (
        not fills
        and not insert_channel
        and not country_conflict
        and not slack_user_id_collision
    ):
        return None

    return FillGapPlan(
        csv_row=row,
        client_id=client_id,
        client_name=current_client.get("full_name") or row.name,
        fills=fills,
        placeholder_email_replacement=placeholder_replacement,
        insert_slack_channel=insert_channel,
        country_conflict=country_conflict,
        slack_user_id_collision=slack_user_id_collision,
    )


def compute_completeness(
    csv_rows: list[CsvRow],
    resolver,
    team_members_by_name: dict[str, str],
    slack_channels_by_client: dict[str, list[str]],
    db,
) -> CompletenessPlan:
    autocreates: list[AutocreatePlan] = []
    fills: list[FillGapPlan] = []
    anomalies: list[str] = []

    # Email duplicate check across CSV — same email used by two CSV rows
    # would cause email-key UNIQUE collision on autocreate.
    email_to_rows: dict[str, list[CsvRow]] = {}
    for row in csv_rows:
        if row.email:
            email_to_rows.setdefault(row.email, []).append(row)

    for row in csv_rows:
        # Drake-row silent-skip — same as the reconcile script.
        if row.tab == "USA" and row.name.strip().lower() == "drake":
            continue

        client_id, method = resolver.lookup(row.email, row.name)

        if method == "name_ambiguous":
            anomalies.append(
                f"Name-ambiguous match for {row.name!r} ({row.tab} row {row.csv_row_number}, "
                f"email={row.email or '(none)'}) — completeness pass skips. "
                "Resolve via reconcile script's name_ambiguous bucket."
            )
            continue

        if client_id is None:
            # Unmatched → autocreate.
            plan = build_autocreate_plan(row, team_members_by_name)
            # Email collision against another autocreate?
            if row.email and len(email_to_rows.get(row.email, [])) > 1:
                plan.notes.append(
                    f"CSV-side email duplicate: {row.email} used by "
                    f"{len(email_to_rows[row.email])} rows; this autocreate may collide"
                )
            autocreates.append(plan)
            continue

        # Matched → fill-gap pass.
        current = resolver.clients_by_id.get(client_id, {})
        fill_plan = build_fill_gap_plan(
            row, client_id, current, slack_channels_by_client, db
        )
        if fill_plan is not None:
            fills.append(fill_plan)
            if fill_plan.country_conflict is not None:
                cur, prop = fill_plan.country_conflict
                anomalies.append(
                    f"Country conflict: {fill_plan.client_name} — Gregory has "
                    f"{cur!r}, CSV implies {prop!r} ({row.tab} tab). Skipping fill; "
                    "leave manual."
                )
            if fill_plan.slack_user_id_collision is not None:
                other_name, uid = fill_plan.slack_user_id_collision
                anomalies.append(
                    f"slack_user_id collision: {fill_plan.client_name} CSV says "
                    f"{uid}, but {other_name!r} already owns that slack_user_id. "
                    "Skipping fill; existing client wins."
                )

    return CompletenessPlan(
        autocreates=autocreates,
        fills=fills,
        anomalies=anomalies,
        generated_at=datetime.now(timezone.utc).isoformat(),
    )


# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------


def apply_plan(
    db,
    plan: CompletenessPlan,
    team_members_by_name: dict[str, str],
) -> dict[str, int]:
    counts: Counter[str] = Counter()
    now_iso = datetime.now(timezone.utc).isoformat()

    # ---- Autocreates ----
    for ac in plan.autocreates:
        try:
            payload = {
                "full_name": ac.full_name,
                "email": ac.email,
                "status": ac.status,
                "country": ac.country,
                "metadata": {
                    "created_via": CREATED_VIA,
                    "created_at": now_iso,
                    "original_master_sheet_status": ac.raw_status_for_metadata,
                },
            }
            if ac.phone:
                payload["phone"] = ac.phone
            if ac.slack_user_id:
                payload["slack_user_id"] = ac.slack_user_id
            if ac.csm_standing:
                payload["csm_standing"] = ac.csm_standing
            if ac.trustpilot_status:
                payload["trustpilot_status"] = ac.trustpilot_status
            if ac.start_date:
                payload["start_date"] = ac.start_date.isoformat()
            resp = db.table("clients").insert(payload).execute()
            new_id = resp.data[0]["id"]
            counts["autocreated"] += 1
            if ac.email_is_placeholder:
                counts["autocreated_with_placeholder_email"] += 1

            # csm_standing history seed (the dashboard expects rows here).
            if ac.csm_standing:
                db.table("client_standing_history").insert(
                    {
                        "client_id": new_id,
                        "csm_standing": ac.csm_standing,
                        "changed_by": GREGORY_BOT_UUID,
                        "note": RPC_NOTE,
                    }
                ).execute()
                counts["standing_history_seeded"] += 1

            # status history seed.
            db.table("client_status_history").insert(
                {
                    "client_id": new_id,
                    "status": ac.status,
                    "changed_by": GREGORY_BOT_UUID,
                    "note": RPC_NOTE,
                }
            ).execute()
            counts["status_history_seeded"] += 1

            # primary_csm assignment.
            if ac.primary_csm_team_member_id:
                db.table("client_team_assignments").insert(
                    {
                        "client_id": new_id,
                        "team_member_id": ac.primary_csm_team_member_id,
                        "role": "primary_csm",
                        "metadata": {"created_via": CREATED_VIA},
                    }
                ).execute()
                counts["primary_csm_assigned"] += 1

            # slack_channels insert.
            if ac.slack_channel_id:
                _ensure_slack_channel(
                    db, ac.slack_channel_id, new_id, ac.full_name, counts, plan
                )
        except Exception as exc:
            msg = str(exc)
            if "duplicate key" in msg.lower() or "23505" in msg:
                plan.anomalies.append(
                    f"Autocreate UNIQUE collision for {ac.full_name!r} "
                    f"(email={ac.email}): {msg.splitlines()[0]}"
                )
                counts["autocreate_collisions"] += 1
            else:
                plan.anomalies.append(
                    f"Autocreate failed for {ac.full_name!r}: {msg.splitlines()[0]}"
                )
                counts["autocreate_errors"] += 1

    # ---- Fills ----
    for fp in plan.fills:
        if fp.fills:
            try:
                db.table("clients").update(fp.fills).eq("id", fp.client_id).execute()
                for col in fp.fills.keys():
                    counts[f"filled_{col}"] += 1
                if fp.placeholder_email_replacement is not None:
                    counts["placeholder_email_replaced"] += 1
            except Exception as exc:
                plan.anomalies.append(
                    f"Fill failed for {fp.client_name!r}: {str(exc).splitlines()[0]}"
                )
                counts["fill_errors"] += 1
        if fp.insert_slack_channel is not None:
            channel_id, channel_name = fp.insert_slack_channel
            _ensure_slack_channel(
                db, channel_id, fp.client_id, channel_name, counts, plan
            )

    return dict(counts)


def _ensure_slack_channel(
    db,
    slack_channel_id: str,
    client_id: str,
    name_hint: str,
    counts: Counter[str],
    plan: CompletenessPlan,
) -> None:
    """Insert or reattach a slack_channels row.

    Three cases:
      1) No row with this slack_channel_id → INSERT new.
      2) Row exists with client_id IS NULL → UPDATE client_id.
      3) Row exists with client_id pointing elsewhere → leave alone,
         surface to anomalies (existing link wins).
    """
    existing = (
        db.table("slack_channels")
        .select("id, client_id")
        .eq("slack_channel_id", slack_channel_id)
        .execute()
    )
    if not existing.data:
        try:
            db.table("slack_channels").insert(
                {
                    "slack_channel_id": slack_channel_id,
                    "name": name_hint,
                    "is_private": False,
                    "is_archived": False,
                    "client_id": client_id,
                    "passive_monitoring_enabled": False,
                    "metadata": {"created_via": CREATED_VIA},
                }
            ).execute()
            counts["slack_channels_inserted"] += 1
        except Exception as exc:
            plan.anomalies.append(
                f"slack_channels insert failed for {slack_channel_id} "
                f"→ {name_hint}: {str(exc).splitlines()[0]}"
            )
            counts["slack_channel_insert_errors"] += 1
        return

    existing_row = existing.data[0]
    if existing_row.get("client_id") is None:
        db.table("slack_channels").update({"client_id": client_id}).eq(
            "id", existing_row["id"]
        ).execute()
        counts["slack_channels_relinked"] += 1
        return

    if existing_row.get("client_id") != client_id:
        plan.anomalies.append(
            f"slack_channels {slack_channel_id} already linked to a different "
            f"client_id ({existing_row.get('client_id')}); CSV says it should "
            f"belong to client {client_id} ({name_hint}). Skipping; existing "
            "link wins."
        )
        counts["slack_channels_link_conflicts"] += 1


# ---------------------------------------------------------------------------
# Output rendering
# ---------------------------------------------------------------------------


def render_diff_md(
    plan: CompletenessPlan, applied: bool, counts: dict[str, int] | None
) -> str:
    lines: list[str] = []
    lines.append("# M5 cleanup — completeness diff")
    lines.append("")
    lines.append(f"Generated: `{plan.generated_at}`")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- Autocreates planned: **{len(plan.autocreates)}**")
    lines.append(f"- Fill-gap plans: **{len(plan.fills)}**")
    lines.append(f"- Anomalies: **{len(plan.anomalies)}**")
    if applied and counts is not None:
        lines.append("")
        lines.append("**Applied counts:**")
        for k, v in sorted(counts.items()):
            lines.append(f"  - `{k}`: {v}")
    lines.append("")

    # Autocreates table.
    lines.append(f"## Autocreates ({len(plan.autocreates)})")
    lines.append("")
    if not plan.autocreates:
        lines.append("_(none)_")
    else:
        lines.append(
            "| Name | Tab | CSV row | Email | Email synth? | Status (CSV → Gregory) | Country | Owner |"
        )
        lines.append("|---|---|---|---|---|---|---|---|")
        for ac in plan.autocreates:
            owner_label = (
                _team_id_to_name(ac.primary_csm_team_member_id, plan)
                if ac.primary_csm_team_member_id
                else "(no owner)"
            )
            email_synth = "yes (placeholder)" if ac.email_is_placeholder else "no"
            status_label = (
                f"`{ac.raw_status_for_metadata or '(blank)'}` → `{ac.status}`"
            )
            lines.append(
                f"| {ac.full_name} | {ac.csv_row.tab} | {ac.csv_row.csv_row_number} "
                f"| {ac.email} | {email_synth} | {status_label} "
                f"| {ac.country} | {owner_label} |"
            )
    lines.append("")

    # Fill-gap detail (only those that have actual fills/inserts).
    lines.append(f"## Fill-gap plans ({len(plan.fills)})")
    lines.append("")
    if not plan.fills:
        lines.append("_(none — every matched client already has all crucial fields)_")
    else:
        # Per-field count.
        per_field: Counter[str] = Counter()
        placeholder_replacements = 0
        channel_inserts = 0
        country_conflicts_count = 0
        slack_user_id_collisions = 0
        for fp in plan.fills:
            for col in fp.fills.keys():
                per_field[col] += 1
            if fp.placeholder_email_replacement is not None:
                placeholder_replacements += 1
            if fp.insert_slack_channel is not None:
                channel_inserts += 1
            if fp.country_conflict is not None:
                country_conflicts_count += 1
            if fp.slack_user_id_collision is not None:
                slack_user_id_collisions += 1

        lines.append("**Counts per field:**")
        lines.append("")
        for col, ct in sorted(per_field.items()):
            lines.append(f"- `{col}`: {ct}")
        lines.append(
            f"- `slack_channels` inserts (zero-row clients): {channel_inserts}"
        )
        lines.append(
            f"- `placeholder.invalid` replacements (subset of email fills): {placeholder_replacements}"
        )
        lines.append(
            f"- `country` conflicts (skipped fills): {country_conflicts_count}"
        )
        lines.append(
            f"- `slack_user_id` collisions (skipped fills): {slack_user_id_collisions}"
        )
        lines.append("")

        # Detail table.
        lines.append("**Per-client fill detail:**")
        lines.append("")
        lines.append("| Client | Tab | Fills | Channel insert | Anomalies |")
        lines.append("|---|---|---|---|---|")
        for fp in sorted(plan.fills, key=lambda r: r.client_name.lower()):
            fill_summary = ", ".join(f"{k}={v!r}" for k, v in fp.fills.items()) or "—"
            channel_summary = (
                f"{fp.insert_slack_channel[0]}" if fp.insert_slack_channel else "—"
            )
            anom_parts = []
            if fp.country_conflict is not None:
                anom_parts.append(
                    f"country conflict ({fp.country_conflict[0]} vs {fp.country_conflict[1]})"
                )
            if fp.slack_user_id_collision is not None:
                anom_parts.append(
                    f"slack_user_id owned by {fp.slack_user_id_collision[0]}"
                )
            anom_summary = "; ".join(anom_parts) or "—"
            lines.append(
                f"| {fp.client_name} | {fp.csv_row.tab} "
                f"| {_md_inline(fill_summary)} | {channel_summary} | {_md_inline(anom_summary)} |"
            )
    lines.append("")

    # Anomalies list.
    lines.append(f"## Anomalies ({len(plan.anomalies)})")
    lines.append("")
    if not plan.anomalies:
        lines.append("_(none)_")
    else:
        for a in plan.anomalies:
            lines.append(f"- {_md_escape(a)}")
    lines.append("")

    return "\n".join(lines) + "\n"


def append_to_scott_notes(
    notes_path: Path, plan: CompletenessPlan, counts: dict[str, int]
) -> None:
    """Append a 'Completeness pass' section to the existing scott_notes."""
    if not notes_path.exists():
        return
    existing = notes_path.read_text()
    addendum: list[str] = []
    addendum.append("")
    addendum.append("---")
    addendum.append("")
    addendum.append("## Completeness pass — applied")
    addendum.append("")
    addendum.append(f"Generated: `{plan.generated_at}`")
    addendum.append("")
    addendum.append(
        f"- Autocreates: **{counts.get('autocreated', 0)}** "
        f"(of which {counts.get('autocreated_with_placeholder_email', 0)} got placeholder emails)"
    )
    addendum.append(
        "- Fill-gap field updates: "
        + ", ".join(
            f"`{k.replace('filled_', '')}`={v}"
            for k, v in sorted(counts.items())
            if k.startswith("filled_")
        )
        or "- Fill-gap field updates: (none)"
    )
    addendum.append(
        f"- `slack_channels` inserts: {counts.get('slack_channels_inserted', 0)}; "
        f"relinks (NULL → client_id): {counts.get('slack_channels_relinked', 0)}; "
        f"conflicts: {counts.get('slack_channels_link_conflicts', 0)}"
    )
    addendum.append(f"- Country fills: {counts.get('filled_country', 0)}")
    addendum.append(
        f"- Placeholder email replacements: {counts.get('placeholder_email_replaced', 0)}"
    )
    if plan.anomalies:
        addendum.append("")
        addendum.append(f"### Completeness anomalies ({len(plan.anomalies)})")
        addendum.append("")
        for a in plan.anomalies:
            addendum.append(f"- {a}")
    addendum.append("")
    notes_path.write_text(existing + "\n".join(addendum))


def _team_id_to_name(team_id: str | None, plan: CompletenessPlan) -> str:
    # Resolved at render time via team_members_by_name in main; here we
    # store team_member_id directly. Render via global lookup.
    return _GLOBAL_TEAM_BY_ID.get(team_id or "", team_id or "(none)")


_GLOBAL_TEAM_BY_ID: dict[str, str] = {}


def _md_escape(text: Any) -> str:
    if text is None:
        return ""
    return str(text).replace("|", "\\|").replace("\n", " ")


def _md_inline(text: Any) -> str:
    if text is None:
        return "null"
    return str(text).replace("`", "'").replace("\n", " ")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--apply", action="store_true")
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

    _, usa_rows = load_csv(args.usa_csv)
    _, aus_rows = load_csv(args.aus_csv)
    print(f"USA: {len(usa_rows)} data rows")
    print(f"AUS: {len(aus_rows)} data rows")
    csv_rows = usa_rows + aus_rows

    db = get_client()
    print("Loading Gregory state...")
    resolver = build_resolver(db)
    team_by_name = load_team_members(db)
    _ = load_active_primary_csm(db)
    slack_channels = load_slack_channels_by_client(db)

    # Populate the global team-id-to-name reverse map for diff render.
    _GLOBAL_TEAM_BY_ID.clear()
    for name, tid in team_by_name.items():
        _GLOBAL_TEAM_BY_ID[tid] = name

    print(f"  {len(resolver.clients_by_id)} non-archived clients")
    print(f"  {len(team_by_name)} team_members")
    print(
        f"  {sum(len(v) for v in slack_channels.values())} non-archived slack_channels"
    )

    print("Computing completeness plan...")
    plan = compute_completeness(csv_rows, resolver, team_by_name, slack_channels, db)
    print(
        f"  Autocreates: {len(plan.autocreates)}  "
        f"Fills: {len(plan.fills)}  "
        f"Anomalies: {len(plan.anomalies)}"
    )

    counts: dict[str, int] = {}
    if args.apply:
        print()
        print("=" * 72)
        print("APPLYING completeness pass...")
        print("=" * 72)
        counts = apply_plan(db, plan, team_by_name)
        print()
        print("Apply summary:")
        for k, v in sorted(counts.items()):
            print(f"  {k:<40}  {v}")

    args.diff_out.parent.mkdir(parents=True, exist_ok=True)
    args.diff_out.write_text(render_diff_md(plan, applied=args.apply, counts=counts))
    print(f"Wrote diff: {args.diff_out}")

    if args.apply:
        append_to_scott_notes(args.notes_out, plan, counts)
        print(f"Appended to scott_notes: {args.notes_out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
