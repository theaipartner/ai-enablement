import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeftIcon } from 'lucide-react'
import { getEllaRunDetail } from '@/lib/db/ella-runs'
import {
  AnomalyFlagsRow,
  RolePill,
  RunStatusPill,
} from '../pills'

function fmtCost(c: number | null): string {
  if (c == null) return '—'
  return `$${c.toFixed(4)}`
}

function fmtTokens(inTok: number | null, outTok: number | null): string {
  if (inTok == null && outTok == null) return '—'
  return `${(inTok ?? 0).toLocaleString()} / ${(outTok ?? 0).toLocaleString()}`
}

function Section({
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
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div>{value}</div>
    </div>
  )
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

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <Link
        href="/ella/runs"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="h-4 w-4" />
        Back to Ella runs
      </Link>

      <Section title="Run header">
        <KeyValue label="Run ID" value={<code className="text-xs">{run.id}</code>} />
        <KeyValue label="Started at" value={<span title={run.started_at}>{new Date(run.started_at).toLocaleString()}</span>} />
        <KeyValue
          label="Channel"
          value={
            run.channel_name
              ? `#${run.channel_name} (${run.slack_channel_id}) → ${run.channel_client_name ?? 'unmapped'}`
              : '—'
          }
        />
        <KeyValue
          label="Real author"
          value={
            <div className="flex items-center gap-2">
              <span>{run.real_author_name ?? 'unresolved'}</span>
              <RolePill role={run.real_author_role} />
            </div>
          }
        />
        <KeyValue label="Status" value={<RunStatusPill status={run.status} />} />
        <KeyValue label="Anomaly flags" value={<AnomalyFlagsRow flags={run.anomaly_flags} />} />
        <KeyValue label="Cost / tokens / duration" value={
          <span className="font-mono text-xs">
            {fmtCost(run.llm_cost_usd)} · {fmtTokens(run.llm_input_tokens, run.llm_output_tokens)} · {run.duration_ms ?? '—'} ms
          </span>
        } />
        <KeyValue label="Model" value={run.llm_model ?? '—'} />
      </Section>

      <Section title="Input">
        <div className="space-y-2 text-sm">
          <div className="rounded bg-zinc-50 p-3">{run.input_summary ?? <span className="text-muted-foreground">(no input recorded)</span>}</div>
          <div className="text-xs text-muted-foreground">
            Trigger type: <code>{run.trigger_type}</code>
            {run.trigger_ts ? <> · ts: <code>{run.trigger_ts}</code></> : null}
            {run.thread_ts ? <> · thread_ts: <code>{run.thread_ts}</code></> : null}
          </div>
        </div>
      </Section>

      <Section title="Surrounding thread context">
        {run.thread_messages.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No `slack_messages` rows found for thread {run.thread_ts ?? '—'}. Likely a synthetic test ts predating the backfill window, or the thread had no other messages.
          </div>
        ) : (
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
                  <span className="font-mono text-xs text-muted-foreground">[{hhmm}]</span>{' '}
                  <span className="text-xs text-muted-foreground">{m.author_type}</span>{' '}
                  <span className="font-medium">{author}:</span>{' '}
                  <span>{m.text}</span>
                  {m.is_trigger ? <span className="ml-1 text-xs uppercase tracking-wide text-amber-700">← trigger</span> : null}
                </div>
              )
            })}
          </div>
        )}
      </Section>

      <Section title="Ella's response">
        {clientFacing == null && run.output_summary == null ? (
          <div className="text-sm text-muted-foreground">No response found.</div>
        ) : (
          <div className="space-y-3 text-sm">
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                Client-facing (from `slack_messages`)
              </div>
              <pre className="whitespace-pre-wrap rounded bg-zinc-50 p-3 font-sans">
                {clientFacing ?? <span className="text-muted-foreground">(no slack_messages match — falling back to output_summary below)</span>}
              </pre>
            </div>
            {handoff ? (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-rose-700">
                  Captured handoff (stripped before posting)
                </div>
                <pre className="whitespace-pre-wrap rounded bg-rose-50 p-3 font-sans">{handoff}</pre>
              </div>
            ) : null}
            {clientFacing == null && run.output_summary ? (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                  output_summary (200-char limit)
                </div>
                <pre className="whitespace-pre-wrap rounded bg-zinc-50 p-3 font-sans">{run.output_summary}</pre>
              </div>
            ) : null}
          </div>
        )}
        {run.error_message ? (
          <div className="mt-3">
            <div className="mb-1 text-xs uppercase tracking-wide text-rose-700">Error message</div>
            <pre className="whitespace-pre-wrap rounded bg-rose-50 p-3 font-mono text-xs">{run.error_message}</pre>
          </div>
        ) : null}
      </Section>

      <Section title="Haiku decision">
        <div className="text-sm text-muted-foreground">
          N/A — pre-passive-monitoring run. (Haiku decision lands once Batch 2.3 ships.)
        </div>
      </Section>

      {run.escalation ? (
        <Section title="Escalation">
          <KeyValue label="Reason" value={<code className="text-xs">{run.escalation.reason}</code>} />
          <KeyValue label="Status" value={run.escalation.status} />
          {run.escalation.handoff_reasoning ? (
            <KeyValue
              label="Handoff reasoning"
              value={<div className="whitespace-pre-wrap text-sm">{run.escalation.handoff_reasoning}</div>}
            />
          ) : null}
          {run.escalation.resolution_note ? (
            <KeyValue label="Resolution note" value={run.escalation.resolution_note} />
          ) : null}
          <KeyValue
            label="Resolved at"
            value={run.escalation.resolved_at ?? <span className="text-muted-foreground">pending</span>}
          />
        </Section>
      ) : null}

      <Section title="Trigger metadata">
        <pre className="overflow-x-auto rounded bg-zinc-50 p-3 font-mono text-xs">
          {JSON.stringify(run.trigger_metadata, null, 2)}
        </pre>
      </Section>
    </div>
  )
}
