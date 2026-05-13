import { notFound } from 'next/navigation'
import { getEllaRunDetail, type EllaRunDetail } from '@/lib/db/ella-runs'
import { HeaderBand } from '@/components/gregory/header-band'
import { DiagnosticsCollapse } from '@/components/gregory/diagnostics-collapse'
import { EmptyStateAwareSection } from '@/components/gregory/empty-state-aware-section'
import { RolePill, RunStatusPill } from '../pills'

// Part 2 detail-and-cleanup redesign:
// - Section order: Context → Triggering message → Ella's response →
//   Surrounding messages → Haiku decision → Escalation → Diagnostics.
//   Workflow order beats audit order; this matches the conventions doc.
// - Haiku decision section ALWAYS renders. Reactive @-mentions get
//   synthetic content ("Responded — direct mention" / "Direct @-mention
//   from {name}") because the @-mention itself is the reason. Passive
//   runs surface the real Haiku data (forward lookup on passive_monitor
//   rows; reverse lookup via trigger_metadata.pending_id on
//   passive_substantive / _general_inquiry rows — both handled in
//   getEllaRunDetail).
// - Surrounding messages ALWAYS includes the trigger (data layer
//   guarantees this even when the trigger isn't in slack_messages).
//   No empty-state.
// - Cost display: for passive_substantive / _general_inquiry rows the
//   user-visible cost is the SUM of the Sonnet response (the row
//   itself) and the linked Haiku decision (forwarded from the data
//   layer). Diagnostics shows the breakdown.

function fmtCost(c: number | null | undefined): string {
  if (c == null) return '—'
  return `$${c.toFixed(4)}`
}

function fmtTokens(inTok: number | null, outTok: number | null): string {
  if (inTok == null && outTok == null) return '—'
  return `${(inTok ?? 0).toLocaleString()} / ${(outTok ?? 0).toLocaleString()}`
}

function MetaRowSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2 rounded-md border bg-white p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

function KeyValue({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-baseline gap-3 text-sm">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div>{value}</div>
    </div>
  )
}

// Trigger-type display label.
function triggerTypeDisplay(triggerType: string): string {
  if (triggerType === 'slack_mention' || triggerType === 'app_mention') return '@-mention'
  if (triggerType === 'bare_mention') return 'bare @-mention'
  if (triggerType === 'passive_monitor') return 'passive monitor'
  if (triggerType === 'passive_substantive') return 'passive response'
  if (triggerType === 'passive_general_inquiry') return 'passive opener'
  return triggerType.replace(/_/g, ' ')
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

// Reactive @-mention shapes don't have a Haiku step — the user's
// direct mention IS the reason Ella spoke. Synthesize a Decision +
// Reasoning so the Haiku section can render consistently across both
// trigger paths.
function REACTIVE_TRIGGER_TYPES(): ReadonlySet<string> {
  return new Set(['slack_mention', 'bare_mention', 'app_mention'])
}

function isReactiveTrigger(triggerType: string): boolean {
  return REACTIVE_TRIGGER_TYPES().has(triggerType)
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

// User-visible cost / tokens / model for the run header. For passive
// Sonnet response runs (passive_substantive) and passive general-
// inquiry runs, we sum the row's own cost with the linked Haiku
// decision row's cost so the headline figure reflects the "true total"
// for the user-visible event. Reactive and passive_monitor rows fall
// through with their own row data.
function rollupCost(run: EllaRunDetail): {
  total_cost: number | null
  total_input_tokens: number | null
  total_output_tokens: number | null
  // Original row figures stay available for the Diagnostics breakdown.
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

  // No linked Haiku row → totals match the response row.
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

export default async function EllaRunDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const run = await getEllaRunDetail(params.id)
  if (!run) notFound()

  // Slack response detection: split client-facing + handoff if the
  // marker is present (mirroring the Batch 1.5 detector).
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

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-8 py-8">
      <HeaderBand
        eyebrow="ELLA · RUN"
        title={deriveTitle(run)}
        backlink={{ href: '/ella/runs', label: 'Back to Ella runs' }}
        pills={
          <>
            <RunStatusPill status={run.status} />
            <span
              className="inline-flex items-center rounded-full border bg-zinc-50 px-2 py-0.5 text-[11px] font-normal text-zinc-700"
              aria-label={`Trigger type: ${triggerTypeDisplay(run.trigger_type)}`}
            >
              {triggerTypeDisplay(run.trigger_type)}
            </span>
          </>
        }
        actions={
          <span className="font-mono text-xs text-muted-foreground">
            {fmtCost(cost.total_cost)} · {fmtTokens(cost.total_input_tokens, cost.total_output_tokens)} · {run.duration_ms ?? '—'} ms
          </span>
        }
      />

      {/* Context — a single labeled row of contextual chrome below the title. */}
      <MetaRowSection title="Context">
        <KeyValue
          label="Channel"
          value={
            run.channel_name ? (
              <span>
                #{run.channel_name}
                {run.channel_client_name ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    → {run.channel_client_name}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )
          }
        />
        <KeyValue
          label="Who Ella responded to"
          value={
            <div className="flex items-center gap-2">
              <span>{run.real_author_name ?? 'unresolved'}</span>
              <RolePill role={run.real_author_role} />
            </div>
          }
        />
        <KeyValue
          label="Started at"
          value={
            <span title={run.started_at}>
              {new Date(run.started_at).toLocaleString()}
            </span>
          }
        />
        <KeyValue label="Model" value={run.llm_model ?? '—'} />
      </MetaRowSection>

      {/* Section order: Triggering message → Ella's response →
          Surrounding messages → Haiku decision. Workflow order. */}
      <MetaRowSection title="Triggering message">
        <div className="space-y-2 text-sm">
          <div className="rounded bg-zinc-50 p-3">
            {run.input_summary ?? (
              <span className="text-muted-foreground">(no input recorded)</span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            Trigger type: <code>{run.trigger_type}</code>
            {run.trigger_ts ? <> · ts: <code>{run.trigger_ts}</code></> : null}
            {run.thread_ts ? <> · thread_ts: <code>{run.thread_ts}</code></> : null}
          </div>
        </div>
      </MetaRowSection>

      <MetaRowSection title="Ella's response">
        {clientFacing == null && run.output_summary == null ? (
          <div className="text-sm text-muted-foreground">No response found.</div>
        ) : (
          <div className="space-y-3 text-sm">
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                Client-facing (from `slack_messages`)
              </div>
              <pre className="whitespace-pre-wrap rounded bg-zinc-50 p-3 font-sans">
                {clientFacing ?? (
                  <span className="text-muted-foreground">
                    (no slack_messages match — falling back to output_summary below)
                  </span>
                )}
              </pre>
            </div>
            {handoff ? (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-rose-700">
                  Captured handoff (stripped before posting)
                </div>
                <pre className="whitespace-pre-wrap rounded bg-rose-50 p-3 font-sans">
                  {handoff}
                </pre>
              </div>
            ) : null}
            {clientFacing == null && run.output_summary ? (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                  output_summary (200-char limit)
                </div>
                <pre className="whitespace-pre-wrap rounded bg-zinc-50 p-3 font-sans">
                  {run.output_summary}
                </pre>
              </div>
            ) : null}
          </div>
        )}
        {run.error_message ? (
          <div className="mt-3">
            <div className="mb-1 text-xs uppercase tracking-wide text-rose-700">
              Error message
            </div>
            <pre className="whitespace-pre-wrap rounded bg-rose-50 p-3 font-mono text-xs">
              {run.error_message}
            </pre>
          </div>
        ) : null}
      </MetaRowSection>

      <SurroundingMessagesSection run={run} />

      <HaikuDecisionSection run={run} reactive={reactive} />

      {run.escalation ? (
        <MetaRowSection title="Escalation">
          <KeyValue
            label="Reason"
            value={<code className="text-xs">{run.escalation.reason}</code>}
          />
          <KeyValue label="Status" value={run.escalation.status} />
          {run.escalation.handoff_reasoning ? (
            <KeyValue
              label="Handoff reasoning"
              value={
                <div className="whitespace-pre-wrap text-sm">
                  {run.escalation.handoff_reasoning}
                </div>
              }
            />
          ) : null}
          {run.escalation.resolution_note ? (
            <KeyValue
              label="Resolution note"
              value={run.escalation.resolution_note}
            />
          ) : null}
          <KeyValue
            label="Resolved at"
            value={
              run.escalation.resolved_at ?? (
                <span className="text-muted-foreground">pending</span>
              )
            }
          />
        </MetaRowSection>
      ) : null}

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
                {fmtTokens(cost.response_input_tokens, cost.response_output_tokens)}
              </div>
              <div className="text-muted-foreground">Haiku decision</div>
              <div>
                {fmtCost(cost.haiku_cost)} ·{' '}
                {fmtTokens(cost.haiku_input_tokens, cost.haiku_output_tokens)}
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
                {fmtTokens(cost.total_input_tokens, cost.total_output_tokens)}
              </div>
            </div>
          </div>
        ) : null}
        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
          Trigger metadata
        </div>
        <pre className="overflow-x-auto rounded bg-zinc-50 p-3 font-mono text-xs">
          {JSON.stringify(run.trigger_metadata, null, 2)}
        </pre>
      </DiagnosticsCollapse>
    </div>
  )
}

function SurroundingMessagesSection({ run }: { run: EllaRunDetail }) {
  // Data layer guarantees thread_messages has at least the trigger;
  // no empty-state path. If the array is somehow empty (degenerate
  // case — channel and trigger_ts both unresolvable), render a stub.
  if (run.thread_messages.length === 0) {
    return (
      <EmptyStateAwareSection
        title="Surrounding messages"
        mode="stub"
        stubContent={
          <div className="text-sm text-muted-foreground">
            No surrounding messages available.
          </div>
        }
      />
    )
  }
  return (
    <MetaRowSection title="Surrounding messages">
      <div className="space-y-1 text-sm">
        {run.thread_messages.map((m) => {
          const hhmm = new Date(m.sent_at).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })
          const author = m.display_name ?? m.slack_user_id
          return (
            <div
              key={m.slack_ts}
              className={
                m.is_trigger
                  ? 'rounded bg-amber-50 p-2 font-medium'
                  : 'p-2'
              }
            >
              <span className="font-mono text-xs text-muted-foreground">
                [{hhmm}]
              </span>{' '}
              <span className="text-xs text-muted-foreground">
                {m.author_type}
              </span>{' '}
              <span className="font-medium">{author}:</span>{' '}
              <span>{m.text}</span>
              {m.is_trigger ? (
                <span className="ml-1 text-xs uppercase tracking-wide text-amber-700">
                  ← trigger
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
    </MetaRowSection>
  )
}

function HaikuDecisionSection({
  run,
  reactive,
}: {
  run: EllaRunDetail
  reactive: boolean
}) {
  // Reactive @-mention shapes: render synthetic content so the section
  // appears consistently across all runs. The mention itself is the
  // reason Ella spoke; we say that explicitly.
  if (reactive) {
    const synthetic = syntheticReactiveHaiku(run)
    return (
      <MetaRowSection title="What Haiku decided">
        <KeyValue
          label="Decision"
          value={<span className="font-medium">{synthetic.decision}</span>}
        />
        <KeyValue
          label="Reasoning"
          value={
            <div className="whitespace-pre-wrap text-sm">{synthetic.reasoning}</div>
          }
        />
      </MetaRowSection>
    )
  }
  // Passive shapes — real data via forward lookup (passive_monitor) or
  // reverse lookup (passive_substantive / passive_general_inquiry) in
  // getEllaRunDetail. Empty = data-quality issue; render a stub.
  if (!run.haiku_decision && !run.haiku_reasoning) {
    return (
      <EmptyStateAwareSection
        title="What Haiku decided"
        mode="stub"
        stubContent={
          <div className="text-sm text-muted-foreground">
            No Haiku decision recorded for this run.
          </div>
        }
      />
    )
  }
  return (
    <MetaRowSection title="What Haiku decided">
      <KeyValue
        label="Decision"
        value={
          <span className="font-medium">
            {haikuDecisionDisplay(run.haiku_decision)}
          </span>
        }
      />
      {run.haiku_reasoning ? (
        <KeyValue
          label="Reasoning"
          value={
            <div className="whitespace-pre-wrap text-sm">
              {run.haiku_reasoning}
            </div>
          }
        />
      ) : null}
    </MetaRowSection>
  )
}
