import { SectionBlock } from '../section-block'
import { METRICS, type SectionId } from '@/lib/db/sales-dashboard-shared'

// CONTENT — every metric is currently NOT_CONNECTED. Honest stub
// explaining what would land here once IG / YouTube wire up. Don't
// fake organic content data because the real numbers will look nothing
// like guesswork.

export function ContentSection() {
  const contentMetrics = METRICS.filter((m) => m.section === ('CONTENT' as SectionId))
  const igCount = contentMetrics.filter((m) => m.title.startsWith('IG')).length
  const ytCount = contentMetrics.filter((m) => m.title.startsWith('YT')).length

  return (
    <>
      <SectionBlock
        eyebrow="NOT CONNECTED"
        title="Content metrics are awaiting upstream integration."
      >
        <div
          className="geg-serif"
          style={{
            fontSize: 14.5,
            color: 'var(--color-geg-text-2)',
            letterSpacing: '-0.002em',
            lineHeight: 1.55,
            maxWidth: 640,
          }}
        >
          The Engine sheet declares <strong>{contentMetrics.length}</strong> organic-content metrics —
          {' '}<strong>{igCount}</strong> Instagram, <strong>{ytCount}</strong> YouTube, plus a handful
          of cross-platform aggregates. None ship with mock values because organic-reach numbers
          differ by orders of magnitude across accounts and faking them misleads more than it helps.
        </div>
        <div
          className="geg-serif"
          style={{
            marginTop: 14,
            fontSize: 13,
            fontStyle: 'italic',
            color: 'var(--color-geg-text-3)',
          }}
        >
          When IG Analytics + YT Analytics adapters land in <code>ingestion/</code>, these populate
          automatically through the catalog. Until then, this section is a placeholder.
        </div>
      </SectionBlock>

      <SectionBlock
        eyebrow="WHAT WILL LAND HERE"
        title="Metrics queued for connection."
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <SourceColumn
            label="Instagram"
            items={contentMetrics
              .filter((m) => m.title.startsWith('IG'))
              .map((m) => m.title.replace(/^IG /, ''))}
          />
          <SourceColumn
            label="YouTube"
            items={contentMetrics
              .filter((m) => m.title.startsWith('YT'))
              .map((m) => m.title.replace(/^YT /, ''))}
          />
        </div>
      </SectionBlock>
    </>
  )
}

function SourceColumn({ label, items }: { label: string; items: string[] }) {
  return (
    <div
      style={{
        background: 'var(--color-geg-bg)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 8,
        padding: '16px 18px 14px',
      }}
    >
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {items.map((it, i) => (
          <li
            key={i}
            className="geg-serif"
            style={{
              fontSize: 13.5,
              color: 'var(--color-geg-text-2)',
              padding: '5px 0',
              borderBottom: i < items.length - 1 ? '1px dashed var(--color-geg-border)' : 'none',
            }}
          >
            {it}
          </li>
        ))}
      </ul>
    </div>
  )
}
