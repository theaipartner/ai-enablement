# Call Titling Convention

For Calendly events, Google Calendar entries, and any other call-scheduling surface that feeds into Fathom recordings.

The classifier reads call titles to categorize calls. Consistent titling means the dashboard categorizes correctly and the CSM team can scan calendars at a glance.

## Three call types

### `[Client] <CSM First> x <Client First> <Client Last Initial>`
For scheduled calls between a CSM and an existing paying client.
Example: `[Client] Lou x Tina H`

### `[Discovery] <CSM First> x <Prospect First> <Prospect Last Initial>`
For pre-signature sales calls with a prospect.
Example: `[Discovery] Aman x John D`

### `[Client x Prospect] <Our Client First> x <CSM First>`
For when a CSM joins our client's call with their own prospect or lead.
Example: `[Client x Prospect] Tina x Lou`

## Internal calls — no prefix

Internal CSM syncs, team meetings, and any call that's not client-facing should NOT have a prefix. The absence of a prefix is the signal — the classifier routes prefix-less calls to `internal` or `unclassified`, and the dashboard filters them out of the Calls view by default.

## Edge cases

- **Multiple CSMs on a call:** use `+` for our-side, `x` for our-vs-client. Example: `[Client] Lou + Scott x Tina H`.
- **Discovery call with prospect name unknown:** use square-bracket placeholder: `[Discovery] Aman x [Prospect]`. Update post-call.
- **Subtypes (renewal, problem-resolution, wrap-up):** for V1, all CSM-with-client calls are `[Client]`. Subtypes will be added later if Scott/Nabeel identify patterns worth distinguishing.

## What this enables

- **Immediate:** human-readable, scannable calendar views for the CSM team.
- **Near-term:** the classifier today doesn't read prefixes — it categorizes based on participant emails and call content. Convention compliance gets you cleaner data going forward; the classifier improvement (prefix-aware rule) is a future targeted update.
- **Long-term:** filter the dashboard by call type, run analytics on Discovery → Client conversion rates, build CSM performance views.

## Rollout

Convention launched at the 2026-05-01 CSM sync. Existing scheduled calls don't need retroactive renaming — the classifier handles legacy titles via its existing logic. New scheduled calls follow the convention.
