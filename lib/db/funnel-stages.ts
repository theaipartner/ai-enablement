import {
  dateRangeFromExplicit,
  todayEtDate,
  type DateRange,
} from './funnel-window'

// Funnel page — date-range resolution.
//
// The old Pulse activity-box builder (getFunnelActivity + the FunnelBox /
// PulseTile / FunnelActivity types + the FMR/cohort-adspend helpers) was
// removed when the Funnel page moved to the stacked Total / Direct / Setter /
// Reactivation funnel (see components/sales/funnel-stack.tsx). This module now
// only resolves the window for the funnel + its stage-detail pages.

// Default range = TODAY ET (Drake 2026-05-29). Since the Cortana cutover, ads
// populate today intraday, so the funnel opens on the current day; every
// source's today-so-far is shown and restates as the day fills in.
export function resolveFunnelRange(
  startEtDate: string | undefined,
  endEtDate: string | undefined,
): DateRange {
  const today = todayEtDate()
  const s = startEtDate ?? today
  const e = endEtDate ?? today
  return dateRangeFromExplicit(s, e)
}
