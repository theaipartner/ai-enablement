import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getClientById, listAvailableCsms, type ClientDetail } from '@/lib/db/clients'
import { listMergeCandidates } from '@/lib/db/merge'
import { GegPill } from '@/components/gregory/geg-pill'
import {
  CsmStandingPill,
  MissingSlackChannelPill,
  MissingSlackUserPill,
  NpsStandingPill,
  StatusPill,
} from '../pills'
import {
  EditableAccountabilityEnabledToggle,
  EditableCsmStandingCell,
  EditableJourneyStageCell,
  EditableNpsEnabledToggle,
  EditablePrimaryCsmCell,
  EditableStatusCell,
  EditableTrustpilotCell,
} from '../editable-cell'
import { ActionItemsList, type ActionItemRow } from './action-items-list'
import { BackToClientsButton } from './back-to-clients-button'
import { MergeClientButton } from './merge-client-button'
import { RemoveNeedsReviewButton } from './remove-needs-review-button'

// Clients redesign · § 2 — /clients/[id] detail page.
//
// Two-column grid (440 : 1fr). Left column: Details + Standing.
// Right column: Health + Action items + Recent calls. Each box is a
// translucent gold-bordered surface. Pills in the header summarize
// status + standing + health at-a-glance.
//
// Section coverage swap vs the prior v3 detail page:
//   Kept (re-styled): status / journey / csm_standing / nps / trustpilot
//   editability; recent calls + total / month stats; latest_health
//   score + concerns; action items (now with checkbox + Slack send).
//
// Dropped from this page (vs the v3 7-section layout):
//   Financials section (revenue / cash / arrears) — no mock surface.
//   Profile section (occupation / niche / offer / SWOT) — no mock
//   surface. Notes section — no mock surface. Adoption section
//   (GHL adoption / DFY setting) — no mock surface. Identity fields
//   like time-zone / slack ids / birth year — no mock surface.
//
// These remain in the DB / API and can be re-surfaced as additional
// gold-boxes if Drake wants. The mock represents the new "focused
// CSM scan" view; deep-edits route through TBD.

// Note about Health concerns shape: agents/gregory/ai_call_signal.py
// emits `Concern { text, severity, source_call_ids[] }`. The mock
// shows a single source-call title per row; we resolve the first
// source_call_id against client.all_calls. If a concern has no
// matching call (defensive — old data could carry stale ids), we
// drop the source line.

type ConcernShape = {
  text?: unknown
  severity?: unknown
  source_call_ids?: unknown
}

function readConcerns(client: ClientDetail): Array<{
  text: string
  severity: 'high' | 'medium' | 'low'
  source_call_id: string | null
  source_call_title: string | null
  source_call_started_at: string | null
}> {
  const factors = client.latest_health?.factors
  if (
    factors === null ||
    factors === undefined ||
    typeof factors !== 'object'
  ) {
    return []
  }
  const rawConcerns = (factors as { concerns?: unknown }).concerns
  if (!Array.isArray(rawConcerns)) return []
  const callTitleById = new Map(
    client.all_calls.map((c) => [c.id, { title: c.title, started_at: c.started_at }]),
  )
  return rawConcerns
    .map((raw): ConcernShape => raw as ConcernShape)
    .map((c) => {
      const text = typeof c.text === 'string' ? c.text : ''
      const sevRaw = typeof c.severity === 'string' ? c.severity.toLowerCase() : ''
      const severity: 'high' | 'medium' | 'low' =
        sevRaw === 'high' ? 'high' : sevRaw === 'low' ? 'low' : 'medium'
      const sourceIds = Array.isArray(c.source_call_ids) ? c.source_call_ids : []
      const firstId =
        sourceIds.find((v): v is string => typeof v === 'string') ?? null
      const matched = firstId ? callTitleById.get(firstId) ?? null : null
      return {
        text,
        severity,
        source_call_id: firstId,
        source_call_title: matched?.title ?? null,
        source_call_started_at: matched?.started_at ?? null,
      }
    })
    .filter((c) => c.text.length > 0)
}

function severityToTier(
  severity: 'high' | 'medium' | 'low',
): 'pos' | 'warn' | 'neg' {
  if (severity === 'high') return 'neg'
  if (severity === 'medium') return 'warn'
  return 'pos'
}

function severityLabel(severity: 'high' | 'medium' | 'low'): string {
  if (severity === 'high') return 'High'
  if (severity === 'medium') return 'Medium'
  return 'Low'
}

function tierToHealthTier(tier: string | null | undefined): 'pos' | 'warn' | 'neg' | 'muted' {
  if (tier === 'green') return 'pos'
  if (tier === 'yellow') return 'warn'
  if (tier === 'red') return 'neg'
  return 'muted'
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
}

function formatShortDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export default async function ClientDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const [client, csmOptions] = await Promise.all([
    getClientById(params.id),
    listAvailableCsms(),
  ])
  if (!client) notFound()

  // Merge candidates only when the client is tagged needs_review —
  // the merge button hides on every other client, so the candidate
  // fetch is wasted work in the common case.
  const tags: string[] = Array.isArray(client.tags) ? client.tags : []
  const needsReview = tags.includes('needs_review')
  const mergeCandidates = needsReview
    ? await listMergeCandidates(client.id)
    : []

  const concerns = readConcerns(client)

  // Action items enriched with their source call's title + date, derived
  // from client.all_calls (no extra round trip).
  const callById = new Map(client.all_calls.map((c) => [c.id, c]))
  const openItems: ActionItemRow[] = client.all_action_items
    .filter((it) => it.status === 'open')
    .map((it) => {
      const call = callById.get(it.call_id)
      return {
        id: it.id,
        description: it.description,
        status: it.status as 'open' | 'done',
        call_id: it.call_id,
        call_title: call?.title ?? null,
        call_started_at: call?.started_at ?? null,
      }
    })

  // Top 3 recent calls (already sorted by getClientById).
  const recentCalls = client.recent_calls.slice(0, 3)
  const totalCalls = client.total_calls
  const meetingsThisMonth = client.meetings_this_month

  return (
    <div style={{ padding: '24px 48px 28px' }}>
      <BackToClientsButton />

      <header
        style={{
          padding: '28px 0 24px',
          borderBottom: '1px solid var(--color-geg-border)',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 24,
        }}
      >
        <div>
          <div className="geg-eyebrow">CLIENT · DETAIL</div>
          <h1
            className="geg-serif"
            style={{
              fontWeight: 500,
              fontSize: 36,
              lineHeight: 1.1,
              letterSpacing: '-0.012em',
              color: 'var(--color-geg-text)',
              margin: '8px 0 0',
            }}
          >
            {client.full_name}.
          </h1>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
          }}
        >
          <StatusPill status={client.status} />
          {client.csm_standing ? (
            <CsmStandingPill standing={client.csm_standing} />
          ) : null}
          {client.latest_health ? (
            <GegPill
              tier={tierToHealthTier(client.latest_health.tier)}
              label={`Health ${client.latest_health.score}`}
            />
          ) : null}
        </div>
      </header>

      {/* Action row + Slack-hygiene badges. Renders only when at least
          one signal is present, so default clients don't get an empty
          band below the header. */}
      {(needsReview ||
        !client.slack_channel_id ||
        !client.slack_user_id) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
            padding: '14px 0',
            borderBottom: '1px solid var(--color-geg-border)',
          }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!client.slack_channel_id ? <MissingSlackChannelPill /> : null}
            {!client.slack_user_id ? <MissingSlackUserPill /> : null}
          </div>
          {needsReview ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <MergeClientButton
                sourceId={client.id}
                sourceFullName={client.full_name}
                candidates={mergeCandidates}
              />
              <RemoveNeedsReviewButton
                clientId={client.id}
                clientName={client.full_name}
              />
            </div>
          ) : null}
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '440px 1fr',
          gap: 20,
          paddingTop: 24,
        }}
      >
        {/* LEFT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Details box */}
          <div className="geg-gold-box">
            <div className="geg-gold-box-header">
              <h3>Details</h3>
            </div>
            <div>
              <h2
                className="geg-serif"
                style={{
                  fontWeight: 500,
                  fontSize: 28,
                  lineHeight: 1.1,
                  letterSpacing: '-0.012em',
                  color: 'var(--color-geg-text)',
                  margin: '0 0 14px',
                }}
              >
                {client.full_name}.
              </h2>
              <DataRow k="Email" v={<EmailDisplay client={client} />} />
              {client.phone ? (
                <DataRow k="Phone" v={<span className="geg-data-v mono">{client.phone}</span>} mono />
              ) : null}
              {client.country ? (
                <DataRow k="Country" v={<span className="geg-data-v mono">{client.country}</span>} mono />
              ) : null}
              {client.timezone ? (
                <DataRow k="Timezone" v={<span className="geg-data-v mono">{client.timezone}</span>} mono />
              ) : null}
              {client.start_date ? (
                <DataRow
                  k="Start date"
                  v={<span className="geg-data-v mono">{formatDate(client.start_date)}</span>}
                  mono
                />
              ) : null}
              <DataRow
                k="Primary CSM"
                v={
                  <EditablePrimaryCsmCell
                    clientId={client.id}
                    value={client.active_primary_csm?.team_member_id ?? null}
                    options={csmOptions}
                    compact
                  />
                }
              />
            </div>
          </div>

          {/* Standing box */}
          <div className="geg-gold-box">
            <div className="geg-gold-box-header">
              <h3>Standing</h3>
              <span
                className="geg-mono"
                style={{
                  fontSize: 10,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--color-geg-text-faint)',
                }}
              >
                Inline · click to edit
              </span>
            </div>
            <div>
              <EditRow
                k="Status"
                v={<EditableStatusCell clientId={client.id} value={client.status} />}
              />
              <EditRow
                k="CSM standing"
                v={
                  <EditableCsmStandingCell
                    clientId={client.id}
                    value={client.csm_standing}
                  />
                }
              />
              <EditRow
                k="NPS standing"
                v={<NpsStandingPill standing={client.nps_standing} />}
              />
              <EditRow
                k="Trustpilot"
                v={
                  <EditableTrustpilotCell
                    clientId={client.id}
                    value={client.trustpilot_status}
                  />
                }
              />
              <EditRow
                k="Journey stage"
                v={
                  <EditableJourneyStageCell
                    clientId={client.id}
                    value={client.journey_stage}
                  />
                }
              />
              <EditRow
                k="NPS enabled"
                v={
                  <EditableNpsEnabledToggle
                    clientId={client.id}
                    value={client.nps_enabled}
                  />
                }
              />
              <EditRow
                k="Accountability"
                v={
                  <EditableAccountabilityEnabledToggle
                    clientId={client.id}
                    value={client.accountability_enabled}
                  />
                }
              />
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Health box */}
          <div className="geg-gold-box">
            <div className="geg-gold-box-header">
              <h3>Health</h3>
              {client.latest_health ? (
                <span
                  className="geg-mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: 'var(--color-geg-text-faint)',
                  }}
                >
                  Computed {formatDate(client.latest_health.computed_at)}
                </span>
              ) : null}
            </div>
            <div>
              {client.latest_health ? (
                <>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-end',
                      gap: 14,
                      paddingBottom: 16,
                      borderBottom: '1px solid var(--color-geg-accent-border)',
                      marginBottom: 14,
                    }}
                  >
                    <span
                      className="geg-serif"
                      style={{
                        fontWeight: 500,
                        fontSize: 56,
                        lineHeight: 1,
                        letterSpacing: '-0.02em',
                        color: 'var(--color-geg-text)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {client.latest_health.score}
                      <span
                        className="geg-mono"
                        style={{
                          fontSize: 14,
                          color: 'var(--color-geg-text-faint)',
                          marginLeft: 4,
                          letterSpacing: '0.02em',
                        }}
                      >
                        /100
                      </span>
                    </span>
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        paddingBottom: 6,
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
                        Tier
                      </span>
                      <GegPill
                        tier={tierToHealthTier(client.latest_health.tier)}
                        label={
                          client.latest_health.tier
                            ? client.latest_health.tier.charAt(0).toUpperCase() +
                              client.latest_health.tier.slice(1)
                            : 'Unknown'
                        }
                      />
                    </div>
                  </div>
                  <ConcernsList concerns={concerns} />
                </>
              ) : (
                <p
                  style={{
                    color: 'var(--color-geg-text-2)',
                    fontSize: 13,
                    fontStyle: 'italic',
                    margin: 0,
                  }}
                >
                  No health score computed yet.
                </p>
              )}
            </div>
          </div>

          {/* Action items box */}
          <div className="geg-gold-box">
            <div className="geg-gold-box-header">
              <h3>
                Action items{' '}
                <span style={{ color: 'var(--color-geg-accent)' }}>
                  {openItems.length}
                </span>
              </h3>
              <span
                className="geg-mono"
                style={{
                  fontSize: 10,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--color-geg-text-faint)',
                }}
              >
                Open · across all calls
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <ActionItemsList
                clientId={client.id}
                items={openItems}
                slackChannelId={client.slack_channel_id}
              />
            </div>
          </div>

          {/* Recent calls box */}
          <div className="geg-gold-box">
            <div className="geg-gold-box-header">
              <h3>Recent calls</h3>
            </div>
            <div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  paddingBottom: 12,
                  marginBottom: 12,
                  borderBottom: '1px solid var(--color-geg-accent-border)',
                }}
              >
                <Stat label="Total calls" value={totalCalls} />
                <Stat
                  label="This month"
                  value={meetingsThisMonth}
                  bordered
                />
              </div>
              {recentCalls.length === 0 ? (
                <p
                  style={{
                    color: 'var(--color-geg-text-2)',
                    fontSize: 13,
                    fontStyle: 'italic',
                    margin: 0,
                  }}
                >
                  No calls yet.
                </p>
              ) : (
                recentCalls.map((call) => (
                  <div
                    key={call.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '78px 1fr',
                      gap: 12,
                      padding: '9px 0',
                      borderBottom: '1px dashed rgba(160, 136, 80, 0.18)',
                      fontSize: 13,
                      alignItems: 'baseline',
                    }}
                  >
                    <span
                      className="geg-mono"
                      style={{
                        fontSize: 11,
                        color: 'var(--color-geg-text-2)',
                        letterSpacing: '0.02em',
                      }}
                    >
                      {formatDate(call.started_at)}
                    </span>
                    <Link
                      href={`/calls/${call.id}`}
                      className="geg-link"
                      style={{
                        color: 'var(--color-geg-text)',
                        textDecoration: 'none',
                        borderBottom: '1px solid transparent',
                      }}
                    >
                      {call.title ?? 'Untitled call'}
                    </Link>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function DataRow({
  k,
  v,
  mono,
}: {
  k: string
  v: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="geg-data-row">
      <span className="geg-data-k">{k}</span>
      <span className={mono ? 'geg-data-v mono' : 'geg-data-v'}>{v}</span>
    </div>
  )
}

function EditRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="geg-edit-row">
      <span className="geg-data-k">{k}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {v}
      </span>
    </div>
  )
}

function EmailDisplay({ client }: { client: ClientDetail }) {
  const alts = (client.metadata as { alternate_emails?: unknown } | null)
    ?.alternate_emails
  const alternateEmails = Array.isArray(alts)
    ? alts.filter((e): e is string => typeof e === 'string')
    : []
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ color: 'var(--color-geg-text)' }}>{client.email}</span>
      {alternateEmails.map((alt) => (
        <span
          key={alt}
          className="geg-mono"
          style={{
            fontSize: 11,
            color: 'var(--color-geg-text-2)',
            letterSpacing: '0.02em',
          }}
        >
          {alt}
        </span>
      ))}
    </span>
  )
}

function ConcernsList({
  concerns,
}: {
  concerns: ReturnType<typeof readConcerns>
}) {
  if (concerns.length === 0) {
    return (
      <p
        style={{
          color: 'var(--color-geg-text-2)',
          fontSize: 12,
          fontStyle: 'italic',
          margin: 0,
        }}
      >
        No concerns surfaced.
      </p>
    )
  }
  return (
    <>
      <h4
        className="geg-mono"
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-2)',
          margin: '0 0 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        Concerns{' '}
        <span style={{ color: 'var(--color-geg-accent)' }}>
          {concerns.length}
        </span>
      </h4>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {concerns.map((c, idx) => (
          <li
            key={idx}
            style={{
              display: 'grid',
              gridTemplateColumns: '70px 1fr',
              gap: 12,
              fontSize: 13,
              lineHeight: 1.45,
              alignItems: 'baseline',
            }}
          >
            <GegPill
              tier={severityToTier(c.severity)}
              label={severityLabel(c.severity)}
            />
            <span>
              <span style={{ color: 'var(--color-geg-text)' }}>{c.text}</span>
              {c.source_call_id && c.source_call_title ? (
                <span
                  className="geg-mono"
                  style={{
                    display: 'block',
                    fontSize: 11,
                    color: 'var(--color-geg-text-faint)',
                    marginTop: 4,
                    letterSpacing: '0.02em',
                  }}
                >
                  ↳ from{' '}
                  <Link
                    href={`/calls/${c.source_call_id}`}
                    className="geg-link"
                    style={{
                      color: 'var(--color-geg-text-2)',
                      textDecoration: 'none',
                      borderBottom: '1px solid transparent',
                    }}
                  >
                    {c.source_call_title}
                    {c.source_call_started_at
                      ? ' · ' + formatShortDate(c.source_call_started_at)
                      : ''}
                  </Link>
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

function Stat({
  label,
  value,
  bordered,
}: {
  label: string
  value: number
  bordered?: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        borderLeft: bordered
          ? '1px solid var(--color-geg-accent-border)'
          : undefined,
        paddingLeft: bordered ? 16 : 0,
      }}
    >
      <span
        className="geg-mono"
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-faint)',
        }}
      >
        {label}
      </span>
      <span
        className="geg-serif"
        style={{
          fontWeight: 500,
          fontSize: 28,
          lineHeight: 1,
          letterSpacing: '-0.01em',
          color: 'var(--color-geg-text)',
          fontVariantNumeric: 'tabular-nums',
          marginTop: 2,
        }}
      >
        {value}
      </span>
    </div>
  )
}
