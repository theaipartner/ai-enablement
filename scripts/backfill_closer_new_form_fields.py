"""Backfill the new typed columns on airtable_full_closer_report from the
fields_raw catch-all (migration 0062). Re-runs parse_full_closer over each
stored row's fields_raw and writes ONLY the new columns — existing columns
are untouched.

Runs against CLOUD (the commented prod creds in .env.local), since that's
where the columns + live data are.

  python scripts/backfill_closer_new_form_fields.py --smoke   # one row, no write report only
  python scripts/backfill_closer_new_form_fields.py --apply   # all rows

Idempotent: re-derives from fields_raw, so safe to re-run.
"""
from __future__ import annotations
import os, re, sys
from pathlib import Path

ENV = Path(__file__).resolve().parent.parent / ".env.local"
text = ENV.read_text()
# CLOUD creds (commented lines) — this writes prod, do it explicitly.
os.environ["SUPABASE_URL"] = re.search(r"^#?\s*SUPABASE_URL=(https://\S+)", text, re.M).group(1)
os.environ["SUPABASE_SERVICE_ROLE_KEY"] = re.search(r"^#\s*SUPABASE_SERVICE_ROLE_KEY=(\S+)", text, re.M).group(1)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.db import get_client
from ingestion.airtable.parser import parse_full_closer

# The columns 0062 added — only these are written back.
NEW_COLS = [
    "form_type", "call_outcome", "cancel_reason", "digital_college_closed",
    "dc_plans", "normal_plan", "payment_type", "payments_same_date",
    "creative_plan_months", "deposit_topup_amount", "contract_amount_to_send",
    "follow_up_date", "likely_start_date",
    "payment_1_amount", "payment_1_date", "payment_2_amount", "payment_2_date",
    "payment_3_amount", "payment_3_date", "payment_4_amount", "payment_4_date",
    "payment_5_amount", "payment_5_date",
]


def derive(row: dict) -> dict:
    record = {
        "id": row["record_id"],
        "fields": row.get("fields_raw") or {},
        "createdTime": row["airtable_created_at"],
    }
    parsed = parse_full_closer(record, region=row["region"])
    return {k: parsed.get(k) for k in NEW_COLS}


def main() -> None:
    apply = "--apply" in sys.argv
    smoke = "--smoke" in sys.argv
    if not apply and not smoke:
        print("pass --smoke (one row) or --apply (all rows)")
        return

    sb = get_client()
    rows = []
    frm = 0
    while True:
        page = (
            sb.table("airtable_full_closer_report")
            .select("record_id, region, airtable_created_at, fields_raw")
            .range(frm, frm + 999)
            .execute()
            .data
        )
        if not page:
            break
        rows.extend(page)
        if len(page) < 1000:
            break
        frm += 1000
    print(f"closer rows: {len(rows)}")

    if smoke:
        # Pick a New-form row if present (most interesting), else the first.
        target = next((r for r in rows if (r.get("fields_raw") or {}).get("Form Type") == "New"), rows[0])
        vals = derive(target)
        print(f"SMOKE — record {target['record_id']} ({target.get('fields_raw',{}).get('Prospect Name')}):")
        for k, v in vals.items():
            if v is not None:
                print(f"   {k} = {v!r}")
        print("(no write in smoke mode)")
        return

    written = 0
    for r in rows:
        vals = derive(r)
        sb.table("airtable_full_closer_report").update(vals).eq("record_id", r["record_id"]).execute()
        written += 1
        if written % 100 == 0:
            print(f"  ...{written}/{len(rows)}")
    print(f"backfilled new columns on {written} rows")


if __name__ == "__main__":
    main()
