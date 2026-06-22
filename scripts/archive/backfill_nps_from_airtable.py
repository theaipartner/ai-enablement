"""One-shot backfill: Airtable NPS Survery → Gregory's clients.nps_standing.

Walks every row in the Airtable NPS Survery table, groups by linked
NPS Clients record, picks the latest Survey Date per group, then calls
the production receiver (api/airtable_nps_webhook.py) over HTTP for
each surviving row. Same code path as Airtable's own automation —
same audit trail, same override-sticky semantics, same RPC.

This is a ONE-SHOT script. Path 1 receiver is live and Airtable's
automation auto-fires for new submissions; this script only fills
in the historical gap. If you need it again (e.g. Airtable schema
changes), edit the constants at the top and re-run.

Idempotent. Re-running processes the same set of (latest-per-client)
rows. The receiver's RPC is idempotent on csm_standing (override-sticky,
no-op when value unchanged) and effectively idempotent on nps_standing
(value-write, same value lands the same value). Re-runs land identical
end states modulo extra webhook_deliveries audit rows.

Usage:
    .venv/bin/python scripts/backfill_nps_from_airtable.py            # dry-run
    .venv/bin/python scripts/backfill_nps_from_airtable.py --apply
    .venv/bin/python scripts/backfill_nps_from_airtable.py --apply --limit 3

Default mode is dry-run — prints what WOULD be sent, makes no requests.
--apply fires actual POSTs to the receiver. --limit N caps the number
of CLIENTS (after dedup) processed; useful for smoke testing.

Env vars (loaded from .env.local):
  AIRTABLE_API_KEY              — read access to the CSM base
  AIRTABLE_NPS_WEBHOOK_SECRET   — auth header for the receiver
  RECEIVER_URL                  — optional override; defaults to prod

Runbook: docs/runbooks/backfill_nps_from_airtable.md
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv
load_dotenv(_REPO / ".env.local")

try:
    from pyairtable import Api
except ImportError:
    print(
        "ERR: pyairtable not installed. Run: "
        ".venv/bin/pip install -e '.[scripts]'",
        file=sys.stderr,
    )
    sys.exit(1)


# ---------------------------------------------------------------------------
# Constants — discovered via Airtable metadata API probe (M5.4 follow-up)
# ---------------------------------------------------------------------------

BASE_ID = "appSn7Oiit9dFEWb6"
NPS_SURVERY_TABLE = "tbl5KW3o3jhdxvASz"   # sic: "Survery" matches Airtable
NPS_CLIENTS_TABLE = "tbllKMffVeoO1jmef"

PROD_RECEIVER_URL = (
    "https://ai-enablement-sigma.vercel.app/api/airtable_nps_webhook"
)

# Polite pacing between receiver calls. Vercel cold starts + Airtable
# rate limits combined comfortably below 5 req/sec — ~200ms keeps us at
# ~5 req/sec ceiling.
INTER_REQUEST_SLEEP_SECONDS = 0.2


# ---------------------------------------------------------------------------
# Outcome buckets — every survey row lands in exactly one bucket
# ---------------------------------------------------------------------------


class Report:
    """Outcome counters + per-bucket detail captured during the run."""

    def __init__(self) -> None:
        self.total_survery_rows = 0
        self.distinct_clients = 0
        self.skipped_no_link: list[str] = []           # Survery row id → no NPS Clients linked
        self.skipped_ambiguous_link: list[str] = []    # Survery row id → >1 linked
        self.skipped_no_segment: list[str] = []        # Survery row id → empty Segment Classification
        self.skipped_no_email: list[str] = []          # Survery row id → linked client has no Email
        self.sent_success: list[tuple[str, str, dict]] = []  # (client_name, segment, receiver_body)
        self.sent_404_client_not_found: list[tuple[str, str, str]] = []  # (client_name, email, segment)
        self.sent_other_error: list[tuple[str, str, int, str]] = []      # (client_name, email, status, body_preview)

    def print_summary(self) -> None:
        print()
        print("=" * 72)
        print("Backfill report")
        print("=" * 72)
        print(f"Total NPS Survery rows:          {self.total_survery_rows}")
        print(f"Distinct clients (after dedup):  {self.distinct_clients}")
        print()
        print(f"  skipped_no_link:           {len(self.skipped_no_link)}")
        print(f"  skipped_ambiguous_link:    {len(self.skipped_ambiguous_link)}")
        print(f"  skipped_no_segment:        {len(self.skipped_no_segment)}")
        print(f"  skipped_no_email:          {len(self.skipped_no_email)}")
        print(f"  sent_success:              {len(self.sent_success)}")
        print(f"  sent_404_client_not_found: {len(self.sent_404_client_not_found)}")
        print(f"  sent_other_error:          {len(self.sent_other_error)}")
        print()

        if self.sent_success:
            auto_count = sum(
                1 for _, _, b in self.sent_success
                if b.get("auto_derive_applied") is True
            )
            no_auto_count = len(self.sent_success) - auto_count
            print(
                f"Of {len(self.sent_success)} successes: {auto_count} had csm_standing "
                f"matching the segment-mapping (auto-derived OR pre-existing match), "
                f"{no_auto_count} had csm_standing diverged from the mapping (manual "
                f"override sticky, or null)."
            )
            print()

        if self.skipped_ambiguous_link:
            print("Ambiguous-link Survery rows (manual review needed):")
            for row_id in self.skipped_ambiguous_link:
                print(f"  {row_id}")
            print()

        if self.skipped_no_email:
            print("Linked client has no Email field (Airtable-side gap):")
            for row_id in self.skipped_no_email:
                print(f"  {row_id}")
            print()

        if self.sent_404_client_not_found:
            print("Email mismatch with Gregory (Airtable email not found in clients.email or alternate_emails):")
            for client_name, email, segment in self.sent_404_client_not_found:
                print(f"  {client_name!r:<30}  {email}  ({segment})")
            print()

        if self.sent_other_error:
            print("Other receiver errors:")
            for client_name, email, status, body in self.sent_other_error:
                print(f"  HTTP {status}  {client_name!r:<30}  {email}  body={body[:120]}")
            print()


# ---------------------------------------------------------------------------
# Airtable read
# ---------------------------------------------------------------------------


def fetch_nps_clients(api: Api) -> dict[str, dict[str, Any]]:
    """Build a map from NPS Clients record id → fields dict.

    Pulls all rows in one go (pyairtable handles pagination).
    """
    table = api.table(BASE_ID, NPS_CLIENTS_TABLE)
    rows = table.all(fields=["Name", "Email"])
    return {row["id"]: row.get("fields", {}) for row in rows}


def fetch_nps_survery(api: Api) -> list[dict[str, Any]]:
    """Pull all NPS Survery rows."""
    table = api.table(BASE_ID, NPS_SURVERY_TABLE)
    return table.all(
        fields=["Name", "NPS Clients", "Survey Date", "Segment Classification"]
    )


# ---------------------------------------------------------------------------
# Dedup: latest Survery row per linked client
# ---------------------------------------------------------------------------


def _survey_date_key(row: dict[str, Any]) -> str:
    """ISO date strings sort lexicographically — '' (None) is least."""
    val = row.get("fields", {}).get("Survey Date")
    return val if isinstance(val, str) else ""


def dedupe_latest_per_client(
    survery_rows: list[dict[str, Any]],
    report: Report,
) -> dict[str, dict[str, Any]]:
    """Keep the latest-by-Survey-Date Survery row per linked client.

    Bumps report buckets for skipped_no_link and skipped_ambiguous_link.
    Returns map: linked_client_record_id → kept Survery row.
    """
    keep: dict[str, dict[str, Any]] = {}
    for row in survery_rows:
        fields = row.get("fields", {})
        linked = fields.get("NPS Clients", []) or []

        if len(linked) == 0:
            report.skipped_no_link.append(row["id"])
            continue
        if len(linked) > 1:
            report.skipped_ambiguous_link.append(row["id"])
            continue

        client_id = linked[0]
        existing = keep.get(client_id)
        if existing is None or _survey_date_key(row) > _survey_date_key(existing):
            keep[client_id] = row

    return keep


# ---------------------------------------------------------------------------
# Receiver POST
# ---------------------------------------------------------------------------


def post_to_receiver(
    url: str, secret: str, payload: dict[str, Any]
) -> tuple[int, dict | None, str]:
    """POST payload → receiver. Returns (status, parsed_body_or_None, raw_body)."""
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Webhook-Secret": secret,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw), raw
            except json.JSONDecodeError:
                return resp.status, None, raw
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read().decode("utf-8")
            try:
                return exc.code, json.loads(raw), raw
            except json.JSONDecodeError:
                return exc.code, None, raw
        except Exception:
            return exc.code, None, ""


# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill clients.nps_standing from Airtable NPS Survery."
    )
    parser.add_argument(
        "--apply", action="store_true",
        help="Fire real receiver POSTs. Default is dry-run (no requests).",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Process at most N clients (after dedup). Useful for smoke tests.",
    )
    parser.add_argument(
        "--receiver-url", default=os.environ.get("RECEIVER_URL", PROD_RECEIVER_URL),
        help=f"Override receiver URL. Default: {PROD_RECEIVER_URL}",
    )
    args = parser.parse_args()

    api_key = os.environ.get("AIRTABLE_API_KEY")
    secret = os.environ.get("AIRTABLE_NPS_WEBHOOK_SECRET")

    if not api_key:
        print("ERR: AIRTABLE_API_KEY not in env (load .env.local)", file=sys.stderr)
        return 1
    if args.apply and not secret:
        print(
            "ERR: AIRTABLE_NPS_WEBHOOK_SECRET not in env — required for --apply",
            file=sys.stderr,
        )
        return 1

    print("=" * 72)
    print(f"Mode:           {'APPLY (sending real requests)' if args.apply else 'DRY-RUN (no requests)'}")
    print(f"Receiver URL:   {args.receiver_url}")
    if args.limit is not None:
        print(f"Client limit:   {args.limit} (after dedup)")
    print("=" * 72)

    api = Api(api_key)

    print("Fetching NPS Clients table…")
    clients_by_id = fetch_nps_clients(api)
    print(f"  Got {len(clients_by_id)} NPS Clients rows")

    print("Fetching NPS Survery table…")
    survery_rows = fetch_nps_survery(api)
    print(f"  Got {len(survery_rows)} NPS Survery rows")

    report = Report()
    report.total_survery_rows = len(survery_rows)

    keep = dedupe_latest_per_client(survery_rows, report)
    report.distinct_clients = len(keep)
    print(f"After dedup: {len(keep)} distinct clients (latest Survey Date wins)")

    # Apply --limit AFTER dedup so smoke tests aren't all the same client.
    items = list(keep.items())
    if args.limit is not None:
        items = items[: args.limit]
        print(f"--limit {args.limit} → processing {len(items)} of {len(keep)} clients")

    print()
    print("Per-client outcomes:")
    print()

    for client_id, row in items:
        fields = row.get("fields", {})
        survey_id = row["id"]
        segment_raw = fields.get("Segment Classification")
        survey_date = fields.get("Survey Date") or "(no date)"

        client_fields = clients_by_id.get(client_id, {})
        client_name = client_fields.get("Name", "(unknown name)")
        client_email = client_fields.get("Email")

        if not segment_raw:
            report.skipped_no_segment.append(survey_id)
            print(f"  SKIP no_segment      {client_name!r:<30}  {survey_id}")
            continue
        if not client_email:
            report.skipped_no_email.append(survey_id)
            print(f"  SKIP no_email        {client_name!r:<30}  {survey_id}")
            continue

        payload = {
            "client_email": client_email,
            "segment": segment_raw,
            "airtable_record_id": survey_id,
            "submitted_at": survey_date if survey_date != "(no date)" else None,
        }

        if not args.apply:
            print(
                f"  DRY  {segment_raw:<20} → {client_name!r:<28}  "
                f"{client_email:<35}  ({survey_date})"
            )
            continue

        status, body, raw = post_to_receiver(
            args.receiver_url, secret, payload
        )
        time.sleep(INTER_REQUEST_SLEEP_SECONDS)

        if status == 200 and body and body.get("status") == "ok":
            report.sent_success.append((client_name, segment_raw, body))
            auto = body.get("auto_derive_applied")
            csm = body.get("csm_standing")
            print(
                f"  OK   {segment_raw:<20} → {client_name!r:<28}  "
                f"csm_standing={csm}  auto_derive_applied={auto}"
            )
        elif status == 404:
            report.sent_404_client_not_found.append(
                (client_name, client_email, segment_raw)
            )
            print(
                f"  404  {segment_raw:<20} → {client_name!r:<28}  "
                f"{client_email}  (Gregory has no active client matching this email)"
            )
        else:
            report.sent_other_error.append(
                (client_name, client_email, status, raw or "")
            )
            print(
                f"  ERR  HTTP {status:<3} {client_name!r:<28}  "
                f"{client_email}  body={(raw or '')[:120]}"
            )

    report.print_summary()

    # Exit non-zero if any non-success outcomes in apply mode (so CI / wrappers
    # can detect a partial-failure run). Dry-run always exits 0.
    if args.apply and (
        report.sent_404_client_not_found or report.sent_other_error
    ):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
