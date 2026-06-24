import type { AdsLpSummary } from '@/lib/db/funnel-summary'
import type { VideoMetrics } from '@/lib/db/funnel-lp'

// Marketing page — inline Ads + Landing-Page summary, shown as plain lists under
// the daily table. Replaces the two click-through detail pages (/funnel/ads and
// /funnel/landing-pages). Window-scoped to the funnel's current date range. No
// sparklines — just labelled rows.

const fmtUsd = (v: number | null): string =>
  v == null ? '—' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtCount = (v: number | null): string => (v == null ? '—' : Math.round(v).toLocaleString('en-US'))
const fmtPct = (v: number | null): string => (v == null ? '—' : `${v.toFixed(1)}%`)
const fmtDec = (v: number | null): string => (v == null ? '—' : v.toFixed(2))
const fmtFrac = (v: number | null): string => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)

function fmtDuration(sec: number | null): string {
  if (sec == null || sec <= 0) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec - m * 60)
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

// Total watch time can run to hours across a window — roll up above an hour.
function fmtWatch(sec: number): string {
  if (sec <= 0) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec - h * 3600) / 60)
  return `${h}h ${m.toString().padStart(2, '0')}m`
}

export function AdsLpSummarySection({ summary }: { summary: AdsLpSummary }) {
  const { ads, typeform, vsl, typVideo } = summary
  return (
    <div style={{ marginTop: 28 }}>
      <div
        className="geg-mono"
        style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 12 }}
      >
        Ads &amp; landing page
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        {/* Ads */}
        <Block title="Meta ads">
          <Row label="Adspend" value={fmtUsd(ads.adspend)} />
          <Row label="Impressions" value={fmtCount(ads.impressions)} />
          <Row label="Unique link clicks" value={fmtCount(ads.uniqueClicks)} />
          <Row label="CTR" value={fmtPct(ads.ctr)} />
          <Row label="CPM" value={fmtUsd(ads.cpm)} />
          <Row label="Cost / unique click" value={fmtUsd(ads.cpcUnique)} />
          <Row label="Frequency" value={fmtDec(ads.frequency)} />
        </Block>

        {/* Landing page + Typeform */}
        <Block title={`Landing page · ${summary.lpLabel}`}>
          <Row label="LP visits" value={fmtCount(summary.lpVisits)} hint="Meta unique link clicks" />
          <Row label="LP conversion" value={fmtPct(summary.lpConversionPct)} hint="submits ÷ visits" />
          <Divider label="Typeform" />
          <Row label="Starts" value={typeform.starts == null ? '—' : fmtCount(typeform.starts)} />
          <Row label="Completions" value={fmtCount(typeform.submits)} />
          <Row label="Completion rate" value={fmtPct(typeform.completionRate)} />
          <Row label="Qualified" value={fmtCount(typeform.qualified)} />
          <Row label="Non-qualified" value={fmtCount(typeform.nonQualified)} />
        </Block>

        {/* Videos */}
        <Block title="Videos">
          <Divider label="VSL on LP" name={vsl.label} />
          <VideoRows v={vsl} />
          <Divider label="Confirmation video" name={typVideo.label} />
          <VideoRows v={typVideo} />
        </Block>
      </div>
    </div>
  )
}

function VideoRows({ v }: { v: VideoMetrics }) {
  return (
    <>
      <Row label="Visits" value={fmtCount(v.visits)} />
      <Row label="Plays" value={fmtCount(v.totalPlays)} />
      <Row label="Play rate" value={v.playRate != null ? `${(v.playRate * 100).toFixed(1)}%` : '—'} />
      <Row label="Time played" value={fmtWatch(v.timePlayedSec)} />
      <Row label="Engagement" value={fmtFrac(v.engagementRate)} />
      <Row label="Avg view duration" value={fmtDuration(v.avgViewDurationSec)} />
    </>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        padding: '14px 16px',
      }}
    >
      <div
        className="geg-mono"
        style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', marginBottom: 8 }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>{children}</div>
    </div>
  )
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        padding: '6px 0',
        borderBottom: '1px dashed var(--color-geg-border)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span className="geg-serif" style={{ fontSize: 13.5, color: 'var(--color-geg-text-2)' }}>{label}</span>
        {hint ? (
          <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.04em', color: 'var(--color-geg-text-faint)' }}>{hint}</span>
        ) : null}
      </span>
      <span className="geg-numeric-serif" style={{ fontSize: 14, color: 'var(--color-geg-text)', letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
        {value}
      </span>
    </div>
  )
}

function Divider({ label, name }: { label: string; name?: string }) {
  // `name` is the actual video title (Wistia label); render it in natural case
  // beside the uppercased category so the row reads e.g. "VSL ON LP · V2 precall".
  const showName = name != null && name !== '' && name !== 'VSL'
  return (
    <div
      className="geg-mono"
      style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginTop: 10, marginBottom: 2 }}
    >
      {label}
      {showName ? (
        <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--color-geg-text-faint)' }}> · {name}</span>
      ) : null}
    </div>
  )
}
