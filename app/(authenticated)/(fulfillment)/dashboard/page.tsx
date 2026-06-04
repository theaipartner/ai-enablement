import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import {
  getActiveClientsAggregate,
  getDashboardNotifications,
  getNeedsReviewClients,
  getNeedsReviewMergeCandidates,
  type ActiveClientsAggregate,
  type CsmCount,
  type JourneyStageCount,
  type Notification,
} from '@/lib/db/fulfillment-dashboard'
import { NeedsReviewBox } from './needs-review-box'

// Fulfillment Dashboard.
//
// Three top stat boxes: total active clients, by CSM, by journey
// stage. Notifications table below: negative-sentiment calls from
// today + missed Fathom recordings (calendar events where end_time +
// 30min has passed with no matched call). Mirrors the visual language
// of the sales-dashboard Funnel page — eyebrow + serif title boxes,
// elevated cards with subtle borders.

export const dynamic = 'force-dynamic'

const EST_LOCALE = 'America/New_York'

export default async function FulfillmentDashboardPage() {
  const [aggregate, notifications, needsReview, mergeCandidates] =
    await Promise.all([
      getActiveClientsAggregate(),
      getDashboardNotifications(),
      getNeedsReviewClients(),
      getNeedsReviewMergeCandidates(),
    ])

  return (
    <div style={{ padding: '32px 48px 64px', maxWidth: 1480, width: '100%' }}>
      <HeaderBand eyebrow="FULFILLMENT" title="Dashboard." />

      <NeedsReviewBox clients={needsReview} candidates={mergeCandidates} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 18,
          marginTop: 28,
        }}
      >
        <TotalBox total={aggregate.total} />
        <ByCsmBox aggregate={aggregate} />
        <ByJourneyBox aggregate={aggregate} />
      </div>

      <NotificationsTable notifications={notifications} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stat boxes
// ---------------------------------------------------------------------------

const BOX_STYLE: React.CSSProperties = {
  padding: '22px 26px 24px',
  background: 'var(--color-geg-bg-elev)',
  border: '1px solid var(--color-geg-border)',
  borderRadius: 10,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 220,
}

function BoxHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
        }}
      >
        {eyebrow}
      </div>
      <div
        className="geg-serif"
        style={{
          marginTop: 6,
          fontSize: 22,
          color: 'var(--color-geg-text)',
          letterSpacing: '-0.012em',
        }}
      >
        {title}
      </div>
    </div>
  )
}

function TotalBox({ total }: { total: number }) {
  return (
    <div style={BOX_STYLE}>
      <BoxHeader eyebrow="ACTIVE CLIENTS" title="Total." />
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'flex-start',
        }}
      >
        <div
          className="geg-numeric-serif"
          style={{
            fontSize: 72,
            lineHeight: 1,
            letterSpacing: '-0.03em',
            color: 'var(--color-geg-text)',
          }}
        >
          {total}
        </div>
        <div
          className="geg-mono"
          style={{
            marginTop: 10,
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-faint)',
          }}
        >
          clients · status active
        </div>
      </div>
    </div>
  )
}

function ByCsmBox({ aggregate }: { aggregate: ActiveClientsAggregate }) {
  const max = aggregate.by_csm.reduce((m, r) => Math.max(m, r.count), 0)
  return (
    <div style={BOX_STYLE}>
      <BoxHeader eyebrow="BY CSM" title="Per owner." />
      <BreakdownList rows={aggregate.by_csm.map(rowFromCsm)} max={max} />
    </div>
  )
}

function rowFromCsm(c: CsmCount): BreakdownRow {
  return {
    key: c.team_member_id ?? '__unassigned__',
    label: c.team_member_name ?? 'Unassigned',
    count: c.count,
    muted: c.team_member_id === null,
  }
}

function ByJourneyBox({ aggregate }: { aggregate: ActiveClientsAggregate }) {
  const max = aggregate.by_journey_stage.reduce((m, r) => Math.max(m, r.count), 0)
  return (
    <div style={BOX_STYLE}>
      <BoxHeader eyebrow="BY JOURNEY STAGE" title="Per stage." />
      <BreakdownList rows={aggregate.by_journey_stage.map(rowFromStage)} max={max} />
    </div>
  )
}

function rowFromStage(s: JourneyStageCount): BreakdownRow {
  return {
    key: s.value ?? '__null__',
    label: s.label,
    count: s.count,
    muted: s.value === null,
  }
}

type BreakdownRow = {
  key: string
  label: string
  count: number
  muted: boolean
}

function BreakdownList({ rows, max }: { rows: BreakdownRow[]; max: number }) {
  if (rows.length === 0) {
    return (
      <div
        className="geg-mono"
        style={{ fontSize: 11, color: 'var(--color-geg-text-faint)' }}
      >
        No data.
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {rows.map((r) => {
        const pct = max === 0 ? 0 : (r.count / max) * 100
        return (
          <div
            key={r.key}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div style={{ position: 'relative', height: 28 }}>
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: r.muted
                    ? 'var(--color-geg-border)'
                    : 'var(--color-geg-accent-fill)',
                  width: `${pct}%`,
                  borderRadius: 4,
                  transition: 'width 240ms ease',
                }}
              />
              <div
                style={{
                  position: 'relative',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  paddingLeft: 10,
                  fontSize: 13,
                  color: r.muted
                    ? 'var(--color-geg-text-3)'
                    : 'var(--color-geg-text)',
                  letterSpacing: '-0.005em',
                }}
              >
                {r.label}
              </div>
            </div>
            <div
              className="geg-numeric-serif"
              style={{
                fontSize: 16,
                color: r.muted
                  ? 'var(--color-geg-text-3)'
                  : 'var(--color-geg-text)',
                minWidth: 28,
                textAlign: 'right',
              }}
            >
              {r.count}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Notifications table
// ---------------------------------------------------------------------------

function NotificationsTable({ notifications }: { notifications: Notification[] }) {
  return (
    <section style={{ marginTop: 36 }}>
      <div
        style={{
          padding: '22px 26px 6px',
          background: 'var(--color-geg-bg-elev)',
          border: '1px solid var(--color-geg-border)',
          borderRadius: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <BoxHeader eyebrow="NOTIFICATIONS" title="Flags worth a look." />
          <div
            className="geg-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-faint)',
            }}
          >
            {notifications.length} {notifications.length === 1 ? 'flag' : 'flags'}
          </div>
        </div>

        {notifications.length === 0 ? (
          <div
            style={{
              padding: '24px 0 28px',
              fontSize: 13,
              color: 'var(--color-geg-text-3)',
              fontStyle: 'italic',
            }}
          >
            Nothing flagged. All recordings landed and all reviewed calls came back green or yellow.
          </div>
        ) : (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              marginTop: 4,
            }}
          >
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Type</Th>
                <Th>Detail</Th>
                <Th>Context</Th>
              </tr>
            </thead>
            <tbody>
              {notifications.map((n) => (
                <NotificationRow key={notificationKey(n)} n={n} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

function notificationKey(n: Notification): string {
  return n.kind === 'negative_sentiment'
    ? `sent:${n.call_id}`
    : `miss:${n.google_event_id}`
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      className="geg-mono"
      style={{
        textAlign: 'left',
        padding: '12px 0 10px',
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-faint)',
        borderBottom: '1px solid var(--color-geg-border)',
        fontWeight: 500,
      }}
    >
      {children}
    </th>
  )
}

function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td
      className={mono ? 'geg-mono' : undefined}
      style={{
        padding: '13px 14px 13px 0',
        fontSize: mono ? 11 : 13,
        color: 'var(--color-geg-text)',
        borderBottom: '1px solid var(--color-geg-border)',
        verticalAlign: 'top',
        letterSpacing: mono ? '0.06em' : '-0.005em',
      }}
    >
      {children}
    </td>
  )
}

function formatNotificationDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: EST_LOCALE,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso))
}

function NotificationRow({ n }: { n: Notification }) {
  if (n.kind === 'negative_sentiment') {
    return (
      <tr>
        <Td mono>{formatNotificationDate(n.occurred_at)}</Td>
        <Td>
          <TypePill kind="negative" label="Negative sentiment" />
        </Td>
        <Td>
          <Link
            href={`/calls/${n.call_id}`}
            style={{ color: 'var(--color-geg-text)', textDecoration: 'underline' }}
          >
            {n.call_title ?? 'Untitled call'}
          </Link>
        </Td>
        <Td>
          {n.client_id && n.client_name ? (
            <Link
              href={`/clients/${n.client_id}`}
              style={{ color: 'var(--color-geg-text-2)', textDecoration: 'underline' }}
            >
              {n.client_name}
            </Link>
          ) : (
            <span style={{ color: 'var(--color-geg-text-faint)' }}>—</span>
          )}
        </Td>
      </tr>
    )
  }
  return (
    <tr>
      <Td mono>{formatNotificationDate(n.occurred_at)}</Td>
      <Td>
        <TypePill kind="warn" label="Missing recording" />
      </Td>
      <Td>{n.event_title ?? 'Untitled event'}</Td>
      <Td>
        <span style={{ color: 'var(--color-geg-text-2)' }}>
          {n.csm_name ?? 'Unassigned'}
        </span>
      </Td>
    </tr>
  )
}

function TypePill({
  kind,
  label,
}: {
  kind: 'negative' | 'warn'
  label: string
}) {
  const bg =
    kind === 'negative'
      ? 'var(--color-geg-neg-fill)'
      : 'var(--color-geg-warn-fill)'
  const border =
    kind === 'negative'
      ? 'var(--color-geg-neg-border)'
      : 'var(--color-geg-warn-border)'
  const color =
    kind === 'negative' ? 'var(--color-geg-neg)' : 'var(--color-geg-warn)'
  return (
    <span
      className="geg-mono"
      style={{
        display: 'inline-block',
        padding: '3px 8px',
        background: bg,
        border: `1px solid ${border}`,
        color,
        borderRadius: 4,
        fontSize: 10,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}
