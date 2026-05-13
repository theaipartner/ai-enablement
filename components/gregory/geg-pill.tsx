// Gregory editorial pill primitive. Five tiers, mono caps label, 6px dot.
//
//   pos    — green family (Active / Happy / Promoter / Green health)
//   warn   — yellow family (Paused / Ghost / At risk / Neutral / Yellow health)
//   neg    — red family (Churned / Problem / At Risk / Red health)
//   muted  — neutral (Leave / unknown / placeholder)
//   gold   — accent (Health <N> chip on the detail header, etc.)
//
// All visual chrome lives in app/globals.css under `.geg-pill` so the
// pill renders server-side without runtime styles. The component
// renders dumb HTML — vocab→tier mapping lives in the call site (pills
// at app/(authenticated)/clients/pills.tsx wrap this with the right
// tier per status/standing value).

export type GegPillTier = 'pos' | 'warn' | 'neg' | 'muted' | 'gold'

export type GegPillProps = {
  tier: GegPillTier
  label: string
  // Optional className passthrough for surfaces that want extra spacing.
  className?: string
}

export function GegPill({ tier, label, className }: GegPillProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={
        'geg-pill geg-pill--' + tier + (className ? ' ' + className : '')
      }
    >
      <span className="geg-pill-dot" aria-hidden="true" />
      {label}
    </span>
  )
}
