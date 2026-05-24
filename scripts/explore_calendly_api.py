"""Read-only discovery probe against the Calendly API.

Spec: docs/specs/calendly-discovery.md. Throwaway investigation —
no ingestion-module shape decisions in here.

NEVER writes to Calendly. NEVER writes to Supabase. Reads
CALENDLY_API_KEY from .env.local (spec said CALENDLY_API_TOKEN but
the real env var is CALENDLY_API_KEY — documented in the report).

Run from the repo root:

    python3 scripts/explore_calendly_api.py

Outputs land under .probe-out/calendly/ (git-ignored via .probe-out/).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse


REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env.local"
OUT_DIR = REPO_ROOT / ".probe-out" / "calendly"

BASE_URL = "https://api.calendly.com"

# Sampling budget — keep cheap.
EVENTS_LOOKBACK_DAYS = 30
EVENTS_TARGET_COUNT = 80  # we want ~30-50 per spec; pull a bit more for headroom


def load_token() -> str:
    if not ENV_PATH.exists():
        raise SystemExit(f"HARD STOP: {ENV_PATH} not found")
    for raw in ENV_PATH.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        # Spec said CALENDLY_API_TOKEN; real env var is CALENDLY_API_KEY.
        # Accept either, prefer the one that's set.
        if k.strip() in ("CALENDLY_API_KEY", "CALENDLY_API_TOKEN"):
            val = v.strip().strip("'").strip('"')
            if val:
                return val
    raise SystemExit(
        "HARD STOP: neither CALENDLY_API_KEY nor CALENDLY_API_TOKEN present "
        "in .env.local"
    )


def _request(
    path_or_url: str,
    token: str,
    *,
    params: dict[str, Any] | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """GET. Path joins to BASE_URL; full URL passes through (for pagination
    next_page URLs which Calendly returns as absolute)."""
    if path_or_url.startswith("http"):
        url = path_or_url
    else:
        url = f"{BASE_URL}{path_or_url}"
    if params:
        url = f"{url}?{urlencode(params)}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        # Calendly sits behind Cloudflare which 403s the default Python-urllib
        # UA (error 1010: browser_signature_banned). A normal UA passes.
        "User-Agent": "ai-enablement/1.0 (+drake@theaipartner.io)",
    }
    for attempt in range(3):
        req = urllib.request.Request(url, method="GET", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode()
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise SystemExit(
                    f"HARD STOP: {e.code} on {path_or_url}. "
                    f"Body: {e.read().decode()[:500]}"
                )
            if e.code == 429 and attempt < 2:
                retry = int(e.headers.get("Retry-After", "5"))
                print(f"  [429] back off {retry}s")
                time.sleep(retry)
                continue
            body = ""
            try:
                body = e.read().decode()[:500]
            except Exception:
                pass
            return {"_http_error": e.code, "_body": body, "_path": path_or_url}
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < 2:
                time.sleep(2 + attempt * 2)
                continue
            return {"_error": str(e), "_path": path_or_url}
    return {"_error": "exhausted retries", "_path": path_or_url}


def _write(name: str, payload: Any) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    p = OUT_DIR / name
    p.write_text(json.dumps(payload, indent=2, sort_keys=True, default=str))
    return p


def main() -> int:
    print("=" * 70)
    print("Calendly discovery probe — read-only")
    print("=" * 70)
    token = load_token()
    print(f"Loaded Calendly bearer token (len={len(token)}) from {ENV_PATH}")

    # ---- 1. Auth + org ---------------------------------------------------
    print("\n[1] GET /users/me — auth check + organization URI")
    me = _request("/users/me", token)
    _write("01_me.json", me)
    if "_http_error" in me or "_error" in me:
        print(f"    ERROR: {me}")
        return 2
    user_obj = me.get("resource") or me
    user_uri = user_obj.get("uri")
    user_email = user_obj.get("email")
    user_name = user_obj.get("name")
    org_uri = user_obj.get("current_organization")
    print(f"    user:  {user_name!r}  <{user_email}>")
    print(f"    uri:   {user_uri}")
    print(f"    org:   {org_uri}")
    if not org_uri:
        print("    WARN: no current_organization on /users/me response — cannot proceed")
        return 2

    # ---- 2. Event-type catalog ------------------------------------------
    print("\n[2] GET /event_types — event-type catalog (how 'closer' bookings are likely identified)")
    types_resp = _request("/event_types", token, params={"organization": org_uri, "count": 100})
    _write("02_event_types.json", types_resp)
    types = types_resp.get("collection", [])
    print(f"    total event types: {len(types)}")
    if types:
        print(f"    {'kind':>8} {'duration':>10} {'active':>7}  name  (uri)")
        for t in types:
            print(f"    {(t.get('kind') or '?'):>8} {(str(t.get('duration')) + 'm'):>10} "
                  f"{str(t.get('active')):>7}  {t.get('name')!r}  "
                  f"({(t.get('uri') or '')[-40:]})")

    # ---- 3. Sample real scheduled events --------------------------------
    print(f"\n[3] GET /scheduled_events — sample last {EVENTS_LOOKBACK_DAYS}d (~{EVENTS_TARGET_COUNT} events)")
    min_start = (datetime.now(timezone.utc) - timedelta(days=EVENTS_LOOKBACK_DAYS)).isoformat()
    max_start = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()  # include some future
    all_events: list[dict[str, Any]] = []
    next_url: str | None = None
    page = 1
    while page <= 5 and len(all_events) < EVENTS_TARGET_COUNT:
        if next_url:
            resp = _request(next_url, token)
        else:
            resp = _request("/scheduled_events", token, params={
                "organization": org_uri,
                "count": 100,
                "min_start_time": min_start,
                "max_start_time": max_start,
                "sort": "start_time:desc",
            })
        if "_http_error" in resp or "_error" in resp:
            print(f"    ERROR page {page}: {resp}")
            break
        events = resp.get("collection", [])
        all_events.extend(events)
        pagination = resp.get("pagination") or {}
        next_url = pagination.get("next_page")
        print(f"    page {page}: +{len(events)} events  (total now: {len(all_events)})  "
              f"next_page={'yes' if next_url else 'no'}")
        if not next_url:
            break
        page += 1
    _write("03_scheduled_events.json", all_events)
    print(f"    total sampled: {len(all_events)} events")

    if all_events:
        # Status + event-type distribution
        statuses = Counter(e.get("status") for e in all_events)
        type_names: Counter[str] = Counter()
        host_names: Counter[str] = Counter()
        for e in all_events:
            # event_type is a URI; we want to resolve it to a name via the catalog
            type_uri = e.get("event_type")
            if isinstance(type_uri, str):
                # short id at the end
                short = type_uri.split("/")[-1]
                # try to match against catalog
                name = next(
                    (t.get("name") for t in types if t.get("uri") == type_uri),
                    short,
                )
                type_names[name] += 1
            # event_memberships → host
            for em in (e.get("event_memberships") or []):
                # the user field is a URI in v2; name may not be in event object
                u = em.get("user")
                u_email = em.get("user_email")
                u_name = em.get("user_name")
                key = u_name or u_email or u or "?"
                host_names[key] += 1

        print(f"\n    status breakdown: {dict(statuses)}")
        print(f"\n    event-type distribution (top 10):")
        for nm, n in type_names.most_common(10):
            print(f"      {n:>4}  {nm!r}")
        print(f"\n    host distribution (top 10):")
        for nm, n in host_names.most_common(10):
            print(f"      {n:>4}  {nm}")

        # Sample 2-3 events full-shape
        print(f"\n    Sample event keys (first event):")
        sample = all_events[0]
        print(f"      keys: {sorted(sample.keys())}")
        print(f"      sample[0] (trimmed):")
        for k in ("uri", "name", "status", "start_time", "end_time", "created_at",
                  "updated_at", "event_type", "location", "invitees_counter",
                  "event_memberships"):
            if k in sample:
                v = sample[k]
                vs = json.dumps(v, default=str)
                print(f"        {k}: {vs[:120]}")

        # Date math feasibility: created_at + start_time both present?
        with_both = sum(
            1 for e in all_events
            if e.get("created_at") and e.get("start_time")
        )
        print(f"\n    Date-math feasibility: {with_both}/{len(all_events)} events have BOTH created_at + start_time")

        # Sample of created_at → start_time deltas (days)
        print(f"\n    Sample created→start deltas (first 10 active events):")
        active = [e for e in all_events if e.get("status") == "active"][:10]
        for e in active:
            try:
                c = datetime.fromisoformat(e["created_at"].replace("Z", "+00:00"))
                s = datetime.fromisoformat(e["start_time"].replace("Z", "+00:00"))
                delta_days = (s.date() - c.date()).days
                print(f"      created={c.date()} start={s.date()} delta={delta_days}d  "
                      f"type={e.get('name')!r}")
            except Exception as ex:
                print(f"      ERROR parsing: {ex}")

    # ---- 4. Inspect one event's invitee detail for reschedule/cancel signals
    print("\n[4] GET /scheduled_events/{uuid}/invitees — invitee detail for ONE recent event")
    if all_events:
        first_uri = all_events[0].get("uri", "")
        first_uuid = first_uri.split("/")[-1] if first_uri else None
        if first_uuid:
            inv_resp = _request(f"/scheduled_events/{first_uuid}/invitees", token)
            _write("04_first_event_invitees.json", inv_resp)
            invs = inv_resp.get("collection", []) if isinstance(inv_resp, dict) else []
            print(f"    invitee count: {len(invs)}")
            if invs:
                inv = invs[0]
                print(f"    invitee keys: {sorted(inv.keys())}")
                for k in ("email", "name", "status", "created_at", "updated_at",
                          "cancel_url", "reschedule_url", "rescheduled",
                          "old_invitee", "new_invitee", "cancellation"):
                    if k in inv:
                        v = inv[k]
                        vs = json.dumps(v, default=str)
                        print(f"      {k}: {vs[:150]}")

    # ---- 5. Canceled events — look for reschedule lineage --------------
    print("\n[5] GET /scheduled_events?status=canceled — sample reschedule/cancel signals")
    canceled = _request("/scheduled_events", token, params={
        "organization": org_uri,
        "count": 30,
        "min_start_time": min_start,
        "max_start_time": max_start,
        "status": "canceled",
        "sort": "start_time:desc",
    })
    _write("05_canceled_events.json", canceled)
    canc_col = canceled.get("collection", []) if isinstance(canceled, dict) else []
    print(f"    canceled events in window: {len(canc_col)}")
    if canc_col:
        sample = canc_col[0]
        print(f"    sample canceled event — extra/distinct fields beyond active:")
        active_keys = set(all_events[0].keys()) if all_events else set()
        for k in sorted(sample.keys()):
            if k not in active_keys:
                print(f"      NEW: {k}: {json.dumps(sample[k], default=str)[:120]}")
        # Look for cancellation sub-object
        for k in ("cancellation", "old_invitee", "rescheduled", "rescheduled_event"):
            if k in sample:
                print(f"      cancel-signal {k}: {json.dumps(sample[k], default=str)[:200]}")

    # ---- 6. Webhook subscriptions (plan-tier indicator) ----------------
    print("\n[6] GET /webhook_subscriptions — list (tier indicator)")
    webhooks = _request("/webhook_subscriptions", token, params={
        "organization": org_uri,
        "scope": "organization",
        "count": 50,
    })
    _write("06_webhooks.json", webhooks)
    if isinstance(webhooks, dict):
        if "_http_error" in webhooks:
            code = webhooks["_http_error"]
            print(f"    HTTP {code}: {webhooks.get('_body', '')[:300]}")
            if code in (403, 404):
                print(f"    (likely plan-tier limitation — webhooks may require Standard+)")
        else:
            col = webhooks.get("collection", [])
            print(f"    existing webhook subscriptions: {len(col)}")
            for w in col[:10]:
                print(f"      - {w.get('uri', '')[-40:]}  callback={w.get('callback_url')}  "
                      f"events={w.get('events')}  state={w.get('state')}")

    print("\n" + "=" * 70)
    print(f"Done. Outputs under: {OUT_DIR}")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
