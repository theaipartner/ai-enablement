import { HeaderBand } from '@/components/gregory/header-band'
import { MetricCard } from '@/components/sales/metric-card'
import type { MetricEntry } from '@/lib/db/sales-dashboard'

// Sales Dashboard v2 — Three-states reference.
//
// Self-serve explainer for what LIVE / PENDING / NOT CONNECTED mean,
// rendered as a 3-up grid of example cards + a mapping-rules block.
// Pulled from the mock at `docs/specs/sales-dashboard-v2.html`
// section `#view-states`. The three example MetricEntry objects are
// hand-built (not pulled from METRICS) so the page is illustrative
// rather than tied to whatever happens to be live in cloud today.
//
// Spec: docs/specs/sales-dashboard-v2.md § Routing.

export const dynamic = 'force-static'

const EXAMPLE_LIVE: MetricEntry = {
  id: 'example_live',
  section: 'ADVERTISING',
  title: 'Total Adspend',
  status: 'live',
  source: 'Meta',
  format: 'usd',
}
const EXAMPLE_PENDING: MetricEntry = {
  id: 'example_pending',
  section: 'FUNNELS',
  title: 'Cost per opt-in / CPL',
  status: 'pending',
  source: 'Meta × Typeform',
  note: 'Cross-source join — Meta spend ÷ Typeform submits not yet wired.',
}
const EXAMPLE_NC: MetricEntry = {
  id: 'example_nc',
  section: 'CONTENT',
  title: 'IG Follower Count',
  status: 'not_connected',
  source: 'IG Analytics',
}

export default function SalesDashboardStatesPage() {
  return (
    <div>
      <HeaderBand
        eyebrow="SALES · REFERENCE"
        title="Three states."
        backlink={{ href: '/sales-dashboard', label: 'BACK TO OVERVIEW' }}
      />

      <p
        className="geg-deck"
        style={{
          maxWidth: 640,
          fontSize: 17,
          margin: '0 0 36px',
        }}
      >
        Every metric card on the Engine resolves to exactly one of three states.
        Each maps onto an{' '}
        <span style={{ fontStyle: 'normal', color: 'var(--color-geg-text)' }}>
          EmptyStateAwareSection
        </span>{' '}
        mode at composition time — never toggled defensively at runtime.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 24,
          marginTop: 8,
        }}
      >
        <StateExample
          label="LIVE"
          dotColor="var(--color-geg-pos)"
          example={EXAMPLE_LIVE}
          exampleResult={{ state: 'live', value: 8940.32 }}
          desc="Single-source query against one mirror table resolved to a real number. Full serif numeric, source line, optional sparkline or delta."
          mode="show"
        />
        <StateExample
          label="PENDING"
          dotColor="var(--color-geg-warn)"
          example={EXAMPLE_PENDING}
          exampleResult={{ state: 'pending' }}
          desc={
            <>
              Source(s) are ingested but the metric needs a cross-source join, a derived ratio, or a flagged schema ambiguity to land.{' '}
              <em style={{ color: 'var(--color-geg-text)', fontStyle: 'italic' }}>
                The slot is meaningful — leave it visible so we know what&apos;s incoming.
              </em>
            </>
          }
          mode="stub"
        />
        <StateExample
          label="NOT CONNECTED"
          dotColor="var(--color-geg-text-faint)"
          example={EXAMPLE_NC}
          exampleResult={{ state: 'not_connected' }}
          desc="Upstream source has no ingestion path today. Muted/dashed chrome so the eye glides past — present in the catalog only so coverage gaps are auditable, not so the CSM reads them."
          mode="stub-or-hide"
        />
      </div>

      <div
        style={{
          marginTop: 56,
          padding: '26px 28px',
          background: 'var(--color-geg-bg-elev)',
          border: '1px solid var(--color-geg-border)',
          borderRadius: 10,
        }}
      >
        <h3
          className="geg-serif"
          style={{
            margin: '0 0 12px',
            fontSize: 20,
            letterSpacing: '-0.01em',
          }}
        >
          Mapping rules
        </h3>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          <Rule label="Status source">
            Catalog declaration in <Code>lib/db/sales-dashboard.ts</Code> METRICS —
            one of <Code>{`'live'`}</Code> / <Code>{`'pending'`}</Code> /{' '}
            <Code>{`'not_connected'`}</Code>. Resolved at SSR time, never
            client-toggled.
          </Rule>
          <Rule label="Visual weight">
            Live = solid elev surface, full serif numeric. Pending = warn-tinted
            card, no number. Not-connected = dashed transparent surface, no
            number. Weight drops monotonically so the eye lands on live values
            first.
          </Rule>
          <Rule label="Hero treatment">
            Hero cards on the Overview are{' '}
            <em style={{ color: 'var(--color-geg-text)', fontStyle: 'italic' }}>
              always live
            </em>{' '}
            — if any of Nabeel&apos;s seven daily numbers ever flips off live,
            the hero card shows the live-error state (red glyph + error tooltip),
            never pending/not-connected.
          </Rule>
          <Rule label="Section page">
            All three states sit side-by-side in catalog order — no grouping. The
            visual hierarchy alone tells the reader which is which.
          </Rule>
          <Rule label="Error">
            A fourth runtime state: <Code>live_error</Code>. A live fetcher threw
            — render red border-left + <Code>ERROR</Code> badge with the message
            in a tooltip.
          </Rule>
        </ul>
      </div>
    </div>
  )
}

function StateExample({
  label,
  dotColor,
  example,
  exampleResult,
  desc,
  mode,
}: {
  label: string
  dotColor: string
  example: MetricEntry
  exampleResult: import('@/lib/db/sales-dashboard').FetchResult
  desc: React.ReactNode
  mode: 'show' | 'stub' | 'stub-or-hide'
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-2)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: dotColor,
          }}
        />
        {label}
      </div>
      <MetricCard
        metric={example}
        result={exampleResult}
        size="grid"
        sectionTagOverride={null}
      />
      <div
        className="geg-serif"
        style={{
          color: 'var(--color-geg-text-2)',
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        {desc}
      </div>
      <div
        className="geg-mono"
        style={{
          marginTop: 4,
          padding: '12px 14px',
          background: 'var(--color-geg-bg-elev)',
          borderLeft: '2px solid var(--color-geg-accent)',
          borderRadius: '0 6px 6px 0',
          fontSize: 10.5,
          lineHeight: '16px',
          letterSpacing: '0.06em',
          color: 'var(--color-geg-text-3)',
        }}
      >
        <strong style={{ color: 'var(--color-geg-text)', fontWeight: 500 }}>
          EmptyStateAwareSection
        </strong>
        <br />
        {mode === 'show' ? (
          <>mode = <Code>{`'show'`}</Code></>
        ) : mode === 'stub' ? (
          <>mode = <Code>{`'stub'`}</Code></>
        ) : (
          <>
            mode = <Code>{`'stub'`}</Code> · dashed border
            <br />
            (or <Code>{`'hide'`}</Code> if the whole row is dead)
          </>
        )}
      </div>
    </div>
  )
}

function Rule({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li
      style={{
        padding: '12px 0',
        borderTop: '1px dashed rgba(160, 136, 80, 0.18)',
        display: 'grid',
        gridTemplateColumns: '140px 1fr',
        gap: 18,
        alignItems: 'baseline',
      }}
    >
      <span
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-faint)',
        }}
      >
        {label}
      </span>
      <span style={{ color: 'var(--color-geg-text-2)' }}>{children}</span>
    </li>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      className="geg-mono"
      style={{
        fontSize: 11.5,
        color: 'var(--color-geg-pos)',
        background: 'rgba(0,0,0,0.3)',
        padding: '1px 5px',
        borderRadius: 3,
      }}
    >
      {children}
    </code>
  )
}
