'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from '@/components/ui/dialog'
import type { DigestFlag } from '@/lib/db/fulfillment-dashboard'
import { CSM_STANDING_OPTIONS } from '@/lib/client-vocab'
import { dashboardSetCsmStandingAction } from './actions'
import { FlagTaskPill } from './flag-task-pill'

const CATEGORY_META: Record<
  string,
  { label: string; tone: 'neg' | 'warn' | 'neutral' }
> = {
  money_commitment: { label: 'Money', tone: 'neg' },
  complaint: { label: 'Complaint', tone: 'neg' },
  emotional_human_needed: { label: 'Emotional', tone: 'warn' },
  serious_uncertainty: { label: 'Uncertainty', tone: 'warn' },
  other: { label: 'Other', tone: 'neutral' },
}

function meta(category: string | null) {
  return (
    CATEGORY_META[category ?? 'other'] ?? {
      label: 'Other',
      tone: 'neutral' as const,
    }
  )
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso))
}

// Daily-digest list. Each row opens a detail modal showing the full Slack
// message with an inline CSM-standing control.
export function DigestList({ flags }: { flags: DigestFlag[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const active = flags.find((f) => f.id === openId) ?? null

  return (
    <>
      <div style={{ maxHeight: 300, overflowY: 'auto' }}>
        {flags.map((f) => {
          const m = meta(f.category)
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setOpenId(f.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                width: '100%',
                padding: '11px 2px',
                borderBottom: '1px solid var(--color-geg-border)',
                background: 'transparent',
                border: 'none',
                borderBottomWidth: 1,
                borderBottomStyle: 'solid',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}
              >
                <FlagTaskPill label={m.label} tone={m.tone} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: 'var(--color-geg-text)' }}>
                    {f.client_name ?? '—'}
                  </div>
                  <div
                    className="geg-mono"
                    style={{
                      marginTop: 3,
                      fontSize: 11,
                      color: 'var(--color-geg-text-faint)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {f.message ?? ''}
                  </div>
                </div>
              </div>
              <span
                className="geg-mono"
                style={{
                  fontSize: 11,
                  color: 'var(--color-geg-text-2)',
                  letterSpacing: '0.04em',
                  flexShrink: 0,
                }}
              >
                {formatDate(f.occurred_at)}
              </span>
            </button>
          )
        })}
      </div>

      <DigestModal
        flag={active}
        onClose={() => setOpenId(null)}
      />
    </>
  )
}

function DigestModal({
  flag,
  onClose,
}: {
  flag: DigestFlag | null
  onClose: () => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (!flag) return null
  const m = meta(flag.category)

  function setStanding(value: string) {
    if (!flag?.client_id) return
    setError(null)
    startTransition(async () => {
      const r = await dashboardSetCsmStandingAction(
        flag.client_id as string,
        value as 'happy' | 'content' | 'at_risk' | 'problem',
      )
      if (r.success) router.refresh()
      else setError(r.error)
    })
  }

  return (
    <Dialog open={!!flag} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <FlagTaskPill label={m.label} tone={m.tone} />
          {flag.client_id && flag.client_name ? (
            <Link
              href={`/clients/${flag.client_id}`}
              style={{
                fontSize: 16,
                color: 'var(--color-geg-text)',
                textDecoration: 'underline',
              }}
            >
              {flag.client_name}
            </Link>
          ) : (
            <span style={{ fontSize: 16, color: 'var(--color-geg-text)' }}>
              {flag.client_name ?? '—'}
            </span>
          )}
          <span
            className="geg-mono"
            style={{
              marginLeft: 'auto',
              fontSize: 11,
              color: 'var(--color-geg-text-2)',
            }}
          >
            {formatDate(flag.occurred_at)}
          </span>
        </div>

        <div
          style={{
            marginTop: 14,
            padding: '14px 16px',
            background: 'var(--color-geg-bg)',
            border: '1px solid var(--color-geg-border)',
            borderRadius: 8,
            fontSize: 14,
            lineHeight: 1.5,
            color: 'var(--color-geg-text)',
            whiteSpace: 'pre-wrap',
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {flag.message || '(no message text)'}
        </div>

        {flag.client_id ? (
          <div
            style={{
              marginTop: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
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
              CSM standing
            </span>
            <select
              value={flag.csm_standing ?? ''}
              onChange={(e) => setStanding(e.target.value)}
              disabled={isPending}
              className="geg-mono"
              style={{
                fontSize: 12,
                padding: '4px 8px',
                borderRadius: 6,
                border: '1px solid var(--color-geg-border-strong)',
                background: 'var(--color-geg-bg-elev)',
                color: 'var(--color-geg-text)',
                cursor: 'pointer',
              }}
            >
              <option value="" disabled>
                Set…
              </option>
              {CSM_STANDING_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {error ? (
              <span className="text-sm text-rose-700">Error: {error}</span>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
