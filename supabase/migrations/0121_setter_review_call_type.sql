-- 0121_setter_review_call_type.sql
-- Split the setter-call review rubric by call type.
--
-- Context (Drake 2026-06-30): setters make two kinds of call.
--   - OUTBOUND lead → the goal is to BOOK a strategy call with a closer.
--     Graded on booked / no_book_reason (the v1 rubric, unchanged).
--   - REVIVAL (reactivation) lead → these are Digital College leads the
--     rep tries to CLOSE on the phone, not book. "Did they book?" is the
--     wrong question; the right one is "did they close, and if not, why?"
--
-- The reviewer already detects revival calls (latest_opt_in_date before
-- the Gregory horizon, REVIVAL_HORIZON = 2026-05-24) — it just used the
-- flag for a Slack badge. This migration gives the close-on-phone rubric
-- a place to land: a call_type discriminator + a closed / no_close_reason
-- outcome pair that mirrors booked / no_book_reason.
--
-- booked goes nullable: a revival row carries closed instead of booked
-- (and vice-versa). The old "booked or no_book_reason" CHECK is replaced
-- with a per-call-type outcome check so exactly the right outcome column
-- is populated for each call_type.

alter table setter_call_reviews
  add column call_type text not null default 'outbound'
    check (call_type in ('outbound', 'revival')),
  add column closed boolean,
  add column no_close_reason text,
  alter column booked drop not null;

-- Replace the v1 outcome CHECK (booked = true or no_book_reason is not
-- null) with one keyed off call_type:
--   - outbound: booked is set; when false, no_book_reason explains why.
--   - revival:  closed is set; when false, no_close_reason explains why.
-- setter_call_reviews_check1 is the anonymous "booked or no_book_reason"
-- CHECK from 0054 (verified against the live DB — _check is the DQ one).
alter table setter_call_reviews
  drop constraint setter_call_reviews_check1;

alter table setter_call_reviews
  add constraint setter_call_reviews_outcome_check check (
    (call_type = 'outbound'
       and booked is not null
       and (booked = true or no_book_reason is not null))
    or
    (call_type = 'revival'
       and closed is not null
       and (closed = true or no_close_reason is not null))
  );

comment on column setter_call_reviews.call_type is
  'outbound = book-a-closer setting call (booked/no_book_reason rubric); revival = Digital College reactivation call where the rep closes on the phone (closed/no_close_reason rubric). Set from the reviewer''s is_revival check (lead opt-in before REVIVAL_HORIZON).';

comment on column setter_call_reviews.closed is
  'Revival calls only: true if the rep closed/enrolled the lead on the phone (DC). null for outbound calls (use booked instead).';

comment on column setter_call_reviews.no_close_reason is
  'Revival calls only: the blocker when closed=false (e.g. "couldn''t pay today", "looping in spouse"). null when closed=true or for outbound calls.';

comment on column setter_call_reviews.booked is
  'Outbound calls only: true if the call ended with a closer call booked. null for revival calls (use closed instead).';
