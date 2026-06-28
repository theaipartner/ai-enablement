'use client'

import { useEffect, useState, useTransition } from 'react'

import type {
  LandingPage,
  WistiaVideoOption,
  TypeformOption,
  TypeformField,
} from '@/lib/db/landing-pages-shared'
import {
  discoverFromUrl,
  loadTypeformFields,
  saveLandingPage,
  deleteLandingPage,
  setLandingPageActive,
  retagLandingPage,
  type LpInput,
} from '../actions'

// Landing Pages admin manager: a list of registered LPs + an editor for
// add/edit. The editor: paste link → Discover (auto-fills videos + Typeform) →
// pick qualification question + qualifying answers → Save.

type EditorState = {
  slug: string | null // null = creating
  url: string
  label: string
  lpPath: string
  typeformLabel: string
  active: boolean
  vslHashedIds: string[]
  confirmVideoHashedId: string
  formId: string
  qualifyFieldRef: string
  qualifyAnswers: string[]
}

function blankEditor(): EditorState {
  return {
    slug: null,
    url: '',
    label: '',
    lpPath: '',
    typeformLabel: '',
    active: true,
    vslHashedIds: [''],
    confirmVideoHashedId: '',
    formId: '',
    qualifyFieldRef: '',
    qualifyAnswers: [],
  }
}

function editorFromLp(lp: LandingPage): EditorState {
  const primary = lp.forms.find((f) => f.isPrimary) ?? lp.forms[0]
  return {
    slug: lp.slug,
    url: lp.lpUrl,
    label: lp.label,
    lpPath: lp.lpPath,
    typeformLabel: lp.typeformLabel,
    active: lp.active,
    vslHashedIds: lp.vsl.length ? lp.vsl.map((v) => v.hashedId) : [''],
    confirmVideoHashedId: lp.confirmVideoHashedId,
    formId: primary?.formId ?? '',
    qualifyFieldRef: primary?.qualifyFieldRef ?? '',
    qualifyAnswers: primary?.qualifyAnswers ?? [],
  }
}

export function LpManager({
  landingPages,
  wistia,
  typeforms,
}: {
  landingPages: LandingPage[]
  wistia: WistiaVideoOption[]
  typeforms: TypeformOption[]
}) {
  const [editor, setEditor] = useState<EditorState | null>(null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {editor ? (
        <LpEditor
          key={editor.slug ?? '__new__'}
          state={editor}
          wistia={wistia}
          typeforms={typeforms}
          onClose={() => setEditor(null)}
        />
      ) : (
        <button type="button" onClick={() => setEditor(blankEditor())} style={primaryBtn(false)}>
          + Add landing page
        </button>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {landingPages.map((lp) => (
          <LpRow key={lp.slug} lp={lp} onEdit={() => setEditor(editorFromLp(lp))} />
        ))}
      </div>
    </div>
  )
}

function LpRow({ lp, onEdit }: { lp: LandingPage; onEdit: () => void }) {
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)

  const onToggle = () =>
    startTransition(async () => {
      const res = await setLandingPageActive(lp.slug, !lp.active)
      if (!res.ok) setMsg(`Error: ${res.error}`)
    })
  const onDelete = () => {
    if (!window.confirm(`Delete landing page "${lp.label}"? Only allowed if it has no leads yet.`))
      return
    startTransition(async () => {
      const res = await deleteLandingPage(lp.slug)
      if (!res.ok)
        setMsg(
          res.error === 'has_cycles_deactivate_instead'
            ? 'Has leads — deactivate instead of deleting.'
            : `Error: ${res.error}`,
        )
    })
  }
  const onRetag = () => {
    if (!window.confirm('Retag now? Backfills leads that opted in through this page BEFORE it was registered. (Future leads are attributed automatically.)'))
      return
    setMsg('Retagging…')
    startTransition(async () => {
      const res = await retagLandingPage(lp.slug)
      setMsg(res.ok ? `Retagged ${res.leadCount} lead(s).` : `Error: ${res.error}`)
    })
  }

  return (
    <div
      style={{
        border: '1px solid var(--color-geg-border)',
        background: 'var(--color-geg-bg-elev)',
        borderRadius: 8,
        padding: '14px 18px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        opacity: lp.active ? 1 : 0.55,
      }}
    >
      <div>
        <div className="geg-serif" style={{ fontSize: 16, color: 'var(--color-geg-text)' }}>
          {lp.label} {lp.active ? '' : '· (inactive)'}
        </div>
        <div className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', marginTop: 3 }}>
          ?lp={lp.slug} · forms: {lp.forms.map((f) => f.formId).join(', ') || '—'}
          {lp.vsl.length ? ` · ${lp.vsl.length} VSL` : ''}
        </div>
        {msg ? (
          <div className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-danger, #c0392b)', marginTop: 4 }}>{msg}</div>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={onEdit} disabled={pending} style={secondaryBtn(pending)}>Edit</button>
        <button type="button" onClick={onRetag} disabled={pending} style={secondaryBtn(pending)}>Retag now</button>
        <button type="button" onClick={onToggle} disabled={pending} style={secondaryBtn(pending)}>
          {lp.active ? 'Deactivate' : 'Activate'}
        </button>
        <button type="button" onClick={onDelete} disabled={pending} style={dangerBtn(pending)}>Delete</button>
      </div>
    </div>
  )
}

function LpEditor({
  state,
  wistia,
  typeforms,
  onClose,
}: {
  state: EditorState
  wistia: WistiaVideoOption[]
  typeforms: TypeformOption[]
  onClose: () => void
}) {
  const [s, setS] = useState<EditorState>(state)
  const [fields, setFields] = useState<TypeformField[]>([])
  const [pending, startTransition] = useTransition()
  const [discovering, startDiscover] = useTransition()
  const [loadingFields, startFields] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const isEdit = s.slug !== null

  const set = (patch: Partial<EditorState>) => setS((p) => ({ ...p, ...patch }))
  const wistiaName = (id: string) => wistia.find((w) => w.hashedId === id)?.name ?? 'VSL'

  // Load a form's fields and default the qualification question + answers.
  const selectForm = (formId: string, keepQual = false) => {
    set({ formId })
    if (!formId) {
      setFields([])
      return
    }
    startFields(async () => {
      const fs = await loadTypeformFields(formId)
      setFields(fs)
      if (keepQual) return
      const withChoices = fs.filter((f) => f.choices.length)
      // Default to a field whose ref matches the existing config, else first with choices.
      const guess = withChoices.find((f) => f.ref === s.qualifyFieldRef) ?? withChoices[0]
      if (guess) {
        const qualifying = guess.choices
          .map((c) => c.label)
          .filter((l) => !/^under\b/i.test(l)) // default: everything except "Under …"
        set({ qualifyFieldRef: guess.ref, qualifyAnswers: qualifying })
      }
    })
  }

  const onDiscover = () => {
    setMsg(null)
    startDiscover(async () => {
      const res = await discoverFromUrl(s.url)
      if (!res.ok) {
        setMsg(`Discovery: ${res.error ?? 'nothing found'} — fill in manually.`)
        return
      }
      const patch: Partial<EditorState> = {}
      if (res.vslCandidates.length) patch.vslHashedIds = res.vslCandidates.map((v) => v.hashedId)
      setS((p) => ({ ...p, ...patch }))
      if (res.typeformGuessId) selectForm(res.typeformGuessId)
      setMsg(
        `Found ${res.vslCandidates.length} video(s)` +
          (res.typeformGuessId ? ` · Typeform ${res.typeformGuessId}` : ' · no Typeform — pick one'),
      )
    })
  }

  // On mount, if editing an LP that already has a form, load its questions so
  // the qualification checkboxes render (config is already pre-filled).
  useEffect(() => {
    if (s.slug !== null && s.formId) {
      startFields(async () => setFields(await loadTypeformFields(s.formId)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onSave = () => {
    if (!s.label.trim()) return setMsg('Label is required.')
    if (!s.formId) return setMsg('Pick a Typeform (the attribution key).')
    const input: LpInput = {
      slug: s.slug ?? undefined,
      label: s.label.trim(),
      lpUrl: s.url || null,
      lpPath: s.lpPath || null,
      typeformLabel: s.typeformLabel || null,
      vsl: s.vslHashedIds.filter(Boolean).map((id) => ({ hashedId: id, label: wistiaName(id) })),
      confirmVideoHashedId: s.confirmVideoHashedId || null,
      confirmVideoLabel: s.confirmVideoHashedId ? wistiaName(s.confirmVideoHashedId) : null,
      active: s.active,
      form: {
        formId: s.formId,
        typeformTitle: typeforms.find((t) => t.formId === s.formId)?.title ?? null,
        qualifyFieldRef: s.qualifyFieldRef || null,
        qualifyAnswers: s.qualifyAnswers,
      },
    }
    startTransition(async () => {
      const res = await saveLandingPage(input)
      if (!res.ok) {
        setMsg(
          res.error.startsWith('typeform_already_used_by:')
            ? `That Typeform already belongs to "${res.error.split(':')[1]}".`
            : `Error: ${res.error}`,
        )
        return
      }
      onClose()
    })
  }

  const qualField = fields.find((f) => f.ref === s.qualifyFieldRef)

  return (
    <div style={{ border: '1px solid var(--color-geg-accent)', background: 'var(--color-geg-bg-elev)', borderRadius: 8, padding: '20px 22px' }}>
      <div className="geg-serif" style={{ fontSize: 18, marginBottom: 16, color: 'var(--color-geg-text)' }}>
        {isEdit ? `Edit · ${s.label}` : 'Add landing page'}
      </div>

      {/* Discover row */}
      <Field label="Landing page link">
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={inputStyle} value={s.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://join.theaipartner.io/…" />
          <button type="button" onClick={onDiscover} disabled={discovering || !s.url.trim()} style={secondaryBtn(discovering)}>
            {discovering ? 'Discovering…' : 'Discover'}
          </button>
        </div>
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, marginTop: 14 }}>
        <Field label="Label (shown in dropdown)">
          <input style={inputStyle} value={s.label} onChange={(e) => set({ label: e.target.value })} placeholder="e.g. VSL-B test · /lp-vsl-b" />
        </Field>
        <Field label="LP path (optional)">
          <input style={inputStyle} value={s.lpPath} onChange={(e) => set({ lpPath: e.target.value })} placeholder="/lp-vsl-b" />
        </Field>

        <Field label="Typeform (attribution key)">
          <select style={inputStyle} value={s.formId} onChange={(e) => selectForm(e.target.value)}>
            <option value="">— pick a form —</option>
            {typeforms.map((t) => (
              <option key={t.formId} value={t.formId}>{t.title} · {t.formId}</option>
            ))}
          </select>
        </Field>
        <Field label="Typeform subtitle (optional)">
          <input style={inputStyle} value={s.typeformLabel} onChange={(e) => set({ typeformLabel: e.target.value })} placeholder="e.g. 6/20 Longer Form" />
        </Field>
      </div>

      {/* VSLs */}
      <div style={{ marginTop: 16 }}>
        <FieldLabel>VSL video(s)</FieldLabel>
        {s.vslHashedIds.map((id, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <select style={inputStyle} value={wistia.some((w) => w.hashedId === id) ? id : ''} onChange={(e) => {
              const next = [...s.vslHashedIds]; next[i] = e.target.value; set({ vslHashedIds: next })
            }}>
              <option value="">— choose from Wistia —</option>
              {wistia.map((w) => (<option key={w.hashedId} value={w.hashedId}>{w.name} · {w.hashedId}</option>))}
            </select>
            <input style={{ ...inputStyle, maxWidth: 180 }} value={id} onChange={(e) => {
              const next = [...s.vslHashedIds]; next[i] = e.target.value; set({ vslHashedIds: next })
            }} placeholder="or paste hashed_id" className="geg-mono" />
            <button type="button" onClick={() => set({ vslHashedIds: s.vslHashedIds.filter((_, j) => j !== i) })} style={dangerBtn(false)}>×</button>
          </div>
        ))}
        <button type="button" onClick={() => set({ vslHashedIds: [...s.vslHashedIds, ''] })} style={secondaryBtn(false)}>+ VSL</button>
      </div>

      {/* Confirm video */}
      <div style={{ marginTop: 16 }}>
        <Field label="Thank-you / confirmation video (optional)">
          <div style={{ display: 'flex', gap: 8 }}>
            <select style={inputStyle} value={wistia.some((w) => w.hashedId === s.confirmVideoHashedId) ? s.confirmVideoHashedId : ''} onChange={(e) => set({ confirmVideoHashedId: e.target.value })}>
              <option value="">— choose from Wistia —</option>
              {wistia.map((w) => (<option key={w.hashedId} value={w.hashedId}>{w.name} · {w.hashedId}</option>))}
            </select>
            <input style={{ ...inputStyle, maxWidth: 180 }} value={s.confirmVideoHashedId} onChange={(e) => set({ confirmVideoHashedId: e.target.value })} placeholder="or paste hashed_id" className="geg-mono" />
          </div>
        </Field>
      </div>

      {/* Qualification */}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--color-geg-border)' }}>
        <FieldLabel>Qualification — what answer qualifies a lead</FieldLabel>
        {loadingFields ? (
          <div className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)' }}>Loading form questions…</div>
        ) : !s.formId ? (
          <div className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)' }}>Pick a Typeform first.</div>
        ) : (
          <>
            <select style={{ ...inputStyle, marginBottom: 10 }} value={s.qualifyFieldRef} onChange={(e) => {
              const f = fields.find((x) => x.ref === e.target.value)
              set({ qualifyFieldRef: e.target.value, qualifyAnswers: f ? f.choices.map((c) => c.label).filter((l) => !/^under\b/i.test(l)) : [] })
            }}>
              <option value="">— pick the qualification question —</option>
              {fields.filter((f) => f.choices.length).map((f) => (
                <option key={f.ref} value={f.ref}>{f.title.slice(0, 70)}</option>
              ))}
            </select>
            {qualField ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {qualField.choices.map((c) => (
                  <label key={c.label} className="geg-mono" style={{ fontSize: 12, color: 'var(--color-geg-text-2)', display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="checkbox" checked={s.qualifyAnswers.includes(c.label)} onChange={(e) => {
                      set({ qualifyAnswers: e.target.checked ? [...s.qualifyAnswers, c.label] : s.qualifyAnswers.filter((x) => x !== c.label) })
                    }} />
                    {c.label} <span style={{ color: 'var(--color-geg-text-faint)' }}>{s.qualifyAnswers.includes(c.label) ? '· qualifies' : ''}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20 }}>
        <button type="button" onClick={onSave} disabled={pending} style={primaryBtn(pending)}>{isEdit ? 'Save changes' : 'Save landing page'}</button>
        <button type="button" onClick={onClose} disabled={pending} style={secondaryBtn(pending)}>Cancel</button>
        <label className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', display: 'flex', gap: 6, alignItems: 'center', marginLeft: 6 }}>
          <input type="checkbox" checked={s.active} onChange={(e) => set({ active: e.target.checked })} /> active
        </label>
        {msg ? <span className="geg-mono" style={{ fontSize: 11.5, color: msg.startsWith('Error') ? 'var(--color-geg-danger, #c0392b)' : 'var(--color-geg-text-2)' }}>{msg}</span> : null}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </label>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="geg-mono" style={{ display: 'block', fontSize: 10, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', marginBottom: 5 }}>
      {children}
    </span>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 9px', fontSize: 13, borderRadius: 5,
  border: '1px solid var(--color-geg-border)', background: 'var(--color-geg-bg)', color: 'var(--color-geg-text)',
}
function baseBtn(p: boolean): React.CSSProperties {
  return { fontSize: 12.5, padding: '7px 16px', borderRadius: 5, cursor: p ? 'default' : 'pointer', opacity: p ? 0.55 : 1, border: '1px solid var(--color-geg-border)', fontFamily: 'var(--font-prom-sans), Inter, system-ui, sans-serif' }
}
function primaryBtn(p: boolean): React.CSSProperties { return { ...baseBtn(p), background: 'var(--color-geg-accent)', borderColor: 'var(--color-geg-accent)', color: '#fff', fontWeight: 600 } }
function secondaryBtn(p: boolean): React.CSSProperties { return { ...baseBtn(p), background: 'var(--color-geg-bg-elev)', color: 'var(--color-geg-text)' } }
function dangerBtn(p: boolean): React.CSSProperties { return { ...baseBtn(p), background: 'transparent', color: 'var(--color-geg-text-faint)' } }
