"""Parse Typeform API JSON payloads → internal records for upsert.

Two payload shapes flow through:

1. **Form definition** (from `GET /forms/{form_id}`) → `typeform_forms` row.
2. **Response** (from `GET /forms/{form_id}/responses` items[] OR the
   `form_response` envelope of the `form_response` webhook) →
   `typeform_responses` row. The two API shapes carry the SAME response
   object (verified in discovery + spec § Typeform webhooks), so one
   parser serves both.

Field-ref stability (verified in discovery §4(c)): the field `ref` is
author-assigned and uniquely identifies a question within a form. The
same ref appears across funnel-variant forms (PWSNd0h2 / poifwp1H /
SFedWelr all carry the same ref for the same "income" question). This
is the stable key for downstream answer mapping — store the raw answers
jsonb and key on field.ref at query time.

Group flattening: a `group` field in the form definition wraps inner
fields (e.g. `contact_info`). Typeform flattens these in the responses —
each inner field appears as its own answer keyed on the inner field's
ref. The parser does the same flattening on the form-definition side
so `typeform_forms.fields` carries the same shape callers can iterate
against.
"""

from __future__ import annotations

from typing import Any


def _flatten_fields(raw_fields: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Unwrap `group` fields so each entry is a leaf field.

    Group fields wrap inner fields under `.properties.fields[]`. The
    response answers reference the INNER field's ref, not the group's,
    so the form-definition mirror also stores leaf fields directly.
    The group's ref is preserved on each unwrapped child as `_in_group`
    so callers can reconstruct the original grouping if needed.
    """
    if not raw_fields:
        return []
    flat: list[dict[str, Any]] = []
    for fld in raw_fields:
        if not isinstance(fld, dict):
            continue
        if fld.get("type") == "group":
            inner = (fld.get("properties") or {}).get("fields", []) or []
            group_ref = fld.get("ref") or fld.get("id")
            for sub in inner:
                if not isinstance(sub, dict):
                    continue
                child = dict(sub)
                child["_in_group"] = group_ref
                flat.append(child)
        else:
            flat.append(fld)
    return flat


def parse_form_definition(raw: dict[str, Any]) -> dict[str, Any]:
    """Project a `GET /forms/{form_id}` response into a `typeform_forms` row.

    Idempotent — re-running on the same input yields the same row.
    """
    form_id = raw.get("id") or ""
    return {
        "form_id": form_id,
        "title": raw.get("title"),
        "last_updated_at": raw.get("last_updated_at"),
        "fields": _flatten_fields(raw.get("fields")),
        # `hidden` on the form definition is a flat string array of
        # hidden-field names the form supports.
        "hidden_fields": raw.get("hidden") or [],
        # `definition_synced_at` is set in the pipeline at write time;
        # leaving it absent here keeps the parser pure.
    }


def parse_response(
    raw: dict[str, Any],
    *,
    form_id: str | None = None,
) -> dict[str, Any]:
    """Project a Typeform response item OR webhook `form_response` payload
    into a `typeform_responses` row.

    The two shapes are equivalent — both carry `token` / `response_id`,
    `landed_at` / `submitted_at`, `metadata`, `hidden`, `calculated`,
    `answers`. Caller supplies `form_id` when the payload itself doesn't
    (the Responses API items don't carry it; the webhook `form_response`
    object DOES carry `form_id`).
    """
    # `response_id` and `token` carry the same value; prefer response_id
    # but fall back to token (and vice versa) so both API surfaces work.
    response_id = raw.get("response_id") or raw.get("token")
    resolved_form_id = (
        form_id
        or raw.get("form_id")  # webhook envelope
        or (raw.get("definition") or {}).get("id")  # webhook nested
        or ""
    )
    return {
        "response_id": response_id or "",
        "form_id": resolved_form_id,
        "landed_at": raw.get("landed_at"),
        "submitted_at": raw.get("submitted_at"),
        "metadata": raw.get("metadata") or {},
        "hidden": raw.get("hidden") or {},
        "calculated": raw.get("calculated") or None,
        "answers": raw.get("answers") or [],
    }
