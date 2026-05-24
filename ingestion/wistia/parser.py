"""Parse Wistia API payloads → row dicts for upsert.

Pure projection — no derivations. Engagement-rate + avg-view-duration
live in the future aggregation/dashboard layer; this module only
mirrors raw fields.

Two layout-projecting functions, one for each table:

  - `parse_media(media_json, stats_json, project_name_by_id)` →
    `wistia_medias` row dict. Merges the inventory payload (`name`,
    `hashed_id`, `project`, `duration`, `type`, `created`, `updated`)
    with the lifetime-stats payload (`pageLoads`, `visitors`, `plays`,
    `percentOfVisitorsClickingPlay`, `averagePercentWatched`).

  - `parse_by_date_entry(hashed_id, entry)` → `wistia_media_daily`
    row dict. One entry from the by_date list (one calendar day).

Unit notes (LOAD-BEARING — see migration 0045 header):

  - `hours_watched` stays in HOURS as float. NOT seconds.
  - `duration_seconds` is in SECONDS as float. Wistia's `duration`
    field is already in seconds; we rename to `duration_seconds` in
    the mirror for clarity.
  - `averagePercentWatched` is an INTEGER percentage (e.g. 25 for 25%).
"""

from __future__ import annotations

from typing import Any


def parse_media(
    media_json: dict[str, Any],
    stats_json: dict[str, Any] | None,
    project_name_by_id: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Project /v1/medias.json + /v1/medias/{id}/stats.json into a
    wistia_medias row dict.

    `stats_json` is `None` when the per-media stats fetch failed (the
    caller wants the inventory row to land regardless — lifetime stats
    are a cross-check, not the source of truth).

    `project_name_by_id` is an optional map for richer project_name
    resolution (some media payloads carry `project.name` directly;
    others only carry `project.id` and we need a separate lookup).
    """
    if not media_json.get("hashed_id"):
        # No PK → no row. Caller skips.
        return {}

    project = media_json.get("project") or {}
    project_id = None
    project_name = None
    if isinstance(project, dict):
        project_id = project.get("id")
        if project_id is not None:
            project_id = str(project_id)
        project_name = project.get("name")
    if project_id and not project_name and project_name_by_id:
        project_name = project_name_by_id.get(project_id)

    row: dict[str, Any] = {
        "hashed_id": media_json.get("hashed_id"),
        "name": media_json.get("name"),
        "duration_seconds": media_json.get("duration"),
        "project_id": project_id,
        "project_name": project_name,
        "media_type": media_json.get("type"),
        "wistia_created_at": media_json.get("created"),
        "wistia_updated_at": media_json.get("updated"),
    }

    # Lifetime stats may be missing on a per-media failure — leave NULL.
    stats = (stats_json or {}).get("stats") if stats_json else None
    if isinstance(stats, dict):
        row["lifetime_page_loads"] = stats.get("pageLoads")
        row["lifetime_visitors"] = stats.get("visitors")
        row["lifetime_plays"] = stats.get("plays")
        row["lifetime_percent_of_visitors_clicking_play"] = stats.get(
            "percentOfVisitorsClickingPlay"
        )
        row["lifetime_avg_percent_watched"] = stats.get("averagePercentWatched")
    return row


def parse_by_date_entry(
    hashed_id: str,
    entry: dict[str, Any],
) -> dict[str, Any]:
    """Project one entry from /modern/stats/medias/{id}/by_date into a
    wistia_media_daily row dict.

    Entry shape (verified live during discovery):
        {"date": "2026-05-23", "load_count": 12, "play_count": 5,
         "hours_watched": 0.085}
    """
    if not entry.get("date"):
        return {}
    return {
        "hashed_id": hashed_id,
        "day": entry.get("date"),
        "load_count": entry.get("load_count", 0) or 0,
        "play_count": entry.get("play_count", 0) or 0,
        "hours_watched": entry.get("hours_watched", 0) or 0,
    }
