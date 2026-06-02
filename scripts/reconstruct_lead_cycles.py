"""Phase 2 — reconstruct lead opt-in cycles into lead_cycles.

For each in-scope lead (close_leads.latest_opt_in_date >= EFFECTIVE_DATE):
  - match Typeform SFedWelr submissions by the lead's email or phone (last-10);
    each distinct submission (collapsed to the minute, to drop double-submits)
    = one opt_in cycle, opt_in_at = submitted_at, source='typeform'.
  - no match -> one cycle at latest_opt_in_date, source='close_fallback'.
opt_in_seq = in-scope ordering (1,2,...). Tag columns are left null here; the
tagger (Phase 3) fills them.

Dry-run by default (reports distribution + validation, writes nothing).
--apply upserts into lead_cycles. Read/cloud per docs/runbooks/apply_migrations.md.
"""
import argparse
import re
import urllib.parse
from collections import defaultdict
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values

EFFECTIVE_DATE = "2026-05-24"
OPT_IN_FORM = "SFedWelr"  # the only live funnel (Drake) — the "Closer Funnel" typeform


def digits10(s):
    d = re.sub(r"\D", "", s or "")
    return d[-10:] if len(d) >= 10 else None


def connect():
    env = {}
    for ln in Path(".env.local").read_text().splitlines():
        if ln.strip() and not ln.startswith("#") and "=" in ln:
            k, _, v = ln.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    pw = urllib.parse.quote(env["SUPABASE_DB_PASSWORD"], safe="")
    m = re.match(r"^(postgresql://[^@]+)@(.+)$", Path("supabase/.temp/pooler-url").read_text().strip())
    return psycopg2.connect(f"{m.group(1)}:{pw}@{m.group(2)}", sslmode="require", connect_timeout=20)


def main(apply):
    conn = connect()
    cur = conn.cursor()

    # 1. In-scope leads + their emails/phones + number_of_opt_ins.
    cur.execute(
        """
        select cl.close_id, cl.latest_opt_in_date, cl.number_of_opt_ins, cl.contacts
        from close_leads cl
        where cl.latest_opt_in_date >= %s and cl.excluded_at is null
        """,
        (EFFECTIVE_DATE,),
    )
    leads = []
    for close_id, latest, n_optins, contacts in cur.fetchall():
        emails, phones = set(), set()
        for c in contacts or []:
            for e in c.get("emails") or []:
                if e.get("email"):
                    emails.add(e["email"].strip().lower())
            for p in c.get("phones") or []:
                d = digits10(p.get("phone"))
                if d:
                    phones.add(d)
        leads.append(dict(close_id=close_id, latest=latest, n_optins=n_optins or 0,
                          emails=emails, phones=phones))

    # 2. Typeform SFedWelr submissions (all are >= effective date already).
    cur.execute(
        """
        select submitted_at,
          lower(trim((select a->>'email' from jsonb_array_elements(answers) a where a->>'type'='email' limit 1))),
          (select a->>'phone_number' from jsonb_array_elements(answers) a where a->>'type'='phone_number' limit 1)
        from typeform_responses
        where form_id = %s and submitted_at >= %s
        """,
        (OPT_IN_FORM, EFFECTIVE_DATE),
    )
    by_email, by_phone = defaultdict(list), defaultdict(list)
    for submitted_at, email, phone in cur.fetchall():
        if email:
            by_email[email].append(submitted_at)
        d = digits10(phone)
        if d:
            by_phone[d].append(submitted_at)

    # 3. Build cycles per lead.
    rows = []          # (close_id, opt_in_at, opt_in_seq, source)
    dist = defaultdict(int)
    over_optins = []   # leads whose reconstructed cycles exceed number_of_opt_ins
    src_counts = defaultdict(int)
    for ld in leads:
        subs = []
        for e in ld["emails"]:
            subs += by_email.get(e, [])
        for p in ld["phones"]:
            subs += by_phone.get(p, [])
        # collapse to the minute (drop double-submits), keep earliest ts per minute
        by_min = {}
        for ts in subs:
            key = ts.replace(second=0, microsecond=0)
            if key not in by_min or ts < by_min[key]:
                by_min[key] = ts
        cycle_times = sorted(by_min.values())
        source = "typeform"
        if not cycle_times:
            cycle_times = [ld["latest"]]
            source = "close_fallback"
        dist[len(cycle_times)] += 1
        src_counts[source] += 1
        if ld["n_optins"] and len(cycle_times) > ld["n_optins"]:
            over_optins.append((ld["close_id"], len(cycle_times), ld["n_optins"]))
        for seq, ts in enumerate(cycle_times, start=1):
            rows.append((ld["close_id"], ts, seq, source))

    # 4. Report.
    print(f"in-scope leads: {len(leads)}")
    print(f"total cycles reconstructed: {len(rows)}")
    print(f"source split: {dict(src_counts)}")
    print(f"cycle-count distribution (cycles_per_lead -> n_leads): {dict(sorted(dist.items()))}")
    print(f"GUARD cycles>number_of_opt_ins (should be empty): {over_optins}")
    multi = [r for r in rows if dist]  # show the multi-cycle leads explicitly
    multi_leads = [ld["close_id"] for ld in leads
                   if sum(1 for r in rows if r[0] == ld["close_id"]) > 1]
    print(f"multi-cycle leads ({len(multi_leads)}): {multi_leads}")

    if not apply:
        print("\nDRY RUN — nothing written. Re-run with --apply to upsert into lead_cycles.")
        cur.close(); conn.close()
        return

    # 5. Apply — upsert.
    execute_values(
        cur,
        """
        insert into lead_cycles (close_id, opt_in_at, opt_in_seq, source)
        values %s
        on conflict (close_id, opt_in_at)
        do update set opt_in_seq = excluded.opt_in_seq, source = excluded.source, updated_at = now()
        """,
        rows,
    )
    conn.commit()
    cur.execute("select count(*), count(distinct close_id) from lead_cycles")
    print("\nAPPLIED. lead_cycles now:", cur.fetchone())
    cur.close(); conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    main(ap.parse_args().apply)
