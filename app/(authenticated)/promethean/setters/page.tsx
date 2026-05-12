import Link from 'next/link'
import {
  PromPage,
  PromPageHeader,
  PromCard,
  AvatarCircle,
  pct,
  PromDropdownStub,
} from '@/components/promethean/primitives'
import { getSetterStats, PERIOD_LABEL, SYNC_LABEL } from '@/lib/mock-data'

export const metadata = { title: 'Setters — Promethean' }

export default function PrometheanSettersPage() {
  const stats = getSetterStats()
  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · SETTERS"
        title="Dial volume, booking rate."
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
        trailing={<PromDropdownStub label="Last 30 days" />}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mt-8">
        {stats.map((s, i) => (
          <Link key={s.id} href={`/promethean/setters/${s.id}`}>
            <PromCard className="p-6 hover:bg-white/[0.015] transition-colors h-full">
              <div className="flex items-center gap-3">
                <AvatarCircle initials={s.avatar_initials} size={40} />
                <div>
                  <div className="prom-serif" style={{ fontSize: 22, lineHeight: '24px' }}>
                    {s.name}
                  </div>
                  <div className="prom-eyebrow mt-0.5">#{i + 1}</div>
                </div>
              </div>

              <div
                className="grid grid-cols-2 gap-3 mt-6 pt-5"
                style={{ borderTop: '1px solid var(--color-prom-border)' }}
              >
                <Stat label="DIALS" value={String(s.dials)} />
                <Stat label="CONVOS" value={String(s.conversations)} />
                <Stat label="BOOKINGS" value={String(s.bookings)} accent />
                <Stat label="SHOW RATE" value={pct(s.show_rate, 0)} />
                <Stat label="TALK TIME" value={`${s.talk_minutes}m`} />
                <Stat label="SPEED · LEAD" value={`${s.avg_speed_to_lead_minutes}m`} />
              </div>
            </PromCard>
          </Link>
        ))}
      </div>
    </PromPage>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="prom-eyebrow">{label}</div>
      <div
        className="prom-numeric mt-1 font-medium"
        style={{
          fontSize: 18,
          color: accent ? 'var(--color-prom-accent)' : 'var(--color-prom-text)',
        }}
      >
        {value}
      </div>
    </div>
  )
}
