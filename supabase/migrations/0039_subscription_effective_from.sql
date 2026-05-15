-- 0039_subscription_effective_from.sql
-- Cost hub: subscription month-attribution fix.
--
-- Bug (spec: cost-hub-effective-from-and-title-convention-v2): the
-- cost hub's history view summed EVERY non-archived monthly
-- subscription into EVERY historical month total. A sub added today
-- (Claude Max, ElevenLabs, etc. — all added during 2026-05-15 cost-hub
-- validation) wrongly inflated April / March / etc. historical totals,
-- because `getMonthTotal` had no notion of when a subscription started.
--
-- Fix: `effective_from date` marks when a subscription began
-- contributing. Combined with the existing `archived_at`, a sub is
-- "active in month M" when:
--   effective_from <= last_day_of_M
--   AND (archived_at IS NULL OR archived_at >= first_day_of_M)
-- The page-side filter (lib/db/cost-hub.ts:subscriptionActiveInMonth)
-- implements this; this migration just adds the column + backfills.
--
-- ============================================================================
-- Backfill choice: created_at::date
-- ============================================================================
--
-- Existing rows get `effective_from = created_at::date`. The 3 rows
-- present today (Claude Max, ElevenLabs, Anthropic extras) were all
-- added during 2026-05-15 validation, so they land at
-- effective_from='2026-05-15' — meaning they appear in May 2026
-- history and onward, NOT retroactively in April / March. This matches
-- Drake's mental model: "subs surface from when I added them."
--
-- Alternative considered + rejected: backfill NULL and treat NULL as
-- "always active." That would re-introduce the exact bug for the
-- existing rows. If Drake wants Claude Max to count from when he
-- actually started paying (an earlier month), he edits the row's
-- effective_from via the cost-hub UI after this lands.
--
-- ============================================================================
-- No index
-- ============================================================================
--
-- The page reads ~5-10 subscription rows total; a full table scan with
-- a JS-side active-in-month filter is well within budget. No index.

alter table monthly_subscriptions
  add column effective_from date not null default current_date;

-- Backfill existing rows to their creation date so they retain the
-- "added today" semantic rather than the column-default current_date
-- (which would coincidentally also be 2026-05-15 today, but
-- created_at::date is the correct durable rule for any future
-- pre-existing rows a re-run might encounter).
update monthly_subscriptions
   set effective_from = created_at::date;

comment on column monthly_subscriptions.effective_from is
  'Date the subscription began contributing to monthly cost totals. A sub is active in month M when effective_from <= last_day_of_M AND (archived_at IS NULL OR archived_at >= first_day_of_M). Backdate via the cost-hub UI to retroactively attribute a sub to earlier months.';
