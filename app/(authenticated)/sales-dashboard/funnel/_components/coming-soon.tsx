import { HeaderBand } from '@/components/gregory/header-band'
import { PersonPill } from '../../header-pills'

// Shared empty-state stub used by funnel detail pages that aren't
// built yet (Booked, Showed, Closed). Keeps the click target alive
// from the funnel hero without showing fake data.

export function ComingSoonFunnelStage({
  eyebrow,
  title,
  blurb,
}: {
  eyebrow: string
  title: string
  blurb: string
}) {
  return (
    <div>
      <HeaderBand
        eyebrow={eyebrow}
        title={title}
        backlink={{ href: '/sales-dashboard/funnel', label: 'BACK TO FUNNEL' }}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />
      <section
        style={{
          marginTop: 36,
          padding: '64px 24px',
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
            marginBottom: 14,
          }}
        >
          Coming soon
        </div>
        <div
          className="geg-serif"
          style={{
            fontSize: 18,
            color: 'var(--color-geg-text-2)',
            letterSpacing: '-0.005em',
            maxWidth: 540,
            margin: '0 auto',
            lineHeight: 1.5,
          }}
        >
          {blurb}
        </div>
      </section>
    </div>
  )
}
