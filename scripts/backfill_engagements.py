"""Backfill engagements from the last N days of close_calls + triage forms.

Populates the engagements table by replaying outbound calls (open/grow) then
forms (final), then flipping overdue. Idempotent (open_or_grow skips calls
already on an engagement). Default 2 days per Drake.

  python scripts/backfill_engagements.py [--days N]
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.engagements import _connect, open_or_grow, link_form, flip_overdue  # noqa: E402


def main(days: int) -> None:
    conn = _connect()
    cur = conn.cursor()

    # 1. outbound calls, chronological (so grouping rolls forward correctly)
    cur.execute(
        """select close_id, lead_id, user_id, raw_payload->>'user_name', activity_at, duration
           from close_calls
           where direction='outbound' and activity_at >= now() - make_interval(days => %s)
             and lead_id is not null and activity_at is not null
           order by activity_at asc, close_id asc""",
        (days,),
    )
    calls = cur.fetchall()
    for cid, lead, rep, uname, at, dur in calls:
        open_or_grow(cur, dict(close_id=cid, lead_id=lead, user_id=rep,
                               user_name=uname, activity_at=at, duration=dur))
    conn.commit()
    print(f"calls processed: {len(calls)}")

    # 2. triage forms, by submission time (final/link)
    cur.execute(
        """select record_id, lead_id, setter_record_ids, airtable_created_at
           from airtable_setter_triage_calls
           where airtable_created_at >= now() - make_interval(days => %s)
             and lead_id is not null
           order by airtable_created_at asc""",
        (days,),
    )
    forms = cur.fetchall()
    linked = 0
    for rid, lead, srecs, created in forms:
        eid = link_form(cur, form_table="airtable_setter_triage_calls", record_id=rid,
                        lead_id=lead, setter_record_ids=srecs, created_at=created)
        if eid:
            linked += 1
    conn.commit()
    print(f"forms processed: {len(forms)}  linked: {linked}  unlinked: {len(forms)-linked}")

    # 3. flip overdue
    n = flip_overdue(cur)
    conn.commit()
    print(f"flipped overdue: {n}")

    # 4. report
    cur.execute("""select
        count(*) total,
        count(*) filter (where final_at is not null) final,
        count(*) filter (where overdue_at is not null and final_at is null) overdue,
        count(*) filter (where overdue_at is null and final_at is null) grace
        from engagements""")
    t, f, o, g = cur.fetchone()
    print(f"\nengagements: {t} total | {f} final | {o} overdue (owed) | {g} grace (still in window)")

    print("\n--- sample engagements ---")
    cur.execute("""select rep_name, lead_id, array_length(call_ids,1) calls, anchor_at::timestamp(0),
                          (overdue_at is not null) overdue, (final_at is not null) final
                   from engagements order by anchor_at desc limit 8""")
    for rep, lead, n, anc, ov, fin in cur.fetchall():
        state = "final" if fin else ("overdue" if ov else "grace")
        print(f"  {str(rep):18s} {lead[:14]} calls={n} at={anc} [{state}]")
    conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=2)
    main(ap.parse_args().days)
