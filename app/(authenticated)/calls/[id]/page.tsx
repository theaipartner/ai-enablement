import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getCallById, type CallDetail } from '@/lib/db/calls'
import { listMergeCandidates } from '@/lib/db/merge'
import { Separator } from '@/components/ui/separator'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ClassificationEdit } from './classification-edit'
import { TranscriptSection } from './transcript-section'

function SectionHeader({ title }: { title: string }) {
  return <h2 className="text-lg font-semibold">{title}</h2>
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  const mm = Math.floor(seconds / 60)
  const ss = seconds % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

function ParticipantsTable({
  participants,
}: {
  participants: CallDetail['participants']
}) {
  if (participants.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No participants recorded.</p>
    )
  }
  return (
    <div className="border rounded-md overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Matched</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {participants.map((p) => {
            const matched = p.matched_client_name || p.matched_team_member_name
            const matchedKind = p.client_id
              ? 'client'
              : p.team_member_id
                ? 'team'
                : null
            return (
              <TableRow key={p.id}>
                <TableCell className="text-sm">
                  {p.display_name ?? <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-sm font-mono">{p.email}</TableCell>
                <TableCell className="text-sm text-muted-foreground capitalize">
                  {p.participant_role ?? '—'}
                </TableCell>
                <TableCell className="text-sm">
                  {matched ? (
                    <span>
                      <span className="text-xs text-muted-foreground mr-1">
                        {matchedKind}:
                      </span>
                      {p.client_id ? (
                        <Link
                          href={`/clients/${p.client_id}`}
                          className="hover:underline underline-offset-4"
                        >
                          {matched}
                        </Link>
                      ) : (
                        <span>{matched}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-amber-700 text-xs">unmatched</span>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function CallReviewSection({
  review,
}: {
  review: CallDetail['call_review']
}) {
  if (review === null) {
    return (
      <p className="text-sm text-muted-foreground">No review for this call yet.</p>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold mb-1">Sentiment arc</h3>
        <p className="text-sm leading-relaxed">{review.sentiment_arc}</p>
      </div>

      <ReviewItemList
        title="Pain points"
        items={review.pain_points}
        emptyText="No pain points surfaced."
      />

      <ReviewItemList
        title="Wins"
        items={review.wins}
        emptyText="No wins surfaced."
      />

      <ReviewPivotsList items={review.dodged_questions} />
    </div>
  )
}

function ReviewItemList({
  title,
  items,
  emptyText,
}: {
  title: string
  items: Array<{ description: string; evidence: string }>
  emptyText: string
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold mb-1.5 flex items-center gap-2">
        <span>{title}</span>
        {items.length > 0 ? (
          <span className="text-xs font-medium text-muted-foreground tabular-nums">
            {items.length}
          </span>
        ) : null}
      </h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="space-y-2.5">
          {items.map((item, idx) => (
            <li key={idx} className="text-sm">
              <p className="font-medium">{item.description}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {item.evidence}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ReviewPivotsList({
  items,
}: {
  items: Array<{ description: string; evidence: string; who: string }>
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold mb-1.5 flex items-center gap-2">
        <span>Conversation pivots</span>
        {items.length > 0 ? (
          <span className="text-xs font-medium text-muted-foreground tabular-nums">
            {items.length}
          </span>
        ) : null}
      </h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">No notable pivots surfaced.</p>
      ) : (
        <ul className="space-y-2.5">
          {items.map((item, idx) => (
            <li key={idx} className="text-sm">
              <div className="flex items-start gap-2">
                <span
                  className={
                    'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ' +
                    (item.who === 'csm'
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-slate-100 text-slate-700')
                  }
                >
                  {item.who}
                </span>
                <p className="font-medium flex-1">{item.description}</p>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 ml-[3.25rem]">
                {item.evidence}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ActionItemsList({
  items,
}: {
  items: CallDetail['action_items']
}) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No action items extracted from this call.
      </p>
    )
  }
  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const ownerLabel = item.owner_client_name
          ? `client: ${item.owner_client_name}`
          : item.owner_team_member_name
            ? `team: ${item.owner_team_member_name}`
            : item.owner_type
        return (
          <li key={item.id} className="text-sm">
            <div className="flex items-start gap-3">
              <span className="flex-1">{item.description}</span>
              {item.due_date ? (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {new Date(item.due_date).toLocaleDateString()}
                </span>
              ) : null}
              <span
                className={
                  item.status === 'open'
                    ? 'text-xs text-amber-700'
                    : item.status === 'done'
                      ? 'text-xs text-emerald-700'
                      : 'text-xs text-muted-foreground'
                }
              >
                {item.status}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">Owner: {ownerLabel}</p>
          </li>
        )
      })}
    </ul>
  )
}

export default async function CallDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const call = await getCallById(params.id)
  if (!call) notFound()

  // Reuse the merge-candidate fetch shape — exclude arg is a meaningless
  // placeholder UUID so the function returns every active client.
  const clientOptions = await listMergeCandidates(
    '00000000-0000-0000-0000-000000000000',
  )

  return (
    <div className="px-8 py-8 max-w-4xl mx-auto space-y-6">
      <Link
        href="/calls"
        className="geg-eyebrow hover:underline"
        style={{ color: 'var(--color-geg-text-3)' }}
      >
        ← BACK TO CALLS
      </Link>

      <header
        className="space-y-2"
        style={{
          paddingBottom: 24,
          borderBottom: '1px solid var(--color-geg-border-strong)',
        }}
      >
        <div className="geg-eyebrow">CALL · DETAIL</div>
        <h1
          className="geg-display"
          style={{ fontSize: 40, lineHeight: '44px' }}
        >
          {call.title ?? 'Untitled call'}
        </h1>
        <div className="geg-eyebrow geg-numeric pt-1">
          {new Date(call.started_at).toLocaleString()} ·{' '}
          {formatDuration(call.duration_seconds)}
        </div>
      </header>


      {/* Section 1 — Metadata */}
      <section className="space-y-3">
        <SectionHeader title="Metadata" />
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Started at</Label>
            <p>{new Date(call.started_at).toLocaleString()}</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Duration</Label>
            <p className="tabular-nums">{formatDuration(call.duration_seconds)}</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Source</Label>
            <p>{call.source}</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">External id</Label>
            <p className="font-mono text-xs break-all">{call.external_id}</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Ingested at</Label>
            <p>{new Date(call.ingested_at).toLocaleString()}</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Recording</Label>
            <p>
              {call.recording_url ? (
                <a
                  href={call.recording_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sky-700 hover:underline underline-offset-4"
                >
                  Open in source
                </a>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </p>
          </div>
        </div>
      </section>

      <Separator />

      {/* Section 2 — Classification (editable) */}
      <section className="space-y-3">
        <SectionHeader title="Classification" />
        <ClassificationEdit
          call={{
            id: call.id,
            call_category: call.call_category,
            call_type: call.call_type,
            primary_client_id: call.primary_client_id,
            primary_client: call.primary_client,
            classification_confidence: call.classification_confidence,
            classification_method: call.classification_method,
            is_retrievable_by_client_agents: call.is_retrievable_by_client_agents,
          }}
          clientOptions={clientOptions}
        />
      </section>

      <Separator />

      {/* Section 3 — Participants */}
      <section className="space-y-3">
        <SectionHeader title="Participants" />
        <ParticipantsTable participants={call.participants} />
      </section>

      <Separator />

      {/* Section 4 — Summary */}
      <section className="space-y-3">
        <SectionHeader title="Summary" />
        {call.summary_text ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm leading-relaxed font-sans">
            {call.summary_text}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">
            No summary for this call. Cron-ingested calls have summaries; older
            backlog imports (Fathom .txt exports) do not.
          </p>
        )}
      </section>

      <Separator />

      {/* Section 4.5 — Call review */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <SectionHeader title="Call review" />
          {call.call_review ? (
            <span className="text-xs text-muted-foreground">
              Generated {new Date(call.call_review.generated_at).toLocaleString()}
            </span>
          ) : null}
        </div>
        <CallReviewSection review={call.call_review} />
      </section>

      <Separator />

      {/* Section 5 — Action items */}
      <section className="space-y-3">
        <SectionHeader title="Action items" />
        <ActionItemsList items={call.action_items} />
      </section>

      <Separator />

      {/* Section 6 — Transcript */}
      <section className="space-y-3">
        <SectionHeader title="Transcript" />
        <TranscriptSection transcript={call.transcript} />
      </section>
    </div>
  )
}
