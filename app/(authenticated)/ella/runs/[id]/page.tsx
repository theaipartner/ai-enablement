import { notFound } from 'next/navigation'
import { getEllaRunDetail, type EllaRunDetail } from '@/lib/db/ella-runs'
import { HeaderBand } from '@/components/gregory/header-band'
import { DiagnosticsCollapse } from '@/components/gregory/diagnostics-collapse'
import { EmptyStateAwareSection } from '@/components/gregory/empty-state-aware-section'
import { RolePill, RunStatusPill } from '../pills'

// Part 2 redesign:
// - HeaderBand replaces the hand-rolled header. backlink slot replaces
//   the standalone "← BACK TO ELLA RUNS" link. Title is derived from
//   run shape (verb + responder + #channel). Pills slot carries status
//   + trigger-type. Actions slot carries cost · tokens · duration.
// - Meta-row below the HeaderBand carries channel / responder / started /
//   model — a single labeled row of contextual chrome, not a full Section.
// - The V1 standalone "Run header" Section is gone; its content was
//   either promoted into the HeaderBand or moved to the meta-row.
// - "Surrounding thread context" Section renamed → "Surrounding messages"
//   and rendered for BOTH reactive runs (thread query) and passive runs
//   (last-5-in-channel query). The V1 dev-facing "synthetic test ts
//   predating the backfill" placeholder is gone.
// - "Triggering message" Section (formerly "Input") keeps its zinc-50
//   box and footer; just renamed.
// - New "What Haiku decided" Section, conditional on
//   trigger_type='passive_monitor'. Reads haiku_decision + haiku_reasoning
//   from getEllaRunDetail's new fields.
// - "Trigger metadata" is now inside DiagnosticsCollapse (collapsed by
//   default for everyone per Part 1 Decision 5).

function fmtCost(c: number | null): string {
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

// Trigger-type display label. Reactive @-mentions read as "@-mention";
// passive_monitor reads as "passive monitor". Anything else (bare_mention,
// legacy values) falls through unchanged.
function triggerTypeDisplay(triggerType: string): string {
  if (triggerType === 'slack_mention' || triggerType === 'app_mention') return '@-mention'
  if (triggerType === 'bare_mention') return 'bare @-mention'
  if (triggerType === 'passive_monitor') return 'passive monitor'
  return triggerType.replace(/_/g, ' ')
}

// Decision label for the "What Haiku decided" section. Maps the raw
// enum to the human-readable phrasing the spec specified.
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

// Derive a human-readable detail-page title from run shape:
//   Responded to {name} in #{channel}     (success, default)
//   Skipped {name} in #{channel}          (status='skipped' or haiku skip)
//   Escalated {name} in #{channel}        (status='escalated' or haiku escalate)
//   Errored on {name} in #{channel}       (status='error')
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
  // Use the same preposition for "Errored on" vs "Responded to / Skipped /
  // Escalated"; reads naturally across all four shapes.
  if (verb === 'Errored on') return `${verb} ${responder} in ${channelLabel}`
  return `${verb} ${responder} in ${channelLabel}`
}

export default async function EllaRunDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const run = await getEllaRunDetail(params.id)
  if (!run) notFound()

  // For Slack response detection: split into client-facing + handoff
  // if the marker is present (mirroring the Batch 1.5 detector).
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

  const isPassive = run.trigger_type === 'passive_monitor'

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
            {fmtCost(run.llm_cost_usd)} · {fmtTokens(run.llm_input_tokens, run.llm_output_tokens)} · {run.duration_ms ?? '—'} ms
          </span>
        }
      />

      {/* Meta-row: single Section with the run's context that isn't
          identity (already in the HeaderBand) but reads as essential
          chrome below the title. */}
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

      <SurroundingMessagesSection run={run} />

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

      {/* Haiku-decision section — hidden entirely for reactive runs (no
          Haiku step happened). For passive runs without recorded
          decision data (skip decisions never land in pending_ella_responses,
          and a corrupted run might lack metadata too), render a stub. */}
      <HaikuDecisionSection run={run} isPassive={isPassive} />

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
        <pre className="overflow-x-auto rounded bg-zinc-50 p-3 font-mono text-xs">
          {JSON.stringify(run.trigger_metadata, null, 2)}
        </pre>
      </DiagnosticsCollapse>
    </div>
  )
}

// Renders the "Surrounding messages" section. Dual-mode: thread (for
// reactive runs with thread_ts) or last-N-in-channel (for passive runs).
// Both render through the same body code; only the data fetch differs
// (handled upstream in getEllaRunDetail).
function SurroundingMessagesSection({ run }: { run: EllaRunDetail }) {
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
  isPassive,
}: {
  run: EllaRunDetail
  isPassive: boolean
}) {
  if (!isPassive) {
    // Reactive runs never went through Haiku — hide the section entirely
    // per Part 1 § Empty-state rules (mode='hide').
    return (
      <EmptyStateAwareSection
        title="What Haiku decided"
        mode="hide"
      />
    )
  }
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
