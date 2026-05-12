import Link from 'next/link'
import {
  PromPage,
  PromPageHeader,
  PromCard,
  AvatarCircle,
  money,
  pct,
  PromDropdownStub,
} from '@/components/promethean/primitives'
import { getCloserStats, PERIOD_LABEL, SYNC_LABEL } from '@/lib/mock-data'

export const metadata = { title: 'Closers — Promethean' }

export default function PrometheanClosersPage() {
  const stats = getCloserStats()
  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · CLOSERS"
        title="The closing leaderboard."
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
        {stats.map((c, i) => (
          <Link key={c.id} href={`/promethean/closers/${c.id}`}>
            <PromCard className="p-6 hover:bg-white/[0.015] transition-colors h-full">
              <div className="flex items-center gap-3">
                <AvatarCircle initials={c.avatar_initials} size={40} />
                <div>
                  <div className="prom-serif" style={{ fontSize: 22, lineHeight: '24px' }}>
                    {c.name}
                  </div>
                  <div className="prom-eyebrow mt-0.5">
                    #{i + 1} · {c.tier.toUpperCase()}
                  </div>
                </div>
              </div>

              <div
                className="grid grid-cols-2 gap-3 mt-6 pt-5"
                style={{ borderTop: '1px solid var(--color-prom-border)' }}
              >
                <Stat label="CASH" value={money(c.cash_collected, { compact: true })} accent />
                <Stat label="CLOSE RATE" value={pct(c.close_rate, 1)} />
                <Stat label="PITCHED" value={String(c.pitched)} />
                <Stat label="WON" value={String(c.won)} />
                <Stat label="CASH AOV" value={money(c.cash_aov, { compact: true })} />
                <Stat label="LOST" value={String(c.lost)} />
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
