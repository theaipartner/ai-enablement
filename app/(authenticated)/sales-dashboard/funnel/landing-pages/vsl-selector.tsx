'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

// VSL variant chip selector for the LP page. Client component because
// we need two behaviors a plain <a href="?vsl=..."> can't deliver:
//   1. Preserve other query params (?start=, ?end=) when switching.
//      A bare ?vsl=X href REPLACES the entire query string.
//   2. Soft-navigate so scroll position stays put. Plain anchors
//      trigger a full navigation that scrolls to top.
//
// Uses the same router.replace + scroll:false pattern as the
// date-range picker.

export type VslOption = { hashedId: string; label: string }

export function VslSelector({
  options,
  currentHashedId,
}: {
  options: VslOption[]
  currentHashedId: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function selectVariant(hashedId: string) {
    const sp = new URLSearchParams(params.toString())
    sp.set('vsl', hashedId)
    const qs = sp.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        marginBottom: 14,
        background: 'var(--color-geg-bg-elev)',
        border: '1px dashed var(--color-geg-border)',
        borderRadius: 6,
      }}
    >
      <span
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
        }}
      >
        VARIANT
      </span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {options.map((o) => {
          const active = o.hashedId === currentHashedId
          const short = o.label
            .replace('Vídeo Motion · Nabeel · ', '')
            .replace('Vídeo Motion · Nabeel ', '')
          return (
            <button
              key={o.hashedId}
              type="button"
              onClick={() => selectVariant(o.hashedId)}
              aria-pressed={active}
              className="geg-mono"
              style={{
                fontSize: 11,
                letterSpacing: '0.04em',
                padding: '4px 10px',
                borderRadius: 4,
                border: '1px solid var(--color-geg-border)',
                color: active ? 'var(--color-geg-text)' : 'var(--color-geg-text-3)',
                background: active ? 'var(--color-geg-bg)' : 'transparent',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {short}
            </button>
          )
        })}
      </div>
    </div>
  )
}
