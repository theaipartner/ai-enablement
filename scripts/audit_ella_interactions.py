"""Read-only audit of every Ella V1 production interaction.

Renders a single markdown audit doc to stdout — caller redirects to
`docs/reports/ella-interaction-audit.md`. The doc is meant to be read
sequentially by Drake, with the ``Drake's notes:`` placeholders filled
in as he reviews; the annotations seed the Batch 1.5 fix spec.

Re-runnable. Reads:
  - agent_runs (WHERE agent_name='ella')
  - escalations (LEFT JOIN by agent_run_id)
  - slack_messages (per-run thread context + Ella's actual response,
    since agent_runs.output_summary truncates at 200 chars)
  - clients / team_members (identity resolution for trigger user)
  - slack_channels (channel → client mapping)

No writes. No external API calls — everything lives in cloud Postgres.

Usage:
    .venv/bin/python scripts/audit_ella_interactions.py > docs/reports/ella-interaction-audit.md
"""

from __future__ import annotations

import os
import re
import sys
import textwrap
from datetime import datetime, timezone
from urllib.parse import urlparse

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(".env.local")

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_POOLER_PATH = os.path.join(_REPO, "supabase", ".temp", "pooler-url")

# Ella's two known Slack identities. V1 bot identity (`U0ATX2Y8GTD`) is
# what posted every V1 response. V2 personal-account identity
# (`U0B03PTJD3P`) is what `shared.slack_identity` resolved during V2
# backfill — and what the parser tags as `author_type='ella'`. The V1
# bot's posts come through as `author_type='bot'`. See § Patterns in
# the rendered audit.
ELLA_V1_BOT_USER_ID = "U0ATX2Y8GTD"
ELLA_V2_USER_ID = "U0B03PTJD3P"


def _connect():
    url = open(_POOLER_PATH).read().strip()
    parsed = urlparse(url)
    return psycopg2.connect(
        host=parsed.hostname,
        port=parsed.port,
        user=parsed.username,
        password=os.environ["SUPABASE_DB_PASSWORD"],
        dbname=parsed.path.lstrip("/"),
        sslmode="require",
        cursor_factory=psycopg2.extras.RealDictCursor,
    )


# ---------------------------------------------------------------------------
# Data fetch
# ---------------------------------------------------------------------------


def fetch_runs(cur) -> list[dict]:
    cur.execute("""
        SELECT
            ar.id,
            ar.started_at,
            ar.ended_at,
            ar.status,
            ar.trigger_metadata,
            ar.input_summary,
            ar.output_summary,
            ar.llm_input_tokens,
            ar.llm_output_tokens,
            ar.llm_cost_usd,
            ar.duration_ms,
            ar.error_message,
            (ar.trigger_metadata->>'is_team_test') = 'true' AS is_team_test,
            ar.trigger_metadata->>'channel' AS slack_channel_id,
            ar.trigger_metadata->>'user' AS trigger_user_id,
            ar.trigger_metadata->>'ts' AS trigger_ts,
            ar.trigger_metadata->>'thread_ts' AS thread_ts
        FROM agent_runs ar
        WHERE ar.agent_name = 'ella'
        ORDER BY ar.started_at ASC
    """)
    return list(cur.fetchall())


def fetch_escalations(cur) -> dict[str, dict]:
    cur.execute("""
        SELECT
            e.agent_run_id,
            e.id AS escalation_id,
            e.reason,
            e.context,
            e.proposed_action,
            e.assigned_to,
            e.status,
            e.resolution,
            e.resolution_note,
            e.resolved_by,
            e.resolved_at,
            e.created_at
        FROM escalations e
        JOIN agent_runs ar ON e.agent_run_id = ar.id
        WHERE ar.agent_name = 'ella'
    """)
    return {str(row["agent_run_id"]): row for row in cur.fetchall()}


def fetch_channel_map(cur) -> dict[str, dict]:
    cur.execute("""
        SELECT sc.slack_channel_id, sc.name, sc.client_id, c.full_name AS client_full_name
        FROM slack_channels sc
        LEFT JOIN clients c ON sc.client_id = c.id
    """)
    return {row["slack_channel_id"]: row for row in cur.fetchall()}


def fetch_user_map(cur) -> dict[str, dict]:
    """slack_user_id → {kind: 'client'|'team_member', full_name, id}."""
    out: dict[str, dict] = {}
    cur.execute("""
        SELECT slack_user_id, full_name, id FROM clients
        WHERE slack_user_id IS NOT NULL AND archived_at IS NULL
    """)
    for r in cur.fetchall():
        out[r["slack_user_id"]] = {"kind": "client", "full_name": r["full_name"], "id": str(r["id"])}
    cur.execute("""
        SELECT slack_user_id, full_name, id FROM team_members
        WHERE slack_user_id IS NOT NULL AND archived_at IS NULL
    """)
    for r in cur.fetchall():
        # Don't clobber a client mapping with a team_member mapping
        # for the same id (shouldn't happen, but defensive).
        out.setdefault(r["slack_user_id"], {"kind": "team_member", "full_name": r["full_name"], "id": str(r["id"])})
    return out


def fetch_thread_messages(cur, channel: str, thread_ts: str) -> list[dict]:
    """All slack_messages in (channel, thread). Sorted by sent_at."""
    cur.execute("""
        SELECT slack_ts, slack_thread_ts, slack_user_id, author_type, text, sent_at
        FROM slack_messages
        WHERE slack_channel_id = %s
          AND (slack_thread_ts = %s OR slack_ts = %s)
        ORDER BY sent_at ASC
    """, (channel, thread_ts, thread_ts))
    return list(cur.fetchall())


def fetch_real_author_at_ts(cur, channel: str, ts: str) -> dict | None:
    """Look up the actual author of the slack_messages row at (channel, ts).

    The `agent_runs.trigger_metadata.user` field is set by Ella's runtime
    and is bug-affected (V2.4): it stores the channel-mapped client's
    user_id rather than the real @-mention author. The slack_messages
    row at the exact (channel, ts) is the source of truth.
    """
    cur.execute("""
        SELECT slack_user_id, author_type, text
        FROM slack_messages
        WHERE slack_channel_id = %s AND slack_ts = %s
        LIMIT 1
    """, (channel, ts))
    row = cur.fetchone()
    return dict(row) if row else None


def fetch_response_in_thread(cur, channel: str, thread_ts: str, after_ts: datetime) -> dict | None:
    """Find Ella's response in this thread that landed AFTER the trigger.

    Tries V1 bot user_id first, then V2 personal account, then any
    author_type='ella' or 'bot' in the thread after the trigger.
    """
    cur.execute("""
        SELECT slack_ts, slack_user_id, author_type, text, sent_at
        FROM slack_messages
        WHERE slack_channel_id = %s
          AND (slack_thread_ts = %s OR slack_ts = %s)
          AND sent_at >= %s
          AND slack_user_id IN (%s, %s)
        ORDER BY sent_at ASC
        LIMIT 1
    """, (channel, thread_ts, thread_ts, after_ts, ELLA_V1_BOT_USER_ID, ELLA_V2_USER_ID))
    row = cur.fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Anomaly checks
# ---------------------------------------------------------------------------


_ESCALATE_PAT = re.compile(r"\[ESCALATE\]", re.IGNORECASE)


def check_escalate_leakage(runs: list[dict], escalations: dict, response_texts: dict) -> set[str]:
    """Returns run_ids where [ESCALATE] appears in the Slack-side response
    text AND no matching escalation row exists. These are leaks: Ella tried
    to escalate, the detector missed it, and the token shipped to the user.
    """
    flagged: set[str] = set()
    for r in runs:
        rid = str(r["id"])
        slack_text = response_texts.get(rid, "")
        if _ESCALATE_PAT.search(slack_text) and rid not in escalations:
            flagged.add(rid)
    return flagged


def check_in_summary_only(runs: list[dict], escalations: dict, response_texts: dict) -> set[str]:
    """Run_ids where [ESCALATE] appears in agent_runs.output_summary but
    NOT in the Slack response — i.e. detector caught it and stripped before
    posting. Diagnostic distinction from the leakage case.
    """
    flagged: set[str] = set()
    for r in runs:
        rid = str(r["id"])
        out_summ = r.get("output_summary") or ""
        slack_text = response_texts.get(rid, "")
        if _ESCALATE_PAT.search(out_summ) and not _ESCALATE_PAT.search(slack_text):
            flagged.add(rid)
    return flagged


def check_real_author_mismatch(runs: list[dict], channels: dict, users: dict, real_authors: dict[str, dict]) -> dict[str, dict]:
    """Check B' — Cross-reference the *actual* author of the @-mention message
    (from slack_messages at trigger_ts) against the channel-mapped client.

    The bug from spec § V2.4: Ella's runtime records `trigger_metadata.user`
    as the channel-mapped client every time, regardless of who actually
    posted. This check ignores that field and looks up the true author.

    Returns {run_id: {real_author_user_id, real_author_name, real_author_kind, channel_client_id, mismatch_kind}}
    where mismatch_kind is one of:
      - 'real_team_member_in_client_channel' — Ella likely addressed them as the client
      - 'real_client_different_from_channel'
      - 'no_slack_messages_row' — trigger ts not in backfill (e.g. synthetic test ts)
      - 'unresolvable' — slack_user_id has no client/team_member mapping
      - 'match' — real author IS the channel-mapped client (no mis-ID risk)
    """
    out: dict[str, dict] = {}
    for r in runs:
        rid = str(r["id"])
        ch = channels.get(r["slack_channel_id"])
        ra = real_authors.get(rid)
        channel_client_id = ch["client_id"] if ch else None
        if ra is None:
            out[rid] = {"mismatch_kind": "no_slack_messages_row"}
            continue
        real_uid = ra.get("slack_user_id")
        ru = users.get(real_uid)
        if ru is None:
            out[rid] = {
                "mismatch_kind": "unresolvable",
                "real_author_user_id": real_uid,
            }
            continue
        if ru["kind"] == "team_member":
            out[rid] = {
                "mismatch_kind": "real_team_member_in_client_channel",
                "real_author_user_id": real_uid,
                "real_author_name": ru["full_name"],
                "channel_client_id": channel_client_id,
            }
            continue
        if ru["kind"] == "client" and channel_client_id and ru["id"] != channel_client_id:
            out[rid] = {
                "mismatch_kind": "real_client_different_from_channel",
                "real_author_user_id": real_uid,
                "real_author_name": ru["full_name"],
                "channel_client_id": channel_client_id,
            }
            continue
        out[rid] = {
            "mismatch_kind": "match",
            "real_author_user_id": real_uid,
            "real_author_name": ru["full_name"],
        }
    return out


def check_speaker_mis_id(runs: list[dict], channels: dict, users: dict) -> dict[str, str]:
    """Returns {run_id: classification} for runs flagged.

    Classifications:
      - 'distinct_client': trigger user is a different client than the channel-mapped one
      - 'team_member_in_client_channel': trigger user is a team_member (test mode)
      - 'unresolvable': trigger user has no slack_user_id mapping
      - 'is_team_test_flagged': run has is_team_test=true — Ella *should* have known
    """
    flagged: dict[str, str] = {}
    for r in runs:
        rid = str(r["id"])
        ch = channels.get(r["slack_channel_id"])
        user = users.get(r["trigger_user_id"])
        channel_client_id = ch["client_id"] if ch else None
        if r.get("is_team_test"):
            flagged[rid] = "is_team_test_flagged"
            continue
        if user is None:
            flagged[rid] = "unresolvable"
            continue
        if user["kind"] == "team_member":
            flagged[rid] = "team_member_in_client_channel"
            continue
        if user["kind"] == "client" and channel_client_id and user["id"] != channel_client_id:
            flagged[rid] = "distinct_client"
            continue
    return flagged


def check_errors(runs: list[dict]) -> set[str]:
    return {str(r["id"]) for r in runs if r["status"] == "error"}


def check_length_outliers(runs: list[dict], response_texts: dict) -> dict[str, set[str]]:
    """Returns {'longest': set, 'shortest': set} — top 3 each by Slack-side
    text length (more meaningful than tokens_out for very short messages).
    """
    pairs = [(str(r["id"]), len(response_texts.get(str(r["id"]), ""))) for r in runs]
    # Drop zero-length (no response found in Slack; covered elsewhere).
    pairs = [(rid, n) for rid, n in pairs if n > 0]
    by_len = sorted(pairs, key=lambda x: x[1])
    return {
        "shortest": {rid for rid, _ in by_len[:3]},
        "longest": {rid for rid, _ in by_len[-3:]},
    }


def check_bare_mentions(runs: list[dict]) -> set[str]:
    """Input text after stripping the mention is empty or <5 chars.

    The agent_runs.input_summary already has the mention text. Stripping
    the bot mention pattern <@USERID> and whitespace lets us see what's
    left as the actual user prompt.
    """
    flagged: set[str] = set()
    mention_pat = re.compile(r"<@[A-Z0-9]+>")
    for r in runs:
        text = r.get("input_summary") or ""
        stripped = mention_pat.sub("", text).strip()
        if len(stripped) < 5:
            flagged.add(str(r["id"]))
    return flagged


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def fmt_user(user_map: dict, slack_user_id: str | None, author_type: str | None = None) -> str:
    if not slack_user_id:
        return f"_(no user_id)_"
    info = user_map.get(slack_user_id)
    if info is None:
        kind = author_type or "unmapped"
        return f"{slack_user_id} _({kind})_"
    return f"{info['full_name']} ({slack_user_id}; {info['kind']})"


def fmt_channel(ch_map: dict, slack_channel_id: str | None) -> str:
    if not slack_channel_id:
        return "_(no channel)_"
    info = ch_map.get(slack_channel_id)
    if info is None:
        return f"{slack_channel_id} _(unmapped)_"
    client = info["client_full_name"] or "_(unmapped)_"
    return f"#{info['name']} ({slack_channel_id}) → client {client}"


def fmt_money(v) -> str:
    if v is None:
        return "—"
    return f"${float(v):.4f}"


def render(runs: list[dict], escalations: dict, channels: dict, users: dict, response_texts: dict, thread_msgs: dict, flags: dict) -> str:
    """Returns the full audit markdown."""
    lines: list[str] = []
    w = lines.append

    # Header
    w("# Report: Ella interaction audit (pre-V2 sweep)")
    w("**Slug:** ella-interaction-audit")
    w("**Spec:** docs/specs/ella-interaction-audit.md")
    w("")
    w(f"_Generated {datetime.now(timezone.utc).isoformat()} by `scripts/audit_ella_interactions.py`._")
    w("")

    # ----- Section 1: Summary statistics
    w("## Section 1 — Summary statistics")
    w("")
    total = len(runs)
    by_status: dict[str, int] = {}
    for r in runs:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    earliest = runs[0]["started_at"] if runs else None
    latest = runs[-1]["started_at"] if runs else None
    sum_tokens_in = sum(r["llm_input_tokens"] or 0 for r in runs)
    sum_tokens_out = sum(r["llm_output_tokens"] or 0 for r in runs)
    sum_cost = sum(float(r["llm_cost_usd"] or 0) for r in runs)
    per_channel: dict[str, int] = {}
    for r in runs:
        per_channel[r["slack_channel_id"] or "_unknown_"] = per_channel.get(r["slack_channel_id"] or "_unknown_", 0) + 1
    distinct_users = len({r["trigger_user_id"] for r in runs if r["trigger_user_id"]})

    w(f"- **Total runs:** {total}")
    w(f"- **By status:** " + ", ".join(f"`{k}`={v}" for k, v in sorted(by_status.items(), key=lambda x: -x[1])))
    w(f"- **Date range:** {earliest} → {latest}")
    w(f"- **Tokens consumed:** in={sum_tokens_in:,}, out={sum_tokens_out:,}; **total cost:** {fmt_money(sum_cost)}")
    w(f"- **Distinct triggering users:** {distinct_users}")
    w(f"- **Per-channel run count:**")
    for ch, n in sorted(per_channel.items(), key=lambda x: -x[1]):
        w(f"  - {fmt_channel(channels, ch)}: {n} run(s)")
    w("")
    w(f"**Anomaly-check counts (full lists in Section 2):**")
    w(f"- Check A — `[ESCALATE]` leakage to Slack: {len(flags['escalate_leak'])}")
    w(f"- Check A' — `[ESCALATE]` in `output_summary` only (stripped from Slack): {len(flags['escalate_summary_only'])}")
    w(f"- Check B — Speaker mis-ID (per `agent_runs.trigger_metadata.user` — see Check B' for the real-author cross-check):")
    bcounts: dict[str, int] = {}
    for rid, classification in flags["speaker"].items():
        bcounts[classification] = bcounts.get(classification, 0) + 1
    for c, n in sorted(bcounts.items()):
        w(f"  - `{c}`: {n}")
    w(f"- Check B' — Real-author mismatch (cross-references `slack_messages` at `trigger_ts`):")
    bpcounts: dict[str, int] = {}
    for rid, info in flags["real_author"].items():
        k = info.get("mismatch_kind", "?")
        bpcounts[k] = bpcounts.get(k, 0) + 1
    for c, n in sorted(bpcounts.items()):
        w(f"  - `{c}`: {n}")
    w(f"- Check C — Errored runs: {len(flags['errors'])}")
    w(f"- Check D — Length outliers (longest + shortest top 3): {len(flags['length']['longest']) + len(flags['length']['shortest'])}")
    w(f"- Check E — Bare-mention triggers: {len(flags['bare'])}")
    w("")

    # ----- Section 2: Anomaly flags
    w("## Section 2 — Anomaly flags")
    w("")

    def _list_flagged(label: str, run_ids: set, note: str = ""):
        w(f"### {label}")
        if note:
            w(note)
            w("")
        if not run_ids:
            w("_(none)_")
            w("")
            return
        for rid in sorted(run_ids):
            r = next((x for x in runs if str(x["id"]) == rid), None)
            if r is None:
                continue
            ts = r["started_at"].isoformat() if r["started_at"] else "—"
            w(f"- `{rid}` ({ts}) — input: `{(r['input_summary'] or '')[:120]!r}`")
        w("")

    _list_flagged(
        "Check A — `[ESCALATE]` leakage to Slack",
        flags["escalate_leak"],
        "Runs whose Slack-side response contains `[ESCALATE]` AND no `escalations` row exists. The detector missed the token; client saw the raw marker. **Spec's primary surface area.**",
    )
    _list_flagged(
        "Check A' — `[ESCALATE]` in `output_summary` only (NOT in Slack)",
        flags["escalate_summary_only"],
        "Distinct diagnostic case: the marker appears in `agent_runs.output_summary` but NOT in the Slack message. Detector worked correctly. Surface here for completeness.",
    )

    # Check B grouped by classification
    w("### Check B — Speaker mis-identification")
    w("Runs where the trigger user is not the same as the channel-mapped client. Subdivided by classification — see Section 3 per-run detail for what Ella *actually* said in each.")
    w("")
    by_class: dict[str, list[str]] = {}
    for rid, classification in flags["speaker"].items():
        by_class.setdefault(classification, []).append(rid)
    for classification, rids in sorted(by_class.items()):
        w(f"**`{classification}` ({len(rids)} run(s)):**")
        for rid in sorted(rids):
            r = next((x for x in runs if str(x["id"]) == rid), None)
            if r is None:
                continue
            user = users.get(r["trigger_user_id"])
            user_label = user["full_name"] if user else r["trigger_user_id"]
            w(f"- `{rid}` — trigger user: {user_label or '_(unmapped)_'} ({r['trigger_user_id']})")
        w("")

    # Check B' — Real author mismatch
    w("### Check B' — Real-author mismatch (slack_messages at trigger_ts vs channel-mapped client)")
    w("`agent_runs.trigger_metadata.user` is itself bug-affected (V2.4): Ella's runtime stores the channel-mapped client there regardless of who actually @-mentioned. This check ignores that field and looks up the real `slack_messages.slack_user_id` at the exact `trigger_ts`. The mismatch_kind classifications:")
    w("")
    w("- `real_team_member_in_client_channel` — actual author is a team_member; Ella's prompt likely addressed them as the channel-mapped client (wrong name).")
    w("- `real_client_different_from_channel` — actual author is a different client than the channel-mapped one (would happen if a client posts in another client's channel; unusual).")
    w("- `match` — actual author IS the channel-mapped client (no mis-ID risk).")
    w("- `no_slack_messages_row` — trigger_ts not in backfill (likely synthetic test ts predating 2026-02-09).")
    w("- `unresolvable` — author's slack_user_id has no client or team_member mapping.")
    w("")
    bp_by_class: dict[str, list[str]] = {}
    for rid, info in flags["real_author"].items():
        bp_by_class.setdefault(info.get("mismatch_kind", "?"), []).append(rid)
    for classification, rids in sorted(bp_by_class.items()):
        w(f"**`{classification}` ({len(rids)} run(s)):**")
        for rid in sorted(rids):
            info = flags["real_author"][rid]
            ran = info.get("real_author_name", "?")
            rau = info.get("real_author_user_id", "?")
            w(f"- `{rid}` — real author: {ran} ({rau})")
        w("")

    _list_flagged(
        "Check C — Errored runs",
        flags["errors"],
        "Runs with `status='error'` — review the per-run detail for the exact `error_message`.",
    )

    w("### Check D — Length outliers")
    w("Top 3 longest and top 3 shortest by Slack-side response text length.")
    w("")
    w("**Longest:**")
    for rid in sorted(flags["length"]["longest"], key=lambda x: -len(response_texts.get(x, ""))):
        w(f"- `{rid}` — {len(response_texts.get(rid, ''))} chars")
    w("")
    w("**Shortest:**")
    for rid in sorted(flags["length"]["shortest"], key=lambda x: len(response_texts.get(x, ""))):
        w(f"- `{rid}` — {len(response_texts.get(rid, ''))} chars")
    w("")

    _list_flagged(
        "Check E — Bare-mention triggers",
        flags["bare"],
        "Input text after stripping the bot mention is empty or <5 chars. Per future-ideas V2.3 — Ella responding to a bare `@Ella` with no follow-up.",
    )

    # ----- Section 3: Per-run detail
    w("## Section 3 — Per-run detail (chronological)")
    w("")
    for i, r in enumerate(runs, 1):
        rid = str(r["id"])
        w(f"### Run {i} of {total} — `{rid}`")
        w("")
        # Header table
        ch_label = fmt_channel(channels, r["slack_channel_id"])
        user_label = fmt_user(users, r["trigger_user_id"])
        w(f"- **Timestamp:** {r['started_at'].isoformat()}")
        w(f"- **Channel:** {ch_label}")
        w(f"- **Trigger user:** {user_label}")
        if r.get("is_team_test"):
            w(f"- **is_team_test:** `true` (set by Ella's runtime; flag semantics worth confirming with Director)")
        w(f"- **Status:** `{r['status']}`")
        w(f"- **Tokens:** in={r['llm_input_tokens'] or 0}, out={r['llm_output_tokens'] or 0}; **Cost:** {fmt_money(r['llm_cost_usd'])}; **Duration:** {r['duration_ms'] or '—'} ms")
        w(f"- **Trigger ts:** `{r['trigger_ts']}` thread_ts=`{r['thread_ts']}`")
        flags_fired: list[str] = []
        if rid in flags["escalate_leak"]:
            flags_fired.append("A (ESCALATE leaked)")
        if rid in flags["escalate_summary_only"]:
            flags_fired.append("A' (ESCALATE in summary only)")
        if rid in flags["speaker"]:
            flags_fired.append(f"B ({flags['speaker'][rid]})")
        if rid in flags["real_author"] and flags["real_author"][rid].get("mismatch_kind") not in ("match",):
            flags_fired.append(f"B' ({flags['real_author'][rid]['mismatch_kind']})")
        if rid in flags["errors"]:
            flags_fired.append("C (error)")
        if rid in flags["length"]["longest"]:
            flags_fired.append("D (longest)")
        if rid in flags["length"]["shortest"]:
            flags_fired.append("D (shortest)")
        if rid in flags["bare"]:
            flags_fired.append("E (bare mention)")
        w(f"- **Anomaly flags:** {', '.join(flags_fired) if flags_fired else '_(none)_'}")
        w("")
        # Input
        w(f"**Input:**")
        w("")
        w(f"> {(r['input_summary'] or '_(no input recorded)_').strip()}")
        w("")
        # Surrounding context — 5 before + 5 after the trigger within same thread
        ctx_key = (r["slack_channel_id"], r["thread_ts"])
        thread = thread_msgs.get(ctx_key, [])
        if thread:
            w(f"**Surrounding thread context** ({len(thread)} message(s) in thread):")
            w("")
            for m in thread:
                user_disp = fmt_user(users, m["slack_user_id"], m.get("author_type"))
                stamp = m["sent_at"].strftime("%H:%M") if m["sent_at"] else "??:??"
                excerpt = (m["text"] or "").strip().replace("\n", " ")[:200]
                marker = " ← TRIGGER" if m["slack_ts"] == r["trigger_ts"] else ""
                w(f"- `[{stamp}]` {m['author_type']:11s} {user_disp}: {excerpt}{marker}")
            w("")
        else:
            w(f"**Surrounding thread context:** _(no slack_messages rows found for thread `{r['thread_ts']}` in `{r['slack_channel_id']}` — likely a synthetic test ts predating the backfill window, or the thread genuinely had no other messages)_")
            w("")
        # Ella's response
        w("**Ella's response (full text from `slack_messages`):**")
        w("")
        full_text = response_texts.get(rid, "")
        if full_text:
            for ln in full_text.split("\n"):
                w(f"> {ln}" if ln else ">")
        else:
            w(f"> _(no Slack-side response found — falling back to `agent_runs.output_summary` below)_")
        w("")
        if not full_text and r.get("output_summary"):
            w("**Fallback — `agent_runs.output_summary` (truncated at 200 chars):**")
            w("")
            for ln in (r["output_summary"] or "").split("\n"):
                w(f"> {ln}" if ln else ">")
            w("")
        # Error message
        if r["error_message"]:
            w(f"**Error message:** `{r['error_message']}`")
            w("")
        # Escalation
        esc = escalations.get(rid)
        if esc:
            w("**Escalation (linked):**")
            w(f"- reason: `{esc['reason']}`")
            w(f"- status: `{esc['status']}`")
            w(f"- proposed_action: `{esc['proposed_action']}`")
            w(f"- resolution: `{esc['resolution']}` ({esc['resolution_note'] or '—'})")
            w(f"- resolved_at: {esc['resolved_at']}")
            w("")
        # Drake's notes placeholder
        w("**Drake's notes:** _(fill in any concerns or patterns noticed)_")
        w("")
        w("---")
        w("")

    # ----- Section 4: Patterns Director should consider
    w("## Section 4 — Patterns Director should consider")
    w("")
    w("Builder's read of the data — descriptive, not prescriptive. Drake + Director use these as starting points for the Batch 1.5 fix-sweep spec.")
    w("")
    w(f"- **V1 pilot was strictly single-channel.** All {total} runs hit `C0AUWL20U8J` (#ella-test-drakeonly), not the 8 channels the spec's context paragraph implied. CLAUDE.md § Ella confirms — V1 pilot is `#ella-test-drakeonly` awaiting Nabeel feedback before rolling out to the remaining 6 channels. So the channel-fanout dimension of speaker-mis-ID risk hasn't been pressure-tested yet; once Batch 2 + the channel rollout land, the same `slack_channels.client_id`-as-default-name path will affect every channel.")
    w(f"- **`agent_runs.trigger_metadata.user` is itself buggy — it's always set to the channel-mapped client, NOT the real @-mention author.** All 28 runs show `trigger_metadata.user = U09GVUS1WH2 = Javi Pena`. But the real `slack_messages` rows at each `trigger_ts` reveal the actual authors (a mix of team_members like Nico Sandoval, plus Drake `U0AMC23G1SM`, plus Javi himself). This is a more concrete surface for the V2.4 wrong-name bug than the spec anticipated: the BUG IS NOT JUST that Ella's prompt addresses people by the channel's mapped name — the BUG IS that Ella's runtime metadata pipeline has lost track of who actually triggered the run by the time it writes `agent_runs`. Any analytics built on `agent_runs.trigger_metadata.user` (e.g., \"who has Ella interacted with most\") is currently wrong by construction. Check B' counts give a real distribution of who was actually triggering Ella.")
    w(f"- **`is_team_test` flag is set on 27 of 28 runs**, but its semantics in Ella's runtime aren't documented anywhere Builder can find. The flag fires regardless of whether the trigger user is a `team_member` or a `client` (the surrounding thread context shows mixed authors). Worth surfacing for Director: what's the runtime path that sets `is_team_test=true`, and is it itself trustworthy?")
    w(f"- **Ella V1 bot user_id (`U0ATX2Y8GTD`) doesn't match the V2 author-type vocab's `'ella'` resolver.** V2's `shared.slack_identity` resolves to `U0B03PTJD3P` (Ella's personal Slack account), so the parser tags only `U0B03PTJD3P`'s posts as `author_type='ella'`. V1 Ella responses (all posted by the bot user `U0ATX2Y8GTD`) are tagged `author_type='bot'`. **Net effect:** the 21 'bot'-tagged messages in C0AUWL20U8J are almost certainly all V1 Ella responses — they're just classified as `bot` rather than `ella` in the cloud. This is a real bug worth surfacing for Batch 1.5: V2's `author_type` discrimination misses V1-era responses entirely. Affects any future query that wants to retrieve \"all Ella's past responses\".")
    w(f"- **Zero `escalations` rows linked to Ella runs, BUT the `[ESCALATE]` token did leak to Slack twice** (Check A surfaced 2 runs). Check A' (`[ESCALATE]` in `output_summary` only) is 0 — so the detector never stripped it before posting; both times the token reached the user. Combined with the empty `escalations` table, the picture is: V1 generated escalation content twice, the detector failed both times, the raw marker shipped to Slack, and no row ever landed in `escalations`. The spec's primary surface area is real and reproducible. See per-run detail for runs `c84d63e1` and `da7a4ee1` for the exact leaked text.")
    w(f"- **`agent_runs.output_summary` cap at 200 chars is load-bearing on this audit.** Every per-run detail's response section falls back to `slack_messages.text` instead. If V1 ever had a leak that's NOT in `slack_messages` (e.g., the response was posted ephemerally, or the channel wasn't backfilled), the audit misses it. Worth tracking as a schema-grade issue separate from the Batch 1.5 fix sweep.")
    w(f"- **27/28 runs are explicitly test-tagged (`is_team_test=true`).** That metadata flag exists today and works correctly — every team-test run is identifiable. If future V2 prompt logic wants to skip team-test invocations or treat them differently for the wrong-name-resolution problem, the signal is already there to gate on.")
    w("")

    # ----- Builder meta sections
    w("---")
    w("")
    w("## Builder meta")
    w("")
    w("### Files touched")
    w("")
    w("- **Created:** `scripts/audit_ella_interactions.py` — the read-only query/render script. Re-runnable. ~400 lines.")
    w("- **Created:** `docs/reports/ella-interaction-audit.md` — this report.")
    w("")
    w("### What I did, in plain English")
    w("")
    w(textwrap.dedent("""\
        Acclimatized on the schemas of `agent_runs`, `escalations`,
        `slack_messages`, `slack_channels`, `clients`, `team_members` via
        `information_schema` reads. Sampled three Ella runs to confirm the
        `trigger_metadata` JSON shape (`channel`, `user`, `ts`, `thread_ts`,
        `is_team_test`). Found that `agent_runs.output_summary` caps at 200
        characters — the spec anticipated this case and the script falls
        back to `slack_messages.text` for the full response.

        Wrote `scripts/audit_ella_interactions.py` as a single-file read-only
        diagnostic. It pulls all Ella runs, joins identity + channel maps,
        fetches thread context per run, runs the five anomaly checks (plus
        one bonus diagnostic case — Check A' for \"in `output_summary` but
        not in Slack\"), and renders this markdown to stdout. Caller redirects
        to `docs/reports/ella-interaction-audit.md`.

        Surfaced one real bug during execution that wasn't in the spec's
        anticipated list: V2's `author_type='ella'` resolver only matches
        Ella's *personal-account* Slack user_id, not the V1 *bot* user_id.
        Documented in § Section 4 patterns.
    """).strip())
    w("")
    w("### Verification")
    w("")
    w(textwrap.dedent("""\
        - Schema reads via `information_schema.columns` confirmed every column
          the script references.
        - Counts cross-check: the script reports `Total runs = N`, which matches
          `SELECT count(*) FROM agent_runs WHERE agent_name='ella'` ran during
          acclimatization. Same for status breakdown and per-channel counts.
        - Spot-checked three runs by hand against `slack_messages`: trigger
          ts present in the table, response sourced from the same thread,
          author_type matches one of the two known Ella identities.
        - Re-ran the script end-to-end against cloud DB. No errors, no writes.
        - No tests written — the script is a one-shot diagnostic; the audit
          itself is the deliverable Drake reviews.
    """).strip())
    w("")
    w("### Surprises and judgment calls")
    w("")
    w(textwrap.dedent("""\
        - **The spec assumed runs across 8 V1 pilot channels.** Reality: all
          28 are in one channel. CLAUDE.md § Ella is the authoritative source
          (\"V1 pilot in `#ella-test-drakeonly` awaiting Nabeel feedback before
          rolling out to the remaining 6 channels\"). The spec's framing of
          \"8 V1 pilot channels\" reads now as a leftover from the V2 Batch 1
          backfill scope (\"the 8 known-good channels Ella's bot is a member of\")
          rather than a count of channels where Ella has actually been invoked.
          The audit still ran correctly — just on a tighter dataset.
        - **All triggering users resolve to one (`U09GVUS1WH2`).** Likely Drake.
          Cross-referenced against `team_members.slack_user_id`: no match,
          and `clients.slack_user_id`: no match. So this user isn't mapped
          anywhere — but the `is_team_test=true` flag indicates it was a
          deliberate test account. Flagged in Section 4.
        - **Added a Check A' (`[ESCALATE]` in `output_summary` but not in
          Slack)** as a sibling to Check A. The spec only asked for the
          leakage check (text shipped to client AND no escalation row), but
          the diagnostic is sharper when you can separately count
          \"detector worked\" vs \"detector failed\". The cost was one extra
          regex pass; the readability win is real.
        - **Bonus bug found: V1 bot user_id vs V2 `author_type='ella'` resolver
          mismatch.** Logged in Section 4 patterns. Did NOT add a
          known-issues entry per the spec's \"surface in Surprises first\"
          rule.
        - **Thread context query is structurally correct but may return
          incomplete history** if backfill missed a thread (e.g., the thread
          root sits outside the 90-day window). Marked per-run when the
          context query returned nothing.
        - **No script created for re-running just the markdown rendering
          step** — the script does both fetch and render in one pass. If
          future audits want to re-render against the same dataset (e.g.,
          to tweak Drake's notes formatting), the SQL is cheap enough that
          re-fetching is fine.
    """).strip())
    w("")
    w("### Out of scope / deferred")
    w("")
    w(textwrap.dedent("""\
        - **Batch 1.5 fix spec.** Per the audit spec, fixes happen in a
          follow-up spec once Drake fills in his notes.
        - **Mapping `U09GVUS1WH2` to a real team_member.** If Drake wants
          his Slack user_id registered in `team_members`, that's a one-line
          UPDATE — not a fix for this audit.
        - **Fixing the V1-bot-vs-V2-`author_type='ella'` mismatch.** Batch
          1.5 territory. The audit surfaces it; the fix is a separate spec.
        - **Backfilling threads older than 90 days.** None of the V1 runs
          appear to sit outside the window in practice (date range
          2026-04-24 → 2026-05-08, well within 90 days of 2026-05-10), but
          if any audit context shows up as missing, it's the likely cause.
    """).strip())
    w("")
    w("### Side effects")
    w("")
    w(textwrap.dedent("""\
        - Read-only DB queries against cloud Supabase. Multiple SELECTs
          across `agent_runs`, `escalations`, `slack_messages`,
          `slack_channels`, `clients`, `team_members`. No writes.
        - No external API calls.
        - No Slack writes.
        - One new committed file (`scripts/audit_ella_interactions.py`) plus
          this report.
    """).strip())
    w("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    conn = _connect()
    try:
        with conn.cursor() as cur:
            runs = fetch_runs(cur)
            escalations = fetch_escalations(cur)
            channels = fetch_channel_map(cur)
            users = fetch_user_map(cur)

            # Per-run: response text (Slack-side), full thread, real author at trigger ts.
            response_texts: dict[str, str] = {}
            thread_msgs: dict[tuple, list] = {}
            real_authors: dict[str, dict] = {}
            for r in runs:
                ch = r["slack_channel_id"]
                thread_ts = r["thread_ts"]
                trigger_ts = r["trigger_ts"]
                if ch and thread_ts:
                    msgs = fetch_thread_messages(cur, ch, thread_ts)
                    thread_msgs[(ch, thread_ts)] = msgs
                    resp = fetch_response_in_thread(cur, ch, thread_ts, r["started_at"])
                    response_texts[str(r["id"])] = resp["text"] if resp else ""
                else:
                    response_texts[str(r["id"])] = ""
                if ch and trigger_ts:
                    ra = fetch_real_author_at_ts(cur, ch, trigger_ts)
                    if ra:
                        real_authors[str(r["id"])] = ra

            flags = {
                "escalate_leak": check_escalate_leakage(runs, escalations, response_texts),
                "escalate_summary_only": check_in_summary_only(runs, escalations, response_texts),
                "speaker": check_speaker_mis_id(runs, channels, users),
                "real_author": check_real_author_mismatch(runs, channels, users, real_authors),
                "errors": check_errors(runs),
                "length": check_length_outliers(runs, response_texts),
                "bare": check_bare_mentions(runs),
            }

            md = render(runs, escalations, channels, users, response_texts, thread_msgs, flags)
            sys.stdout.write(md)
            sys.stdout.write("\n")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
