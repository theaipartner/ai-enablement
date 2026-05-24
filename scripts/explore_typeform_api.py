"""Read-only discovery probe against the Typeform API.

Spec: docs/specs/typeform-discovery.md. Throwaway investigation —
no ingestion-module shape decisions in here, no schema, no Supabase
writes.

NEVER writes to Typeform. Reads the PAT from .env.local. Spec named
the env var TYPEFORM_API_TOKEN; the real var is TYPEFORM_API_KEY —
accept either, prefer the one that's set (mirrors the Calendly probe).

Run from the repo root:

    python3 scripts/explore_typeform_api.py

Outputs land under .probe-out/typeform/ (git-ignored via .probe-out/).
PII (emails, names, phones, free-text answers that could carry PII) is
masked before being printed or written to the committed report. The
raw .probe-out/ dump is local-only — never commit it.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode


REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env.local"
OUT_DIR = REPO_ROOT / ".probe-out" / "typeform"

BASE_URL = "https://api.typeform.com"

# Sampling budget — discovery only, keep cheap.
FORMS_PAGE_SIZE = 200  # /forms accepts up to 200
RESPONSES_SAMPLE_PAGE_SIZE = 3  # for shape inspection
TOP_FORMS_TO_INSPECT = 5  # pull definitions + response samples for the top-N by volume

# Types whose `.value` strings could carry PII and must be masked.
PII_ANSWER_TYPES = {"email", "phone_number", "text", "long_text", "url"}


def load_token() -> tuple[str, str]:
    """Return (token, env_var_name_actually_used)."""
    if not ENV_PATH.exists():
        raise SystemExit(f"HARD STOP: {ENV_PATH} not found")
    found: dict[str, str] = {}
    for raw in ENV_PATH.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() in ("TYPEFORM_API_KEY", "TYPEFORM_API_TOKEN"):
            val = v.strip().strip("'").strip('"')
            if val:
                found[k.strip()] = val
    if not found:
        raise SystemExit(
            "HARD STOP: neither TYPEFORM_API_KEY nor TYPEFORM_API_TOKEN "
            "present + non-empty in .env.local"
        )
    # Prefer TYPEFORM_API_TOKEN if both are set (spec's intended name);
    # fall back to TYPEFORM_API_KEY (the actual current name).
    for name in ("TYPEFORM_API_TOKEN", "TYPEFORM_API_KEY"):
        if name in found:
            return found[name], name
    raise SystemExit("unreachable")


def _request(
    path_or_url: str,
    token: str,
    *,
    params: dict[str, Any] | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """GET. Path joins to BASE_URL; full URL passes through unchanged."""
    if path_or_url.startswith("http"):
        url = path_or_url
    else:
        url = f"{BASE_URL}{path_or_url}"
    if params:
        url = f"{url}?{urlencode(params)}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
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


def _mask_answer(ans: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of an answer with PII-carrying values redacted.

    Preserves the SHAPE (keys, type tag, field reference) so the report
    can show structure without leaking respondent data.
    """
    masked = dict(ans)
    a_type = masked.get("type")
    if a_type in PII_ANSWER_TYPES:
        # Replace the value with a shape-preserving placeholder.
        if a_type == "email":
            masked[a_type] = "<redacted-email>"
        elif a_type == "phone_number":
            masked[a_type] = "<redacted-phone>"
        elif a_type in ("text", "long_text"):
            orig = masked.get(a_type, "")
            length = len(orig) if isinstance(orig, str) else 0
            masked[a_type] = f"<redacted-{a_type} len={length}>"
        elif a_type == "url":
            masked[a_type] = "<redacted-url>"
    return masked


def _mask_hidden(hidden: dict[str, Any] | None) -> dict[str, Any]:
    """Hidden fields often carry email/phone tracking params — mask values
    but keep keys so the schema-relevant shape is visible."""
    if not hidden:
        return {}
    EMAIL_RX = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
    out: dict[str, Any] = {}
    for k, v in hidden.items():
        if not isinstance(v, str):
            out[k] = v
            continue
        if EMAIL_RX.search(v):
            out[k] = "<redacted-email>"
        elif k.lower() in {"name", "first_name", "last_name", "phone", "email"}:
            out[k] = f"<redacted-{k}>"
        else:
            # Keep tracking params (utm_*, gclid, etc.) visible — those are
            # marketing attribution, not PII.
            out[k] = v
    return out


def main() -> int:
    print("=" * 70)
    print("Typeform discovery probe — read-only")
    print("=" * 70)
    token, token_var = load_token()
    print(f"Loaded Typeform bearer token (len={len(token)}) from {ENV_PATH}")
    print(f"  env var actually used: {token_var}")

    # ---- 1. Auth check --------------------------------------------------
    print("\n[1] GET /me — auth check + account identity")
    me = _request("/me", token)
    _write("01_me.json", me)
    if "_http_error" in me or "_error" in me:
        print(f"    ERROR: {me}")
        return 2
    print(f"    alias:    {me.get('alias')!r}")
    print(f"    email:    {me.get('email')!r}  (account owner — not respondent PII)")
    print(f"    language: {me.get('language')!r}")

    # ---- 2. Full form inventory -----------------------------------------
    print("\n[2] GET /forms — full form inventory (paginated)")
    all_forms: list[dict[str, Any]] = []
    page = 1
    while True:
        resp = _request(
            "/forms",
            token,
            params={"page": page, "page_size": FORMS_PAGE_SIZE},
        )
        if "_http_error" in resp or "_error" in resp:
            print(f"    ERROR page {page}: {resp}")
            break
        items = resp.get("items", [])
        all_forms.extend(items)
        total_items = resp.get("total_items")
        page_count = resp.get("page_count")
        print(
            f"    page {page}: +{len(items)} forms  (running total: {len(all_forms)})  "
            f"total_items={total_items}  page_count={page_count}"
        )
        if page >= (page_count or 1) or not items:
            break
        page += 1
        if page > 20:
            print("    safety break at page 20")
            break
    _write("02_forms.json", all_forms)
    print(f"    total forms in account: {len(all_forms)}")

    # Compact table of form metadata. We DON'T have response counts yet —
    # /forms doesn't include them. We fetch counts via /forms/{id}/responses
    # with page_size=1 in the next step.
    if all_forms:
        print(f"\n    Form metadata (id, last_updated_at, title):")
        for f in all_forms[:50]:
            print(
                f"      {f.get('id'):>10}  {(f.get('last_updated_at') or '')[:19]}  "
                f"{(f.get('title') or '')[:80]}"
            )
        if len(all_forms) > 50:
            print(f"      … ({len(all_forms) - 50} more — see 02_forms.json)")

    # ---- 3. Response counts per form ------------------------------------
    print("\n[3] GET /forms/{id}/responses?page_size=1 — pull total_items per form")
    counts: list[tuple[str, str, int, str | None]] = []  # (id, title, total, last_submitted)
    for f in all_forms:
        fid = f.get("id")
        title = f.get("title") or ""
        if not fid:
            continue
        resp = _request(
            f"/forms/{fid}/responses",
            token,
            params={"page_size": 1},
        )
        if "_http_error" in resp:
            code = resp["_http_error"]
            print(f"    [{fid}] HTTP {code} — skip ({title[:50]!r})")
            counts.append((fid, title, -1, None))
            continue
        total = resp.get("total_items", 0)
        items = resp.get("items", [])
        last_submitted = items[0].get("submitted_at") if items else None
        counts.append((fid, title, total, last_submitted))

    _write(
        "03_response_counts.json",
        [
            {"id": fid, "title": title, "total_items": total, "last_submitted_at": last}
            for fid, title, total, last in counts
        ],
    )

    # Sorted by total descending.
    counts.sort(key=lambda x: (x[2] if x[2] >= 0 else -1), reverse=True)
    print(f"\n    Forms by response volume (top 30):")
    print(f"      {'count':>7}  {'last_submitted':>20}  {'id':>10}  title")
    for fid, title, total, last in counts[:30]:
        count_str = "n/a" if total < 0 else f"{total:,}"
        last_str = (last or "—")[:19]
        print(f"      {count_str:>7}  {last_str:>20}  {fid:>10}  {title[:70]!r}")
    if len(counts) > 30:
        zero_count = sum(1 for _, _, t, _ in counts[30:] if t == 0)
        nonzero = len(counts) - 30 - zero_count
        print(f"      … {len(counts) - 30} more ({nonzero} with responses, {zero_count} empty)")

    # ---- 4. Form definitions for top-N candidates ------------------------
    top_candidates = [
        (fid, title, total)
        for fid, title, total, _ in counts
        if total > 0
    ][:TOP_FORMS_TO_INSPECT]

    print(
        f"\n[4] GET /forms/{{id}} — full form definition for top "
        f"{len(top_candidates)} candidate(s) by volume"
    )
    form_defs: dict[str, dict[str, Any]] = {}
    for fid, title, total in top_candidates:
        defn = _request(f"/forms/{fid}", token)
        if "_http_error" in defn:
            print(f"    [{fid}] HTTP {defn['_http_error']} — skip")
            continue
        form_defs[fid] = defn
        _write(f"04_form_def_{fid}.json", defn)

        fields = defn.get("fields", []) or []
        # Flatten group fields (a "group" wraps nested fields with the
        # group's own ref/id — the answer references the inner field).
        flat: list[dict[str, Any]] = []
        for fld in fields:
            if fld.get("type") == "group":
                inner = (fld.get("properties") or {}).get("fields", []) or []
                for sub in inner:
                    flat.append({**sub, "_in_group": fld.get("ref") or fld.get("id")})
            else:
                flat.append(fld)

        hidden_fields = defn.get("hidden", []) or []
        welcome_screens = defn.get("welcome_screens", []) or []
        thankyou_screens = defn.get("thankyou_screens", []) or []
        logic = defn.get("logic", []) or []

        print(f"\n    --- form {fid}: {title[:70]!r} (responses: {total:,}) ---")
        print(
            f"        fields: {len(flat)}  "
            f"(groups flattened from {len(fields)} top-level)  "
            f"hidden: {len(hidden_fields)}  "
            f"welcome_screens: {len(welcome_screens)}  "
            f"thankyou_screens: {len(thankyou_screens)}  "
            f"logic_rules: {len(logic)}"
        )
        if hidden_fields:
            print(f"        hidden field keys: {hidden_fields}")

        # Field-shape distribution: how many of each type
        type_counts = Counter(fld.get("type") for fld in flat)
        print(f"        field-type counts: {dict(type_counts)}")

        # Ref/id population check
        with_ref = sum(1 for fld in flat if fld.get("ref"))
        with_id = sum(1 for fld in flat if fld.get("id"))
        refs = [fld.get("ref") for fld in flat if fld.get("ref")]
        unique_refs = len(set(refs))
        print(
            f"        ref/id presence: with_ref={with_ref}/{len(flat)}  "
            f"with_id={with_id}/{len(flat)}  unique_refs={unique_refs}/{with_ref}"
        )

        # Full field list — these are the questions Drake maps Engine-sheet rows against.
        print(f"        questions (ref | id | type | title[:80]):")
        for fld in flat:
            in_grp = (
                f" [group={fld.get('_in_group')[:10]}]"
                if fld.get("_in_group")
                else ""
            )
            choices = ""
            if fld.get("type") in ("multiple_choice", "dropdown", "picture_choice"):
                opts = ((fld.get("properties") or {}).get("choices") or [])
                if opts:
                    choices = f"  choices=[{', '.join((o.get('label') or '?')[:30] for o in opts[:8])}{'…' if len(opts) > 8 else ''}]"
            print(
                f"          {(fld.get('ref') or '')[:18]:<18} {(fld.get('id') or '')[:10]:<10} "
                f"{(fld.get('type') or '')[:18]:<18} {(fld.get('title') or '')[:80]!r}{in_grp}{choices}"
            )

    # ---- 5. Real response shape (PII masked) -----------------------------
    print(
        f"\n[5] GET /forms/{{id}}/responses?page_size={RESPONSES_SAMPLE_PAGE_SIZE} — "
        f"real response shape for each candidate (PII MASKED before write)"
    )
    response_samples: dict[str, list[dict[str, Any]]] = {}
    for fid, title, total in top_candidates:
        resp = _request(
            f"/forms/{fid}/responses",
            token,
            params={"page_size": RESPONSES_SAMPLE_PAGE_SIZE},
        )
        if "_http_error" in resp:
            print(f"    [{fid}] HTTP {resp['_http_error']} — skip")
            continue
        items = resp.get("items", []) or []
        masked_items: list[dict[str, Any]] = []
        for item in items:
            masked = dict(item)
            masked["hidden"] = _mask_hidden(item.get("hidden"))
            masked["answers"] = [_mask_answer(a) for a in (item.get("answers") or [])]
            masked_items.append(masked)
        response_samples[fid] = masked_items
        _write(f"05_responses_sample_{fid}.json", masked_items)

        print(f"\n    --- responses sample for form {fid}: {title[:60]!r} ---")
        print(f"        items in sample: {len(masked_items)}")
        if not masked_items:
            print("        (form has 0 responses in this page — skipping shape inspection)")
            continue

        first = masked_items[0]
        print(f"        top-level keys: {sorted(first.keys())}")
        for k in ("landed_at", "submitted_at", "response_id", "token"):
            if k in first:
                print(f"          {k}: {first.get(k)!r}")
        meta = first.get("metadata") or {}
        print(f"        metadata keys: {sorted(meta.keys())}")
        print(f"        hidden (masked): {first.get('hidden')}")
        calc = first.get("calculated")
        if calc:
            print(f"        calculated: {calc}")

        print(f"        answers[] shape — first respondent's answers:")
        for ans in first.get("answers", []):
            f_ref = (ans.get("field") or {}).get("ref")
            f_id = (ans.get("field") or {}).get("id")
            f_type = (ans.get("field") or {}).get("type")
            a_type = ans.get("type")
            # The value lives under a key matching a_type (e.g. ans["email"],
            # ans["choice"], ans["choices"], ans["number"], ans["boolean"]…)
            val = ans.get(a_type) if a_type else None
            val_repr = json.dumps(val, default=str)[:120] if val is not None else "—"
            print(
                f"          field.ref={(f_ref or '')[:14]:<14} field.id={(f_id or '')[:10]:<10} "
                f"field.type={(f_type or '')[:14]:<14} answer.type={(a_type or '')[:14]:<14} "
                f"value={val_repr}"
            )

    # ---- 6. Date-filter + history viability ------------------------------
    if top_candidates:
        target_fid, target_title, target_total = top_candidates[0]
        print(
            f"\n[6] Date-filter + pagination viability on top form "
            f"{target_fid} ({target_title[:50]!r}, {target_total:,} responses)"
        )

        # 6a. since/until filter — does it actually constrain?
        since = (datetime.now(timezone.utc) - timedelta(days=30)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        print(f"    [6a] since={since}  page_size=1")
        filt = _request(
            f"/forms/{target_fid}/responses",
            token,
            params={"since": since, "page_size": 1},
        )
        if "_http_error" not in filt:
            tt = filt.get("total_items")
            print(f"        total_items in last 30d: {tt}")
            items = filt.get("items", [])
            if items:
                sub = items[0].get("submitted_at")
                print(f"        most recent submitted_at: {sub}")
        else:
            print(f"        HTTP {filt['_http_error']}: {filt.get('_body', '')[:200]}")

        # 6b. before-cursor pagination
        # IMPORTANT: Typeform rejects `before`/`after` combined with `sort`
        # (returns HTTP 400 BAD_REQUEST). Default sort is submitted_at desc,
        # which is what we want for cursor backfill — so just omit `sort`.
        print(f"\n    [6b] cursor pagination — page_size=3, then before=<oldest token> (NO sort param)")
        first_page = _request(
            f"/forms/{target_fid}/responses",
            token,
            params={"page_size": 3},
        )
        if "_http_error" not in first_page:
            items = first_page.get("items", [])
            print(
                f"        first page: {len(items)} items, "
                f"total_items={first_page.get('total_items')}, "
                f"page_count={first_page.get('page_count')}"
            )
            for i, it in enumerate(items):
                print(
                    f"          [{i}] submitted={it.get('submitted_at')}  "
                    f"token={(it.get('token') or '')[:14]}…"
                )
            if items:
                oldest_token = items[-1].get("token")
                if oldest_token:
                    second_page = _request(
                        f"/forms/{target_fid}/responses",
                        token,
                        params={"page_size": 3, "before": oldest_token},
                    )
                    if "_http_error" not in second_page:
                        items2 = second_page.get("items", [])
                        print(f"        second page (before={oldest_token[:14]}…): {len(items2)} items")
                        for i, it in enumerate(items2):
                            print(
                                f"          [{i}] submitted={it.get('submitted_at')}  "
                                f"token={(it.get('token') or '')[:14]}…"
                            )
                        first_tokens = {it.get("token") for it in items}
                        second_tokens = {it.get("token") for it in items2}
                        overlap = first_tokens & second_tokens
                        print(f"        token overlap between pages: {len(overlap)} (want 0)")
                    else:
                        print(
                            f"        second page HTTP {second_page['_http_error']}: "
                            f"{second_page.get('_body', '')[:200]}"
                        )
        else:
            print(f"        HTTP {first_page['_http_error']}: {first_page.get('_body', '')[:200]}")

        # 6c. oldest response — how far back can we go?
        # sort=submitted_at,asc IS allowed (sort alone is fine; the constraint
        # is only sort + before/after together).
        print(f"\n    [6c] oldest response — sort=submitted_at,asc, page_size=1 (no before/after)")
        oldest = _request(
            f"/forms/{target_fid}/responses",
            token,
            params={"page_size": 1, "sort": "submitted_at,asc"},
        )
        if "_http_error" not in oldest:
            items = oldest.get("items", [])
            if items:
                first_sub = items[0].get("submitted_at")
                print(f"        oldest submitted_at: {first_sub}")
        else:
            print(f"        HTTP {oldest['_http_error']}: {oldest.get('_body', '')[:200]}")

    print("\n" + "=" * 70)
    print(f"Done. Outputs under: {OUT_DIR}")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
