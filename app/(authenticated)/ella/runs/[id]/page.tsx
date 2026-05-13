import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getEllaRunDetail, type EllaRunDetail } from '@/lib/db/ella-runs'
import { DiagnosticsCollapse } from '@/components/gregory/diagnostics-collapse'
import { ExpandableMessage } from './expandable-message'
import { RolePill, RunStatusPill, TriggerTypePill } from '../pills'
import { GegPill } from '@/components/gregory/geg-pill'

// Ella audit redesign — detail page.
//
// Two-column grid (420 / 1fr). LEFT stack: Context + Haiku decision.
// RIGHT stack: Triggering message + Ella's response — both rendered
// via the slack-msg block (ExpandableMessage with optional author /
// time). Both messages preserve the "Show more" toggle for content
// over 500 chars.
//
// Section layering swap vs the prior V2 layout:
//   - Removed the white MetaRowSection chrome. Boxes now follow the
//     gold-box treatment from the Calls + Clients redesigns.
//   - Surrounding messages section already removed in a prior spec;
//     data layer paths preserved.
//   - Header restyled to match the Calls + Clients detail headers:
//     eyebrow + serif title + pill row + right-aligned mono stats.
// Routes + data unchanged.

function fmtCost(c: number | null | undefined): string {
  if (c == null) return '—'
  return `$${c.toFixed(4)}`
}

function fmtTokens(inTok: number | null, outTok: number | null): string {
  if (inTok == null && outTok == null) return '—'
  return `${(inTok ?? 0).toLocaleString()} / ${(outTok ?? 0).toLocaleString()}`
}

function haikuDecisionDisplay(decision: string | null): string {
  if (!decision) return '—'
  switch (decision) {
    case 'respond_substantive':
      return 'Respond — substantive'
    case 'respond_general_inquiry':
      return 'Respond — general inquiry'
    case 'skip':
      return 'Skip'
    case 'escalate':
      return 'Escalate'
    default:
      return decision.replace(/_/g, ' ')
  }
}

const REACTIVE_TRIGGER_TYPES: ReadonlySet<string> = new Set([
  'slack_mention',
  'bare_mention',
  'app_mention',
])

function isReactiveTrigger(triggerType: string): boolean {
  return REACTIVE_TRIGGER_TYPES.has(triggerType)
}

function syntheticReactiveHaiku(run: EllaRunDetail): {
  decision: string
  reasoning: string
} {
  const responder = run.real_author_name ?? run.real_author_role
  return {
    decision: 'Responded — direct mention',
    reasoning: responder
      ? `Direct @-mention from ${responder}`
      : 'Direct @-mention',
  }
}

function deriveTitle(run: EllaRunDetail): string {
  const channelLabel = run.channel_name ? `#${run.channel_name}` : '#unknown'
  const responder = run.real_author_name ?? run.real_author_role ?? 'unresolved'
  let verb = 'Responded to'
  if (run.status === 'error') verb = 'Errored on'
  else if (run.status === 'escalated' || run.haiku_decision === 'escalate') {
    verb = 'Escalated'
  } else if (run.status === 'skipped' || run.haiku_decision === 'skip') {
    verb = 'Skipped'
  }
  return `${verb} ${responder} in ${channelLabel}`
}

function rollupCost(run: EllaRunDetail): {
  total_cost: number | null
  total_input_tokens: number | null
  total_output_tokens: number | null
  response_cost: number | null
  response_input_tokens: number | null
  response_output_tokens: number | null
  haiku_cost: number | null
  haiku_input_tokens: number | null
  haiku_output_tokens: number | null
} {
  const responseCost = run.llm_cost_usd ?? null
  const responseIn = run.llm_input_tokens ?? null
  const responseOut = run.llm_output_tokens ?? null
  const haikuCost = run.haiku_cost_usd ?? null
  const haikuIn = run.haiku_input_tokens ?? null
  const haikuOut = run.haiku_output_tokens ?? null

  if (haikuCost == null && haikuIn == null && haikuOut == null) {
    return {
      total_cost: responseCost,
      total_input_tokens: responseIn,
      total_output_tokens: responseOut,
      response_cost: responseCost,
      response_input_tokens: responseIn,
      response_output_tokens: responseOut,
      haiku_cost: null,
      haiku_input_tokens: null,
      haiku_output_tokens: null,
    }
  }
  return {
    total_cost: (responseCost ?? 0) + (haikuCost ?? 0),
    total_input_tokens: (responseIn ?? 0) + (haikuIn ?? 0),
    total_output_tokens: (responseOut ?? 0) + (haikuOut ?? 0),
    response_cost: responseCost,
    response_input_tokens: responseIn,
    response_output_tokens: responseOut,
    haiku_cost: haikuCost,
    haiku_input_tokens: haikuIn,
    haiku_output_tokens: haikuOut,
  }
}

function formatStartedAt(iso: string): string {
  const d = new Date(iso)
  const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
  const time = d.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
  return `${date} · ${time}`
}

function formatTimeOnly(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export default async function EllaRunDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const run = await getEllaRunDetail(params.id)
  if (!run) notFound()

  const fullResponse = run.slack_response_text
  let clientFacing: string | null = null
  let handoff: string | null = null
  if (fullResponse && fullResponse.includes('[ESCALATE]')) {
    const idx = fullResponse.indexOf('[ESCALATE]')
    clientFacing = fullResponse.slice(0, idx).trimEnd()
    handoff = fullResponse.slice(idx + '[ESCALATE]'.length).trimStart()
  } else if (fullResponse) {
    clientFacing = fullResponse
  }

  const reactive = isReactiveTrigger(run.trigger_type)
  const cost = rollupCost(run)

  const triggerAuthor =
    run.real_author_name ?? run.real_author_role ?? 'Unknown'
  const triggerTime = formatTimeOnly(run.started_at)

  return (
    <div style={{ padding: '24px 48px 28px' }}>
      <Link
        href="/ella/runs"
        className="geg-mono"
        style={{
          color: 'var(--color-geg-accent)',
          textDecoration: 'none',
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
        }}
      >
        ← BACK TO RUN HISTORY
      </Link>

      <header
        style={{
          padding: '26px 0 22px',
          borderBottom: '1px solid var(--color-geg-border)',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 24,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="geg-eyebrow">ELLA · RUN</div>
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
            {deriveTitle(run)}.
          </h1>
          <div
            style={{
              display: 'flex',
              gap: 8,
              marginTop: 12,
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <RunStatusPill status={run.status} />
            <TriggerTypePill triggerType={run.trigger_type} />
            {run.llm_model ? (
              <GegPill tier="muted" label={run.llm_model} />
            ) : null}
          </div>
        </div>
        <div
          className="geg-mono"
          style={{
            fontSize: 11,
            color: 'var(--color-geg-text-2)',
            textAlign: 'right',
            letterSpacing: '0.02em',
            lineHeight: 1.6,
            paddingBottom: 6,
          }}
        >
          <b style={{ color: 'var(--color-geg-text)', fontWeight: 500 }}>
            {fmtCost(cost.total_cost)}
          </b>{' '}
          total
          <br />
          {fmtTokens(cost.total_input_tokens, cost.total_output_tokens)} tokens
          <br />
          {run.duration_ms ?? '—'} ms
        </div>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '420px 1fr',
          gap: 20,
          paddingTop: 22,
        }}
      >
        {/* LEFT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Context box */}
          <div className="geg-gold-box">
            <div className="geg-gold-box-header">
              <h3>Context</h3>
            </div>
            <div>
              <DataRow
                k="Channel"
                v={
                  run.channel_name ? (
                    <span
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      }}
                    >
                      <span style={{ color: 'var(--color-geg-text)' }}>
                        #{run.channel_name}
                      </span>
                      {run.channel_client_name ? (
                        <span
                          className="geg-mono"
                          style={{
                            fontSize: 11,
                            color: 'var(--color-geg-text-2)',
                            letterSpacing: '0.02em',
                          }}
                        >
                          → {run.channel_client_name}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--color-geg-text-faint)' }}>
                      —
                    </span>
                  )
                }
              />
              <DataRow
                k="Responded to"
                v={
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    {run.real_author_name ?? (
                      <span style={{ color: 'var(--color-geg-text-faint)' }}>
                        unresolved
                      </span>
                    )}
                    <RolePill role={run.real_author_role} />
                  </span>
                }
              />
              <DataRow
                k="Started"
                v={
                  <span
                    className="geg-mono"
                    style={{
                      fontSize: 12,
                      color: 'var(--color-geg-text-2)',
                      letterSpacing: '0.02em',
                    }}
                    title={run.started_at}
                  >
                    {formatStartedAt(run.started_at)}
                  </span>
                }
              />
              <DataRow
                k="Trigger"
                v={
                  <span
                    className="geg-mono"
                    style={{
                      fontSize: 12,
                      color: 'var(--color-geg-text-2)',
                      letterSpacing: '0.02em',
                    }}
                  >
                    {run.trigger_type}
                  </span>
                }
              />
              <DataRow
                k="Model"
                v={
                  <span
                    className="geg-mono"
                    style={{
                      fontSize: 12,
                      color: 'var(--color-geg-text-2)',
                      letterSpacing: '0.02em',
                    }}
                  >
                    {run.llm_model ?? '—'}
                  </span>
                }
              />
            </div>
          </div>

          {/* Haiku decision box */}
          <HaikuDecisionBox run={run} reactive={reactive} />

          {/* Escalation box (when present) */}
          {run.escalation ? (
            <div className="geg-gold-box">
              <div className="geg-gold-box-header">
                <h3>Escalation</h3>
              </div>
              <div>
                <DataRow
                  k="Reason"
                  v={
                    <span
                      className="geg-mono"
                      style={{
                        fontSize: 12,
                        color: 'var(--color-geg-text-2)',
                        letterSpacing: '0.02em',
                      }}
                    >
                      {run.escalation.reason}
                    </span>
                  }
                />
                <DataRow k="Status" v={run.escalation.status} />
                {run.escalation.resolved_at ? (
                  <DataRow
                    k="Resolved"
                    v={
                      <span
                        className="geg-mono"
                        style={{
                          fontSize: 12,
                          color: 'var(--color-geg-text-2)',
                          letterSpacing: '0.02em',
                        }}
                      >
                        {run.escalation.resolved_at}
                      </span>
                    }
                  />
                ) : (
                  <DataRow
                    k="Resolved"
                    v={
                      <span style={{ color: 'var(--color-geg-text-faint)' }}>
                        pending
                      </span>
                    }
                  />
                )}
              </div>
            </div>
          ) : null}
        </div>

        {/* RIGHT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Triggering message */}
          <div className="geg-gold-box">
            <div className="geg-gold-box-header">
              <h3>Triggering message</h3>
              <span
                className="geg-mono"
                style={{
                  fontSize: 10,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--color-geg-text-faint)',
                }}
              >
                {run.triggering_message_full_text == null &&
                run.input_summary != null
                  ? 'Summary fallback'
                  : `From ${triggerAuthor} · ${triggerTime}`}
              </span>
            </div>
            <div>
              {run.triggering_message_full_text ?? run.input_summary ? (
                <ExpandableMessage
                  text={
                    run.triggering_message_full_text ??
                    run.input_summary ??
                    ''
                  }
                  author={triggerAuthor}
                  timeLabel={triggerTime}
                />
              ) : (
                <div
                  style={{
                    background: 'rgba(0, 0, 0, 0.18)',
                    border: '1px solid rgba(255, 255, 255, 0.04)',
                    borderRadius: 6,
                    padding: '14px 16px',
                    color: 'var(--color-geg-text-faint)',
                    fontStyle: 'italic',
                  }}
                >
                  (no input recorded)
                </div>
              )}
            </div>
          </div>

          {/* Ella's response */}
          <div className="geg-gold-box">
            <div className="geg-gold-box-header">
              <h3>Ella&apos;s response</h3>
              <span
                className="geg-mono"
                style={{
                  fontSize: 10,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--color-geg-text-faint)',
                }}
              >
                {clientFacing
                  ? `From slack_messages · ${triggerTime}`
                  : run.output_summary
                    ? 'Output summary fallback'
                    : 'No response'}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {clientFacing == null && run.output_summary == null ? (
                <div
                  style={{
                    color: 'var(--color-geg-text-faint)',
                    fontStyle: 'italic',
                    fontSize: 13,
                  }}
                >
                  No response found.
                </div>
              ) : (
                <>
                  {clientFacing ? (
                    <ExpandableMessage
                      text={clientFacing}
                      author="Ella"
                      authorIsElla
                      timeLabel={triggerTime}
                    />
                  ) : null}
                  {handoff ? (
                    <div>
                      <div
                        className="geg-mono"
                        style={{
                          fontSize: 10,
                          letterSpacing: '0.14em',
                          textTransform: 'uppercase',
                          color: 'var(--color-geg-neg)',
                          marginBottom: 6,
                        }}
                      >
                        Captured handoff (stripped before posting)
                      </div>
                      <pre
                        style={{
                          background: 'rgba(201, 119, 102, 0.08)',
                          border: '1px solid var(--color-geg-neg-border)',
                          borderRadius: 6,
                          padding: '12px 14px',
                          whiteSpace: 'pre-wrap',
                          color: 'var(--color-geg-text)',
                          fontFamily: 'inherit',
                          fontSize: 13,
                          margin: 0,
                        }}
                      >
                        {handoff}
                      </pre>
                    </div>
                  ) : null}
                  {clientFacing == null && run.output_summary ? (
                    <ExpandableMessage
                      text={run.output_summary}
                      author="Ella"
                      authorIsElla
                      timeLabel={triggerTime}
                    />
                  ) : null}
                </>
              )}
              {run.error_message ? (
                <div>
                  <div
                    className="geg-mono"
                    style={{
                      fontSize: 10,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase',
                      color: 'var(--color-geg-neg)',
                      marginBottom: 6,
                    }}
                  >
                    Error message
                  </div>
                  <pre
                    style={{
                      background: 'rgba(201, 119, 102, 0.08)',
                      border: '1px solid var(--color-geg-neg-border)',
                      borderRadius: 6,
                      padding: '12px 14px',
                      whiteSpace: 'pre-wrap',
                      fontFamily:
                        'var(--font-geg-mono, "JetBrains Mono", ui-monospace, monospace)',
                      fontSize: 12,
                      color: 'var(--color-geg-text)',
                      margin: 0,
                    }}
                  >
                    {run.error_message}
                  </pre>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 28 }}>
        <DiagnosticsCollapse>
          {cost.haiku_cost != null ||
          cost.haiku_input_tokens != null ||
          cost.haiku_output_tokens != null ? (
            <div className="mb-4">
              <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                Cost breakdown (response = Sonnet · decision = Haiku)
              </div>
              <div className="grid grid-cols-[200px_1fr] gap-2 text-xs font-mono">
                <div className="text-muted-foreground">Sonnet response</div>
                <div>
                  {fmtCost(cost.response_cost)} ·{' '}
                  {fmtTokens(
                    cost.response_input_tokens,
                    cost.response_output_tokens,
                  )}
                </div>
                <div className="text-muted-foreground">Haiku decision</div>
                <div>
                  {fmtCost(cost.haiku_cost)} ·{' '}
                  {fmtTokens(
                    cost.haiku_input_tokens,
                    cost.haiku_output_tokens,
                  )}
                  {run.haiku_agent_run_id ? (
                    <>
                      {' '}
                      <span className="text-muted-foreground">
                        (run {run.haiku_agent_run_id})
                      </span>
                    </>
                  ) : null}
                </div>
                <div className="text-muted-foreground">Total</div>
                <div>
                  {fmtCost(cost.total_cost)} ·{' '}
                  {fmtTokens(
                    cost.total_input_tokens,
                    cost.total_output_tokens,
                  )}
                </div>
              </div>
            </div>
          ) : null}
          <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
            Trigger metadata
          </div>
          <pre className="overflow-x-auto rounded bg-zinc-900 p-3 font-mono text-xs text-zinc-300">
            {JSON.stringify(run.trigger_metadata, null, 2)}
          </pre>
        </DiagnosticsCollapse>
      </div>
    </div>
  )
}

function DataRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="geg-data-row">
      <span className="geg-data-k">{k}</span>
      <span className="geg-data-v">{v}</span>
    </div>
  )
}

function HaikuDecisionBox({
  run,
  reactive,
}: {
  run: EllaRunDetail
  reactive: boolean
}) {
  let decision: string
  let reasoning: string | null
  let isSynthetic = false
  if (reactive) {
    const synthetic = syntheticReactiveHaiku(run)
    decision = synthetic.decision
    reasoning = synthetic.reasoning
    isSynthetic = true
  } else if (!run.haiku_decision && !run.haiku_reasoning) {
    decision = '—'
    reasoning = null
  } else {
    decision = haikuDecisionDisplay(run.haiku_decision)
    reasoning = run.haiku_reasoning
  }

  return (
    <div className="geg-gold-box" style={{ flex: 1 }}>
      <div className="geg-gold-box-header">
        <h3>Haiku decision</h3>
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-faint)',
          }}
        >
          Why Ella spoke
        </span>
      </div>
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            paddingBottom: 14,
            marginBottom: 14,
            borderBottom: '1px solid var(--color-geg-accent-border)',
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
            Decision
          </span>
          <span
            className="geg-serif"
            style={{
              fontWeight: 500,
              fontSize: 22,
              letterSpacing: '-0.01em',
              color: 'var(--color-geg-text)',
              marginLeft: 'auto',
              textAlign: 'right',
            }}
          >
            {decision}
          </span>
        </div>
        {reasoning ? (
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
              }}
            >
              Reasoning
            </h4>
            <p
              className="geg-serif"
              style={{
                fontWeight: 400,
                fontSize: 14.5,
                lineHeight: 1.6,
                color: isSynthetic
                  ? 'var(--color-geg-text-2)'
                  : 'var(--color-geg-text)',
                fontStyle: isSynthetic ? 'italic' : 'normal',
                margin: 0,
              }}
            >
              {reasoning}
            </p>
          </>
        ) : (
          <p
            style={{
              fontSize: 13,
              color: 'var(--color-geg-text-faint)',
              fontStyle: 'italic',
              margin: 0,
            }}
          >
            No Haiku decision recorded for this run.
          </p>
        )}
      </div>
    </div>
  )
}
