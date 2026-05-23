"""Real-data discovery probe — follow-up to scripts/explore_close_api.py.

Spec: docs/specs/close-full-data-inventory.md

The first probe mapped Close's STRUCTURE (status pipeline, custom-field
definitions, Smartview shapes). This one pulls REAL POPULATED DATA on
~25-30 leads spanning the funnel to answer:

  1. Is call/email/SMS activity actually populated, and how densely?
  2. Of 88 lead custom fields, which actually carry values?
  3. Do opportunities hold real dollar figures (deposit / cash / contracted)?
  4. How far back does activity + status-change history go?

Read-only. Never writes to Close. Never writes to Supabase. Dumps to
.probe-out/close-data/ (git-ignored via .probe-out/).

Run from the repo root:

    python3 scripts/explore_close_data.py
"""

from __future__ import annotations

import base64
import json
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env.local"
OUT_DIR = REPO_ROOT / ".probe-out" / "close-data"
BASE_URL = "https://api.close.com/api/v1"

# Sampling targets — N leads per status. 11 statuses × 3 = ~33 leads max.
# Some statuses may have <3 leads; that's fine, we take what's there.
LEADS_PER_STATUS = 3

# Per-lead activity pull cap — keep total API calls modest.
ACTIVITY_LIMIT_PER_LEAD = 100

# From scripts/explore_close_api.py + the prior report. Funnel order.
STATUS_LABELS: dict[str, str] = {
    "stat_ZIoyCWBDoWtYQ8EhrO6heT1XMIj4JeIbni74EsAyLiX": "New Opt-in",
    "stat_VXEKegQ4HN87CtntYn7SCwO0ooqHMFKBlp0tJIq6KKs": "Unconfirmed Booking",
    "stat_dppOL2h1QjfH4QcHYI9Vro1LBJDO9bQUiBjCa83e4y1": "Confirmed Booking",
    "stat_GZca7DExvxZ2FkjKNFgWxqrlKwB1ULxA2xKrYszhVf5": "Unconfirmed Booking - Handed over",
    "stat_KB9FLz9aEKeEHmBKqMCB8O78tZZYd3poZIlhWhER8ZK": "Client",
    "stat_Vxh3lRMy5TpkzA8Ihsq1hueVwIeQGluaNjpxdfm46FT": "Deposit",
    "stat_1uxT6m8Gkkn31Xkmiix215MHAEJEqSWWGJgshpZpM8Y": "Downsell",
    "stat_bSMAvQf4TaJGMVo4m8hQ9pWDps0E4WWZg3DtLfUpSK3": "In Sales Process",
    "stat_SSav2flRTzIwoRY9WMMJNIRwhuerxW5Ff1gLq5nRvdq": "No Show",
    "stat_vpKV1nMQWxJNg9Tl4w3diIswy1Ty1mXrCdFhlO8pwvu": "Deal Lost",
    "stat_Sy5P7oFaIcdSOAON2XY1ELblocmqzvnB7ie7cMQllSX": "Disqualified Lead",
}


def load_close_key() -> str:
    if not ENV_PATH.exists():
        raise SystemExit(f"HARD STOP: {ENV_PATH} not found")
    for raw in ENV_PATH.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == "CLOSE_API_KEY":
            return v.strip().strip("'").strip('"')
    raise SystemExit("HARD STOP: CLOSE_API_KEY not in .env.local")


def _auth_header(api_key: str) -> str:
    token = base64.b64encode(f"{api_key}:".encode()).decode()
    return f"Basic {token}"


def _request(
    method: str,
    path: str,
    api_key: str,
    *,
    params: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None,
    timeout: float = 60.0,
) -> dict[str, Any]:
    url = f"{BASE_URL}{path}"
    if params:
        url = f"{url}?{urlencode(params)}"
    data = None
    headers = {
        "Authorization": _auth_header(api_key),
        "Accept": "application/json",
    }
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"

    last_err: Exception | None = None
    for attempt in range(3):
        req = urllib.request.Request(url, method=method, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = resp.read().decode()
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise SystemExit(
                    f"HARD STOP: {e.code} on {method} {path}. "
                    f"Body: {e.read().decode()[:500]}"
                )
            if e.code == 429 and attempt < 2:
                retry_after = int(e.headers.get("Retry-After", "5"))
                print(f"  [429] backoff {retry_after}s")
                time.sleep(retry_after)
                continue
            body_text = ""
            try:
                body_text = e.read().decode()[:1000]
            except Exception:
                pass
            raise RuntimeError(
                f"HTTP {e.code} on {method} {path}: {body_text}"
            ) from e
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            if attempt < 2:
                print(f"  [timeout/network] retry {attempt + 1} on {path}: {e}")
                time.sleep(3)
                continue
            raise RuntimeError(f"Timeout/network on {method} {path}: {e}") from e

    raise RuntimeError(f"Exhausted retries on {method} {path}: {last_err}")


def _write_json(name: str, payload: Any) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    p = OUT_DIR / name
    p.write_text(json.dumps(payload, indent=2, sort_keys=True, default=str))
    return p


def sample_leads_by_status(api_key: str) -> dict[str, list[dict[str, Any]]]:
    """Walk /lead/ pages and bucket into the 11 funnel statuses until we
    have LEADS_PER_STATUS per bucket (or run out of leads).

    Returns dict mapping status_id -> list of lead summaries.
    """
    buckets: dict[str, list[dict[str, Any]]] = {sid: [] for sid in STATUS_LABELS}
    targets = set(STATUS_LABELS.keys())
    skip = 0
    limit = 100
    total_seen = 0
    while True:
        resp = _request(
            "GET",
            "/lead/",
            api_key,
            params={
                "_skip": skip,
                "_limit": limit,
                "_fields": "id,display_name,status_id,status_label,date_created",
            },
        )
        leads = resp.get("data", [])
        total_seen += len(leads)
        for lead in leads:
            sid = lead.get("status_id")
            if sid in targets and len(buckets[sid]) < LEADS_PER_STATUS:
                buckets[sid].append(lead)

        # Are all buckets full or did we run out of leads?
        all_full = all(len(buckets[sid]) >= LEADS_PER_STATUS for sid in targets)
        if all_full:
            print(f"    sampled all 11 status buckets after {total_seen} leads scanned")
            break
        if not resp.get("has_more"):
            print(f"    scanned {total_seen} leads (no more pages)")
            break
        if total_seen >= 2000:
            # Safety net — should never need 2000 leads to hit one per
            # status; if we do, something is off (most likely some
            # statuses have no leads).
            print(f"    safety break at {total_seen} leads; some buckets remain empty")
            break
        skip += len(leads)
    return buckets


def fetch_lead_full(lead_id: str, api_key: str) -> dict[str, Any]:
    """Pull the full lead object including custom-field values."""
    return _request("GET", f"/lead/{lead_id}/", api_key)


def fetch_lead_activities(lead_id: str, api_key: str) -> list[dict[str, Any]]:
    """Pull the activity timeline for a lead, capped at ACTIVITY_LIMIT_PER_LEAD."""
    resp = _request(
        "GET",
        "/activity/",
        api_key,
        params={"lead_id": lead_id, "_limit": ACTIVITY_LIMIT_PER_LEAD},
    )
    return resp.get("data", [])


def fetch_opportunities_sample(api_key: str, limit: int = 30) -> list[dict[str, Any]]:
    """Pull a sample of opportunities to check dollar-field population."""
    resp = _request("GET", "/opportunity/", api_key, params={"_limit": limit})
    return resp.get("data", [])


def load_lead_custom_field_definitions() -> dict[str, dict[str, Any]]:
    """Re-use the prior probe's dump of the lead custom-field schema.

    Falls back to a live fetch if the prior dump isn't on disk.
    """
    prior = REPO_ROOT / ".probe-out" / "close" / "04_custom_field_schemas.json"
    if prior.exists():
        schemas = json.loads(prior.read_text())
        lead_schema = schemas.get("lead") or {}
        return {f["id"]: f for f in (lead_schema.get("fields") or [])}
    return {}


def main() -> int:
    print("=" * 70)
    print("Close CRM data inventory probe — read-only")
    print("=" * 70)

    api_key = load_close_key()
    print(f"Loaded CLOSE_API_KEY (len={len(api_key)}) from {ENV_PATH}")

    # ---- 0. Auth check ---------------------------------------------------
    print("\n[0] GET /me/ — auth check")
    me = _request("GET", "/me/", api_key)
    print(f"    User: {me.get('first_name')} {me.get('last_name')}  "
          f"<{me.get('email')}>")

    # ---- 1. Sample leads across the funnel ------------------------------
    print("\n[1] Sampling leads across the 11 funnel statuses")
    buckets = sample_leads_by_status(api_key)
    bucket_summary = {
        STATUS_LABELS[sid]: len(buckets[sid]) for sid in STATUS_LABELS
    }
    print(f"    Bucket fill: {bucket_summary}")
    _write_json("01_sampled_lead_summaries.json", {
        STATUS_LABELS[sid]: leads for sid, leads in buckets.items()
    })

    sampled_ids = [
        (sid, lead["id"])
        for sid, leads in buckets.items()
        for lead in leads
    ]
    print(f"    Total sampled lead IDs: {len(sampled_ids)}")

    # ---- 2. Pull full lead + activities for each sampled lead ----------
    print("\n[2] Fetching full lead + activities for each sampled lead")
    leads_full: list[dict[str, Any]] = []
    activities_by_lead: dict[str, list[dict[str, Any]]] = {}
    for i, (sid, lead_id) in enumerate(sampled_ids, 1):
        try:
            full = fetch_lead_full(lead_id, api_key)
            acts = fetch_lead_activities(lead_id, api_key)
            leads_full.append(full)
            activities_by_lead[lead_id] = acts
            print(f"    [{i:2}/{len(sampled_ids)}] {STATUS_LABELS[sid][:30]:30}  "
                  f"{lead_id}  activities={len(acts)}")
        except RuntimeError as e:
            print(f"    [{i:2}/{len(sampled_ids)}] ERROR on {lead_id}: {e}")
    _write_json("02_leads_full.json", leads_full)
    _write_json("03_activities_by_lead.json", activities_by_lead)

    # ---- 3. Activity density analysis -----------------------------------
    print("\n[3] Activity density analysis")
    activity_type_counter: Counter[str] = Counter()
    activities_per_lead: list[int] = []
    calls_per_lead: list[int] = []
    emails_per_lead: list[int] = []
    status_changes_per_lead: list[int] = []
    sms_per_lead: list[int] = []
    meetings_per_lead: list[int] = []
    oldest_activity_dt: datetime | None = None
    newest_activity_dt: datetime | None = None
    call_user_ids: set[str] = set()

    for lead_id, acts in activities_by_lead.items():
        activities_per_lead.append(len(acts))
        c = e = sc = sms = mt = 0
        for a in acts:
            t = a.get("_type") or "<unknown>"
            activity_type_counter[t] += 1
            if t == "Call":
                c += 1
                if a.get("user_id"):
                    call_user_ids.add(a["user_id"])
            elif t == "Email":
                e += 1
            elif t == "LeadStatusChange":
                sc += 1
            elif t == "SMS":
                sms += 1
            elif t == "Meeting":
                mt += 1
            for dt_field in ("activity_at", "date_created"):
                dt_str = a.get(dt_field)
                if not dt_str:
                    continue
                try:
                    dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
                except ValueError:
                    continue
                if oldest_activity_dt is None or dt < oldest_activity_dt:
                    oldest_activity_dt = dt
                if newest_activity_dt is None or dt > newest_activity_dt:
                    newest_activity_dt = dt
                break
        calls_per_lead.append(c)
        emails_per_lead.append(e)
        status_changes_per_lead.append(sc)
        sms_per_lead.append(sms)
        meetings_per_lead.append(mt)

    def _stats(label: str, vals: list[int]) -> dict[str, Any]:
        if not vals:
            return {"label": label, "n": 0}
        s = sorted(vals)
        n = len(s)
        return {
            "label": label,
            "n_leads": n,
            "total": sum(s),
            "median": s[n // 2],
            "mean": round(sum(s) / n, 2),
            "min": s[0],
            "max": s[-1],
            "n_zero": sum(1 for v in s if v == 0),
            "pct_with_any": round(100 * sum(1 for v in s if v > 0) / n, 1),
        }

    density = {
        "activity_type_counts_total": dict(activity_type_counter),
        "stats": {
            "activities_per_lead": _stats("any activity", activities_per_lead),
            "calls_per_lead": _stats("Call", calls_per_lead),
            "emails_per_lead": _stats("Email", emails_per_lead),
            "status_changes_per_lead": _stats("LeadStatusChange", status_changes_per_lead),
            "sms_per_lead": _stats("SMS", sms_per_lead),
            "meetings_per_lead": _stats("Meeting", meetings_per_lead),
        },
        "oldest_activity_seen": str(oldest_activity_dt) if oldest_activity_dt else None,
        "newest_activity_seen": str(newest_activity_dt) if newest_activity_dt else None,
        "distinct_call_user_ids": sorted(call_user_ids),
    }
    _write_json("04_activity_density.json", density)
    print(f"    Total activities seen: {sum(activity_type_counter.values())}")
    print(f"    Activity types: {dict(activity_type_counter)}")
    print(f"    Calls/lead median: {density['stats']['calls_per_lead']['median']}, "
          f"max: {density['stats']['calls_per_lead']['max']}, "
          f"% leads with ≥1 call: {density['stats']['calls_per_lead']['pct_with_any']}")
    print(f"    Emails/lead median: {density['stats']['emails_per_lead']['median']}, "
          f"% leads with ≥1 email: {density['stats']['emails_per_lead']['pct_with_any']}")
    print(f"    Status changes/lead median: {density['stats']['status_changes_per_lead']['median']}")
    print(f"    Oldest activity: {density['oldest_activity_seen']}")
    print(f"    Distinct call user_ids: {len(call_user_ids)}")

    # ---- 4. Custom-field population inventory ---------------------------
    print("\n[4] Custom-field population inventory")
    cf_defs = load_lead_custom_field_definitions()
    print(f"    Loaded {len(cf_defs)} lead custom-field definitions")

    # custom field values on a lead are exposed as top-level keys
    # "custom.cf_XXXX" : value
    cf_populated_counts: Counter[str] = Counter()
    cf_sample_values: dict[str, Any] = {}
    for lead in leads_full:
        for key, val in lead.items():
            if not key.startswith("custom.cf_"):
                continue
            cf_id = key.split(".", 1)[1]
            if val is None or val == "" or val == []:
                continue
            cf_populated_counts[cf_id] += 1
            if cf_id not in cf_sample_values:
                cf_sample_values[cf_id] = val

    cf_inventory = []
    for cf_id, count in cf_populated_counts.most_common():
        d = cf_defs.get(cf_id, {})
        cf_inventory.append({
            "cf_id": cf_id,
            "name": d.get("name", "<unknown>"),
            "type": d.get("type"),
            "choices": d.get("choices"),
            "is_shared": d.get("is_shared"),
            "n_leads_populated": count,
            "pct_leads_populated": round(100 * count / len(leads_full), 1) if leads_full else 0,
            "sample_value": cf_sample_values.get(cf_id),
        })
    # Also include defined-but-never-populated fields (Engine sheet may
    # reference fields that haven't been backfilled).
    defined_not_populated = [
        {
            "cf_id": cf_id,
            "name": d.get("name"),
            "type": d.get("type"),
        }
        for cf_id, d in cf_defs.items()
        if cf_id not in cf_populated_counts
    ]
    _write_json("05_custom_field_inventory.json", {
        "n_leads_sampled": len(leads_full),
        "populated": cf_inventory,
        "defined_but_not_populated_in_sample": defined_not_populated,
    })
    print(f"    Populated fields (≥1 lead in sample): {len(cf_inventory)}")
    print(f"    Defined-but-never-populated in sample: {len(defined_not_populated)}")
    print(f"    Top 10 most-populated fields:")
    for row in cf_inventory[:10]:
        sval = repr(row["sample_value"])[:60]
        print(f"      {row['n_leads_populated']:3}/{len(leads_full)}  "
              f"{(row['name'] or '<?>'):40}  ({row['type']})  e.g. {sval}")

    # ---- 5. Opportunities ----------------------------------------------
    print("\n[5] Opportunities sample")
    try:
        opps = fetch_opportunities_sample(api_key, limit=30)
        _write_json("06_opportunities_sample.json", opps)
        n_with_value = sum(1 for o in opps if o.get("value"))
        n_with_value_period = sum(1 for o in opps if o.get("value_period"))
        n_with_date_won = sum(1 for o in opps if o.get("date_won"))
        n_with_date_lost = sum(1 for o in opps if o.get("date_lost"))
        n_with_confidence = sum(1 for o in opps if o.get("confidence") not in (None, 0))
        status_label_counts = Counter(o.get("status_label") for o in opps)
        status_type_counts = Counter(o.get("status_type") for o in opps)
        value_sample_rows: list[dict[str, Any]] = []
        for o in opps[:5]:
            value_sample_rows.append({
                "id": o.get("id"),
                "value": o.get("value"),
                "value_currency": o.get("value_currency"),
                "value_period": o.get("value_period"),
                "value_formatted": o.get("value_formatted"),
                "annualized_value": o.get("annualized_value"),
                "expected_value": o.get("expected_value"),
                "status_label": o.get("status_label"),
                "status_type": o.get("status_type"),
                "confidence": o.get("confidence"),
                "date_won": o.get("date_won"),
                "date_lost": o.get("date_lost"),
                "user_id": o.get("user_id"),
                "lead_id": o.get("lead_id"),
                "note": o.get("note"),
            })
        opp_summary = {
            "n_opportunities_sampled": len(opps),
            "n_with_value": n_with_value,
            "n_with_value_period": n_with_value_period,
            "n_with_date_won": n_with_date_won,
            "n_with_date_lost": n_with_date_lost,
            "n_with_confidence": n_with_confidence,
            "status_label_counts": dict(status_label_counts),
            "status_type_counts": dict(status_type_counts),
            "sample_rows": value_sample_rows,
        }
        _write_json("06b_opportunities_summary.json", opp_summary)
        print(f"    Sampled: {len(opps)}; with value set: {n_with_value}; "
              f"with date_won: {n_with_date_won}; with date_lost: {n_with_date_lost}")
        print(f"    Status type breakdown: {dict(status_type_counts)}")
        print(f"    Status label breakdown: {dict(status_label_counts)}")
    except RuntimeError as e:
        print(f"    ERROR: {e}")

    # ---- 6. History depth ------------------------------------------------
    # Pull the OLDEST activity across all sampled leads and the OLDEST
    # status-change date to scope backfill.
    print("\n[6] History depth (across sampled leads)")
    print(f"    Oldest activity in sample: {density['oldest_activity_seen']}")
    print(f"    Newest activity in sample: {density['newest_activity_seen']}")
    status_change_dates: list[str] = []
    for acts in activities_by_lead.values():
        for a in acts:
            if a.get("_type") == "LeadStatusChange":
                dt = a.get("date_created") or a.get("activity_at")
                if dt:
                    status_change_dates.append(dt)
    if status_change_dates:
        status_change_dates.sort()
        print(f"    Oldest LeadStatusChange in sample: {status_change_dates[0]}")
        print(f"    Newest LeadStatusChange in sample: {status_change_dates[-1]}")
        print(f"    Total LeadStatusChange activities seen: {len(status_change_dates)}")
    else:
        print("    No LeadStatusChange activities in sample")

    print("\n" + "=" * 70)
    print(f"Done. Outputs under: {OUT_DIR}")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
