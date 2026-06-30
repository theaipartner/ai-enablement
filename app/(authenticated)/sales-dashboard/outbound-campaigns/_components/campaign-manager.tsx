'use client'

import { useState, useTransition } from 'react'

import type { AdminOutboundCampaign } from '@/lib/db/outbound-campaigns'
import {
  saveCampaign,
  setCampaignActive,
  deleteCampaign,
  refreshCampaign,
  type CampaignInput,
} from '../actions'

// Outbound Campaigns manager. A list of cards — one per campaign — plus an "Add
// campaign" form. New-model campaigns (a custom-field name + exact value) are
// editable + deletable + re-taggable; the two finished legacy pools (Revival,
// Jacob) render read-only (locked).

const card = {
  border: '1px solid var(--color-geg-border)',
  borderRadius: 8,
  padding: '16px 18px',
  background: 'var(--color-geg-bg-elev)',
} as const

const label = {
  fontSize: 11,
  letterSpacing: '0.05em',
  textTransform: 'uppercase' as const,
  color: 'var(--color-geg-text-faint)',
  marginBottom: 4,
  display: 'block',
}

const input = {
  width: '100%',
  fontSize: 13.5,
  color: 'var(--color-geg-text)',
  background: 'var(--color-geg-bg)',
  border: '1px solid var(--color-geg-border-strong)',
  borderRadius: 6,
  padding: '7px 10px',
} as const

const btn = (kind: 'primary' | 'ghost' | 'danger') =>
  ({
    fontSize: 12.5,
    fontWeight: 600,
    borderRadius: 6,
    padding: '7px 14px',
    cursor: 'pointer',
    border: '1px solid var(--color-geg-border-strong)',
    background:
      kind === 'primary'
        ? 'var(--color-geg-accent)'
        : kind === 'danger'
          ? 'transparent'
          : 'transparent',
    color:
      kind === 'primary'
        ? '#fff'
        : kind === 'danger'
          ? 'var(--color-geg-danger, #c0392b)'
          : 'var(--color-geg-text)',
  }) as const

function todayEt(): string {
  // YYYY-MM-DD in ET, for the start-date default.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  return parts
}

export function CampaignManager({
  campaigns,
  fieldSuggestions,
}: {
  campaigns: AdminOutboundCampaign[]
  fieldSuggestions: string[]
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <AddCard />
      {campaigns.map((c) => (
        <CampaignCard key={c.key} campaign={c} />
      ))}
      {/* One shared datalist; the add/edit inputs reference it by id. */}
      <datalist id="match-field-names">
        {fieldSuggestions.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </div>
  )
}

function FieldRow({
  label: lbl,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div style={{ flex: 1, minWidth: 160 }}>
      <span style={label}>{lbl}</span>
      {children}
    </div>
  )
}

function AddCard() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [field, setField] = useState('')
  const [value, setValue] = useState('')
  const [startDate, setStartDate] = useState(todayEt())
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)

  function submit() {
    setMsg(null)
    startTransition(async () => {
      const res = await saveCampaign({
        label: name,
        matchFieldName: field,
        matchValue: value,
        startDate,
        active: true,
      } satisfies CampaignInput)
      if (res.ok) {
        setName('')
        setField('')
        setValue('')
        setStartDate(todayEt())
        setOpen(false)
        setMsg(null)
      } else {
        setMsg(res.error)
      }
    })
  }

  if (!open) {
    return (
      <button style={btn('primary')} onClick={() => setOpen(true)}>
        + Add outbound campaign
      </button>
    )
  }

  return (
    <div style={{ ...card, borderColor: 'var(--color-geg-accent)' }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>New outbound campaign</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
        <FieldRow label="Campaign name">
          <input
            style={input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. June Reactivation"
          />
        </FieldRow>
        <FieldRow label="Start date (ET)">
          <input
            style={input}
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </FieldRow>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        <FieldRow label="Custom-field name (Close or GHL)">
          <input
            style={input}
            list="match-field-names"
            value={field}
            onChange={(e) => setField(e.target.value)}
            placeholder="e.g. Outbound Campaign"
          />
        </FieldRow>
        <FieldRow label="Exact value">
          <input
            style={input}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. June Reactivation"
          />
        </FieldRow>
      </div>
      {msg && (
        <div style={{ color: 'var(--color-geg-danger, #c0392b)', fontSize: 12.5, marginBottom: 10 }}>
          {msg}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btn('primary')} disabled={pending} onClick={submit}>
          {pending ? 'Adding…' : 'Add campaign'}
        </button>
        <button style={btn('ghost')} disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function CampaignCard({ campaign }: { campaign: AdminOutboundCampaign }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(campaign.label)
  const [field, setField] = useState(campaign.matchFieldName ?? '')
  const [value, setValue] = useState(campaign.matchValue ?? '')
  const [startDate, setStartDate] = useState(
    campaign.floorAt ? campaign.floorAt.slice(0, 10) : todayEt(),
  )
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)

  function run(fn: () => Promise<{ ok: boolean; error?: string; leadCount?: number }>, ok?: string) {
    setMsg(null)
    startTransition(async () => {
      const res = await fn()
      if (res.ok) {
        setEditing(false)
        setMsg(ok ?? null)
      } else {
        setMsg(res.error ?? 'failed')
      }
    })
  }

  const meta = (
    <div style={{ fontSize: 12, color: 'var(--color-geg-text-faint)', marginTop: 2 }}>
      <code>{campaign.key}</code> · {campaign.leadCount.toLocaleString()} leads ·{' '}
      {campaign.isActive ? 'active' : 'inactive'}
    </div>
  )

  // Legacy (Revival/Jacob) — read-only.
  if (campaign.isLegacy) {
    return (
      <div style={{ ...card, opacity: 0.85 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {campaign.label}{' '}
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  color: 'var(--color-geg-text-faint)',
                  border: '1px solid var(--color-geg-border)',
                  borderRadius: 4,
                  padding: '1px 6px',
                  marginLeft: 6,
                }}
              >
                Legacy · locked
              </span>
            </div>
            {meta}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={card}>
      {editing ? (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
            <FieldRow label="Campaign name">
              <input style={input} value={label} onChange={(e) => setLabel(e.target.value)} />
            </FieldRow>
            <FieldRow label="Start date (ET)">
              <input
                style={input}
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </FieldRow>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
            <FieldRow label="Custom-field name">
              <input
                style={input}
                list="match-field-names"
                value={field}
                onChange={(e) => setField(e.target.value)}
              />
            </FieldRow>
            <FieldRow label="Exact value">
              <input style={input} value={value} onChange={(e) => setValue(e.target.value)} />
            </FieldRow>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={btn('primary')}
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    saveCampaign({
                      key: campaign.key,
                      label,
                      matchFieldName: field,
                      matchValue: value,
                      startDate,
                      active: campaign.isActive,
                    }),
                  'Saved + re-tagged.',
                )
              }
            >
              {pending ? 'Saving…' : 'Save + re-tag'}
            </button>
            <button style={btn('ghost')} disabled={pending} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{campaign.label}</div>
            {meta}
            <div style={{ fontSize: 12.5, color: 'var(--color-geg-text-2)', marginTop: 6 }}>
              Field <code>{campaign.matchFieldName}</code> = <code>{campaign.matchValue}</code>
              {campaign.floorAt ? ` · from ${campaign.floorAt.slice(0, 10)}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button style={btn('ghost')} disabled={pending} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              style={btn('ghost')}
              disabled={pending}
              onClick={() => run(() => refreshCampaign(campaign.key), 'Re-tagged.')}
              title="Re-run the match (after changing the field/value)"
            >
              {pending ? '…' : 'Re-tag'}
            </button>
            <button
              style={btn('ghost')}
              disabled={pending}
              onClick={() => run(() => setCampaignActive(campaign.key, !campaign.isActive))}
            >
              {campaign.isActive ? 'Deactivate' : 'Activate'}
            </button>
            <button
              style={btn('danger')}
              disabled={pending}
              onClick={() => {
                if (confirm(`Delete campaign "${campaign.label}" and its facts?`)) {
                  run(() => deleteCampaign(campaign.key))
                }
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
      {msg && (
        <div style={{ fontSize: 12.5, marginTop: 10, color: 'var(--color-geg-text-2)' }}>{msg}</div>
      )}
    </div>
  )
}
