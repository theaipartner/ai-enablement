'use client'

// Section 2 — Lifecycle & Standing.
//
// journey_stage / csm_standing edits go through history-writing RPC
// actions (see lib/db/clients.ts updateClientJourneyStageWithHistory /
// updateClientCsmStandingWithHistory and migration 0018). archetype is
// a plain whitelisted column.
//
// NPS Standing is read-only display of clients.nps_standing — populated
// by the Airtable webhook receiver (M5.4 Path 1) and a one-shot
// historical backfill. Distinct from latest_nps (nps_submissions.score)
// which is empty in V1 because score-piping is deferred. The
// "Add NPS score" button below opens NpsEntryForm which writes
// nps_submissions; both surfaces stay because they cover different
// data sources.
//
// HealthScoreIndicator and ConcernsBlock preserve the rendering from
// B1 — locked against the client_health_scores.factors jsonb shape.
// Concerns has three distinct empty states (no health row → "not yet
// evaluated"; health exists, empty concerns → "no concerns currently
// surfaced"; non-empty → list).

import Link from 'next/link'
import type { ClientDetail } from '@/lib/db/clients'
import {
  CSM_STANDING_OPTIONS,
  JOURNEY_STAGE_OPTIONS,
} from '@/lib/client-vocab'
import { Section, Subsection } from './section'
import { EditableField } from './editable-field'
import { NpsEntryForm } from './nps-entry-form'
import { NpsStandingPill } from './nps-standing-pill'
import {
  updateClientCsmStandingAction,
  updateClientField,
  updateClientJourneyStageAction,
} from '@/app/(authenticated)/clients/[id]/actions'

type ConcernShape = {
  text: string
  severity?: 'low' | 'medium' | 'high'
  source_call_ids?: string[]
}

function HealthScoreIndicator({
  health,
}: {
  health: ClientDetail['latest_health']
}) {
  if (!health) {
    return (
      <p className="text-sm text-muted-foreground">
        No score yet — Gregory writes scores on the weekly cron run; new
        clients land here after their first sweep.
      </p>
    )
  }
  const tierCls =
    health.tier === 'green'
      ? 'bg-emerald-100 text-emerald-900'
      : health.tier === 'yellow'
        ? 'bg-amber-100 text-amber-900'
        : 'bg-rose-100 text-rose-900'
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-3xl font-semibold">{health.score}</span>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tierCls}`}
        >
          {health.tier}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Last computed {new Date(health.computed_at).toLocaleString()}
      </p>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Why this score
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted/50 p-2 text-xs">
          {JSON.stringify(health.factors, null, 2)}
        </pre>
      </details>
    </div>
  )
}

function ConcernsBlock({ health }: { health: ClientDetail['latest_health'] }) {
  if (!health) {
    return (
      <p className="text-sm text-muted-foreground">
        Gregory has not yet evaluated this client.
      </p>
    )
  }
  const factorsObj =
    typeof health.factors === 'object' && health.factors
      ? (health.factors as { concerns?: ConcernShape[] })
      : null
  const concerns = factorsObj?.concerns ?? []

  if (concerns.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No concerns currently surfaced.
      </p>
    )
  }

  return (
    <ul className="space-y-2 text-sm">
      {concerns.map((concern, idx) => {
        const sevCls =
          concern.severity === 'high'
            ? 'bg-rose-100 text-rose-900'
            : concern.severity === 'medium'
              ? 'bg-amber-100 text-amber-900'
              : 'bg-zinc-100 text-zinc-700'
        return (
          <li key={idx} className="space-y-1">
            <div className="flex items-start gap-2">
              {concern.severity ? (
                <span
                  className={`shrink-0 rounded-full border px-1.5 py-0.5 text-xs ${sevCls}`}
                >
                  {concern.severity}
                </span>
              ) : null}
              <span>{concern.text}</span>
            </div>
            {concern.source_call_ids && concern.source_call_ids.length > 0 ? (
              <div className="text-xs text-muted-foreground pl-1">
                Source:{' '}
                {concern.source_call_ids.map((callId, i) => (
                  <span key={callId}>
                    <Link
                      href={`/calls/${callId}`}
                      className="hover:underline underline-offset-4"
                    >
                      call {i + 1}
                    </Link>
                    {i < (concern.source_call_ids?.length ?? 0) - 1 ? ', ' : ''}
                  </span>
                ))}
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

export function LifecycleSection({ client }: { client: ClientDetail }) {
  return (
    <Section title="Lifecycle & Standing">
      <div className="grid grid-cols-2 gap-4">
        <EditableField
          label="Journey stage"
          value={client.journey_stage}
          variant="enum"
          options={JOURNEY_STAGE_OPTIONS}
          onSave={(v) =>
            updateClientJourneyStageAction(
              client.id,
              v as string | null,
              null,
            )
          }
        />
        <EditableField
          label="CSM standing"
          value={client.csm_standing}
          variant="enum"
          options={CSM_STANDING_OPTIONS}
          onSave={(v) =>
            updateClientCsmStandingAction(
              client.id,
              v as 'happy' | 'content' | 'at_risk' | 'problem' | null,
              null,
            )
          }
        />

        <div>
          <div className="space-y-1">
            <div className="text-sm font-medium text-muted-foreground">
              NPS Standing
            </div>
            <NpsStandingPill value={client.nps_standing} />
          </div>
          <div className="mt-2">
            <NpsEntryForm clientId={client.id} />
          </div>
        </div>
        <EditableField
          label="Archetype"
          value={client.archetype}
          variant="text"
          onSave={(v) =>
            updateClientField(client.id, 'archetype', v as string | null)
          }
        />
      </div>

      <div className="space-y-2 pt-2">
        <h3 className="text-sm font-medium text-muted-foreground">Health score</h3>
        <HealthScoreIndicator health={client.latest_health} />
      </div>

      <Subsection title="Concerns">
        <ConcernsBlock health={client.latest_health} />
      </Subsection>
    </Section>
  )
}
