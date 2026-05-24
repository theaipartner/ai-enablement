"""Microsoft Clarity ingestion — daily self-healing cron, no backfill possible.

Canonical config constants live HERE (top of the module, intentionally
visible) — like Calendly's `CLOSER_EVENT_TYPE_NAMES`. The aggregation
layer reads these to compute the three named Engine-sheet metrics:

  * Landing Page Visits           (row 25; Traffic.totalSessionCount for LANDING_PAGE_PATH)
  * Average Time on Landing Page  (row 26; EngagementTime.<DEFAULT_TIME_METRIC> for LANDING_PAGE_PATH)
  * Average Time on Thank-You Page (row 37; EngagementTime.<DEFAULT_TIME_METRIC> for THANK_YOU_PAGE_PATH)

Ingestion is mirror-everything — all paths, all 9 metric blocks, both
time fields. These constants ONLY label which paths the named metrics
target; changing them never requires re-ingesting.

Drake's confirmed paths from discovery (`docs/reports/clarity-discovery.md`):
  * /lp           — landing page (15 sessions / 18 users / 3 days)
  * /confirmation — thank-you page after the booking funnel

To change later: edit the three constants below + the aggregation
queries that reference them. No ingestion / schema change needed.
"""

# Path that counts as THE landing page. Aggregation reads
# total_session_count + active_time for url_path = this value.
LANDING_PAGE_PATH: str = "/lp"

# Path that counts as THE thank-you page. Aggregation reads
# active_time for url_path = this value. Resolves the Engine sheet's
# original row-37 "Wistia" mis-tag — confirmed Clarity metric.
THANK_YOU_PAGE_PATH: str = "/confirmation"

# Which EngagementTime field is the canonical "time on page".
# Must be one of {'active_time', 'total_time'}.
#   * active_time — time the user was actively interacting (clicks,
#     scrolls). Better engagement signal; default.
#   * total_time  — includes idle tab time. Use if "did the visitor
#     sit on the page for N seconds" matters more than interaction.
# Both columns are stored — flipping this default is a one-line
# aggregation-layer change, no re-ingest.
DEFAULT_TIME_METRIC: str = "active_time"

# Sentinel value used for the null-URL aggregate row in Traffic.
# Both `url` and `url_path` get this literal when Clarity returned
# Url: null (the all-URLs total). Queries filtering specific paths
# use `url_path != TOTAL_SENTINEL`.
TOTAL_SENTINEL: str = "__total__"
