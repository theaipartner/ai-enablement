import { HeaderBand } from '@/components/gregory/header-band'

// Content Dashboard — placeholder.

export default function ContentDashboardPage() {
  return (
    <div style={{ padding: '32px 48px 64px', maxWidth: 1480, width: '100%' }}>
      <HeaderBand eyebrow="CONTENT" title="Dashboard." />
      <div
        style={{
          marginTop: 28,
          padding: '40px 32px',
          background: 'var(--color-geg-bg-elev)',
          border: '1px dashed var(--color-geg-border)',
          borderRadius: 10,
          textAlign: 'center',
        }}
      >
        <div
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-faint)',
          }}
        >
          Coming soon
        </div>
        <div
          className="geg-serif"
          style={{
            marginTop: 10,
            fontSize: 16,
            color: 'var(--color-geg-text-3)',
            fontStyle: 'italic',
          }}
        >
          Content metrics surface — to be defined.
        </div>
      </div>
    </div>
  )
}
