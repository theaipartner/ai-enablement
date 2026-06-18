"""Engagement tracking — the call↔form unit (see docs/schema/engagements.md).

An *engagement* is a rep's cluster of Close calls to one lead (back-to-back
redials collapse in) that expects one form. The sticky-tag lifecycle:

  OPEN    a >=90s outbound call with no open engagement for (lead, rep) opens one;
          a later call within 45 min of last_call_at joins it (rolling/grouping).
  OVERDUE 45 min of silence pass with no form -> overdue_at set; the call-set is
          now frozen (a later call starts a NEW engagement) and pinging begins.
  FINAL   a form for (lead, rep) links to the oldest open engagement.

Writers: api/close_events.py (open/grow, real-time), api/airtable_events.py
(final, real-time), and a cron (flip_overdue + due_pings). All connect via
psycopg2 like shared/lead_tagging.py (Vercel: SUPABASE_DB_POOL_URL; local:
.temp/pooler-url + SUPABASE_DB_PASSWORD).
"""

from __future__ import annotations

import os
import re
import urllib.parse
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.extras

CONNECTED_SEC = 90       # a call must be >=90s to OPEN an engagement
WINDOW_MIN = 45          # rolling-window / freeze gap, in minutes
PING_GAP_MIN = 15        # min minutes between pings for one engagement
BIZ_START_ET = 10        # pinging window: 10:00 ET ..
BIZ_END_ET = 22          # .. 22:00 ET (Drake handles pre-10am verbally)
_ET = ZoneInfo("America/New_York")

# Form links (env so Drake can fix the closer URL without a deploy). The closer-
# triage form is the CONFIRMATION call — owed only by currently-direct leads.
SETTER_TRIAGE_FORM_URL = os.getenv("SETTER_TRIAGE_FORM_URL", "")
CLOSER_TRIAGE_FORM_URL = os.getenv("CLOSER_TRIAGE_FORM_URL", "")


def form_url_for_lead(cur, lead_id: str) -> str:
    """Closer-triage link only when the lead's latest cycle is CURRENTLY direct
    (became_direct_at set AND reactive_at null — reactivation drops direct status,
    Drake 2026-06-16); otherwise the setter-triage link."""
    cur.execute(
        "select became_direct_at, reactive_at from lead_cycles where close_id=%s order by opt_in_at desc limit 1",
        (lead_id,),
    )
    row = cur.fetchone()
    if row and row[0] is not None and row[1] is None:
        return CLOSER_TRIAGE_FORM_URL or SETTER_TRIAGE_FORM_URL
    return SETTER_TRIAGE_FORM_URL


def render_ping(slack_id: str, lead_name: str, anchor_at, url: str) -> str:
    """The short Slack ping. Keep it one line."""
    t = anchor_at.astimezone(_ET).strftime("%-I:%M %p ET")
    tail = f" → {url}" if url else ""
    return f"<@{slack_id}> 📝 Missing form — *{lead_name}*, call {t}{tail}"

_REPO_ROOT = Path(__file__).resolve().parent.parent


def _connect():
    """psycopg2 connection — mirrors shared.lead_tagging._connect()."""
    url = os.getenv("SUPABASE_DB_POOL_URL")
    pw = os.getenv("SUPABASE_DB_PASSWORD")
    if url:
        m = re.match(r"^(postgresql://)([^:@/]+)(:[^@]*)?@(.+)$", url)
        if m and not m.group(3) and pw:
            url = f"{m.group(1)}{m.group(2)}:{urllib.parse.quote(pw, safe='')}@{m.group(4)}"
        return psycopg2.connect(url, sslmode="require", connect_timeout=20)
    env: dict[str, str] = {}
    env_path = _REPO_ROOT / ".env.local"
    if env_path.exists():
        for ln in env_path.read_text().splitlines():
            if ln.strip() and not ln.startswith("#") and "=" in ln:
                k, _, v = ln.partition("=")
                env[k.strip()] = v.strip().strip('"').strip("'")
    pw = urllib.parse.quote(env["SUPABASE_DB_PASSWORD"], safe="")
    m = re.match(r"^(postgresql://[^@]+)@(.+)$", (_REPO_ROOT / "supabase/.temp/pooler-url").read_text().strip())
    return psycopg2.connect(f"{m.group(1)}:{pw}@{m.group(2)}", sslmode="require", connect_timeout=20)


def _resolve_rep_slack(cur, user_id: str, user_name: str | None) -> str | None:
    """close user_id -> team_members.slack_user_id, with a name fallback."""
    cur.execute("select slack_user_id from team_members where close_user_id=%s", (user_id,))
    row = cur.fetchone()
    if row and row[0]:
        return row[0]
    if user_name:
        cur.execute(
            "select slack_user_id from team_members where lower(full_name)=lower(%s) and slack_user_id is not null limit 1",
            (user_name.strip(),),
        )
        row = cur.fetchone()
        if row:
            return row[0]
    return None


# --------------------------------------------------------------------------- #
# OPEN / GROW — called per outbound close_call (webhook + backfill)            #
# --------------------------------------------------------------------------- #
def open_or_grow(cur, call: dict[str, Any]) -> str | None:
    """Open a new engagement or grow an existing one for a single outbound call.

    `call` = {close_id, lead_id, user_id, user_name, activity_at, duration}.
    Returns the engagement id touched, or None if the call was ignored
    (short call with no open engagement). Idempotent: a call already present in
    an engagement's call_ids is a no-op.
    """
    cid = call["close_id"]
    lead = call.get("lead_id")
    rep = call.get("user_id")
    at = call["activity_at"]
    dur = call.get("duration") or 0
    if not (lead and rep and at):
        return None

    # Already recorded on some engagement? (idempotency)
    cur.execute("select id from engagements where %s = any(call_ids) limit 1", (cid,))
    if cur.fetchone():
        return None

    # Joinable open engagement: same (lead, rep), not final, and this call lands
    # within WINDOW minutes after its last call (the rolling window / freeze).
    cur.execute(
        """select id from engagements
           where lead_id=%s and rep_user_id=%s and final_at is null
             and %s::timestamptz >  last_call_at
             and %s::timestamptz <= last_call_at + make_interval(mins => %s)
           order by last_call_at desc limit 1""",
        (lead, rep, at, at, WINDOW_MIN),
    )
    row = cur.fetchone()
    if row:  # GROW
        cur.execute(
            """update engagements
               set call_ids = array_append(call_ids, %s),
                   last_call_at = greatest(last_call_at, %s::timestamptz)
               where id=%s""",
            (cid, at, row[0]),
        )
        return row[0]

    if dur >= CONNECTED_SEC:  # OPEN (only a real conversation seeds one)
        slack = _resolve_rep_slack(cur, rep, call.get("user_name"))
        cur.execute(
            """insert into engagements
               (lead_id, rep_user_id, rep_name, rep_slack_id, anchor_call_id, call_ids,
                anchor_at, last_call_at, opened_at)
               values (%s,%s,%s,%s,%s,array[%s],%s,%s, now())
               returning id""",
            (lead, rep, call.get("user_name"), slack, cid, cid, at, at),
        )
        return cur.fetchone()[0]

    return None  # short call, nothing open -> ignored


def open_or_grow_engagement(close_call_id: str) -> str | None:
    """Webhook entry point: fetch the call, open/grow, commit. Fail-soft caller."""
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute(
            """select close_id, lead_id, user_id, raw_payload->>'user_name', activity_at, duration, direction
               from close_calls where close_id=%s""",
            (close_call_id,),
        )
        r = cur.fetchone()
        if not r or r[6] != "outbound":
            return None
        call = dict(close_id=r[0], lead_id=r[1], user_id=r[2], user_name=r[3], activity_at=r[4], duration=r[5])
        eid = open_or_grow(cur, call)
        conn.commit()
        return eid
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# FINAL — link a triage form to its engagement                                #
# --------------------------------------------------------------------------- #
def link_form(cur, *, form_table: str, record_id: str, lead_id: str,
              setter_record_ids: list[str] | None, created_at) -> str | None:
    """Link a triage form to the OLDEST open engagement for (lead, rep).

    Rep resolves from the form's setter_record_ids via team_members
    (airtable_user_id -> close_user_id); falls back to lead-only if unresolved.
    Returns the engagement id closed, or None if nothing matched (form stays
    unlinked -> review pile).
    """
    if not lead_id:
        return None
    rep = None
    for aid in (setter_record_ids or []):
        cur.execute("select close_user_id from team_members where airtable_user_id=%s", (aid,))
        row = cur.fetchone()
        if row and row[0]:
            rep = row[0]
            break

    if rep:
        cur.execute(
            """select id from engagements
               where lead_id=%s and rep_user_id=%s and final_at is null
                 and anchor_at <= %s::timestamptz
               order by anchor_at asc limit 1""",
            (lead_id, rep, created_at),
        )
    else:  # fallback: oldest open engagement for the lead, any rep
        cur.execute(
            """select id from engagements
               where lead_id=%s and final_at is null and anchor_at <= %s::timestamptz
               order by anchor_at asc limit 1""",
            (lead_id, created_at),
        )
    row = cur.fetchone()
    if not row:
        return None
    cur.execute(
        "update engagements set final_at=%s, form_id=%s, form_table=%s where id=%s",
        (created_at, record_id, form_table, row[0]),
    )
    return row[0]


# --------------------------------------------------------------------------- #
# OVERDUE + PING — the cron's two time-driven jobs                            #
# --------------------------------------------------------------------------- #
def flip_overdue(cur) -> int:
    """Stamp overdue_at on engagements past last_call_at + WINDOW with no form."""
    cur.execute(
        """update engagements
           set overdue_at = last_call_at + make_interval(mins => %s)
           where final_at is null and overdue_at is null
             and last_call_at + make_interval(mins => %s) <= now()""",
        (WINDOW_MIN, WINDOW_MIN),
    )
    return cur.rowcount


def run_ping_cycle(dry_run: bool = False) -> dict[str, Any]:
    """One cron tick: flip overdue (always), then — inside the ET business-hours
    window — send a ping for each engagement that's due (overdue, no form, slack
    id known, >=15 min since last ping, and overdue at/after ENGAGEMENT_PING_FLOOR
    so the backfilled ones are never pinged). Posts as Ella to
    SALES_FORM_NOTIFY_SLACK_CHANNEL. Unset channel OR dry_run => render only, no
    post. Never raises."""
    from datetime import datetime
    from shared.slack_post import post_message

    channel = os.getenv("SALES_FORM_NOTIFY_SLACK_CHANNEL", "").strip()
    floor = os.getenv("ENGAGEMENT_PING_FLOOR") or None
    effective_dry = dry_run or not channel

    conn = _connect()
    try:
        cur = conn.cursor()
        flipped = flip_overdue(cur)
        conn.commit()

        hour = datetime.now(_ET).hour
        if not (BIZ_START_ET <= hour < BIZ_END_ET):
            return {"flipped": flipped, "pinged": 0, "skipped": "outside_business_hours", "et_hour": hour}

        rows = due_pings(cur, floor_iso=floor)
        sent = []
        for eid, lead_id, _rep_name, slack_id, anchor_at, _pc, lead_name in rows:
            text = render_ping(slack_id, lead_name, anchor_at, form_url_for_lead(cur, lead_id))
            if effective_dry:
                sent.append({"engagement": str(eid), "text": text})
                continue
            res = post_message(channel, text)
            if res.get("ok"):
                cur.execute(
                    "update engagements set last_pinged_at=now(), ping_count=ping_count+1 where id=%s",
                    (eid,),
                )
                conn.commit()
                sent.append({"engagement": str(eid), "ok": True})
            else:
                sent.append({"engagement": str(eid), "ok": False, "error": res.get("slack_error")})
        return {
            "flipped": flipped,
            "candidates": len(rows),
            "pinged": sum(1 for s in sent if s.get("ok")),
            "dry_run": effective_dry,
            "sent": sent,
        }
    finally:
        conn.close()


def due_pings(cur, floor_iso: str | None = None, ping_gap_min: int = PING_GAP_MIN):
    """Engagements due for a ping right now: overdue, no form, slack id known,
    >=gap since last ping, and (the go-live floor) overdue at/after `floor_iso` —
    so the backfilled-overdue engagements are never pinged. Returns rows of
    (id, lead_id, rep_name, rep_slack_id, anchor_at, ping_count, lead_name).

    Only **sales reps** are pinged: the engagement's rep must map to a current
    team_members row with sales_role in setter/closer/dc_closer. This keeps
    non-rep Close users out of the channel — Nabeel/Scott (leadership) and Ellis
    (ops) all have Close accounts and would otherwise leak in. Tracking still
    opens engagements for everyone; only the ping channel is gated."""
    cur.execute(
        """select e.id, e.lead_id, e.rep_name, e.rep_slack_id, e.anchor_at, e.ping_count,
                  coalesce(l.display_name, e.lead_id)
           from engagements e
           join team_members tm
             on tm.close_user_id = e.rep_user_id and tm.archived_at is null
            and tm.sales_role in ('setter', 'closer', 'dc_closer')
           left join close_leads l on l.close_id = e.lead_id
           where e.overdue_at is not null and e.final_at is null and e.rep_slack_id is not null
             and (%s::timestamptz is null or e.overdue_at >= %s::timestamptz)
             and (e.last_pinged_at is null or now() - e.last_pinged_at >= make_interval(mins => %s))
           order by e.anchor_at asc""",
        (floor_iso, floor_iso, ping_gap_min),
    )
    return cur.fetchall()
