// Sales Dashboard v2 — MetricCard primitive.
//
// The single per-metric chrome used across the Overview hero, the
// section-page Top-Live row, and the section-page Full-Catalog grid.
// Three SIZE variants + four STATE variants resolve at composition
// time; the state is always derived from the catalog entry, never
// toggled client-side. See `docs/specs/sales-dashboard-v2.md` § Three-
// state visual contract.
//
// Size variants:
//   - 'hero-lede'    — Overview top row, 3-up. 200px min, 72px serif value.
//   - 'hero-support' — Overview second row, 4-up. 168px min, 56px value.
//   - 'top-live'     — Section page top-row, 3-up. 160px min, 44px value.
//   - 'grid'         — Full-catalog grid, 4-up. 124px min, 28px value.
//
// State variants:
//   - 'live'          — solid elev bg, full serif numeric, pos glyph.
//   - 'pending'       — warn-tinted bg, PENDING pill, warn glyph.
//   - 'not_connected' — transparent dashed border, NOT CONNECTED pill, faint glyph.
//   - 'live_error'    — elev bg, red 3px border-left, ERROR badge,
//                       message in title tooltip.
//
// Tokens consumed: every color comes from `--color-geg-*` in
// app/globals.css. No new tokens are introduced.

import type { CSSProperties, ReactNode } from 'react'
import {
  type FetchResult,
  type MetricEntry,
  formatMetricValue,
  inferredFormat,
  isHigherBetter,
} from '@/lib/db/sales-dashboard-shared'
import { Sparkline } from './sparkline'

export type MetricCardSize = 'hero-lede' | 'hero-support' | 'top-live' | 'grid'

export type MetricCardProps = {
  metric: MetricEntry
  result: FetchResult | undefined
  size: MetricCardSize
  // Optional section eyebrow override — used by the hero variants
  // where the per-card section tag is visible (mock shows "CLOSING",
  // "FUNNELS", "ADVERTISING" etc. in gold mono). Grid variants
  // suppress it (the column header already names the section).
  sectionTagOverride?: string | null
}

export function MetricCard({ metric, result, size, sectionTagOverride }: MetricCardProps) {
  const state = result?.state ?? metric.status
  const isHero = size === 'hero-lede' || size === 'hero-support'
  const isTopLive = size === 'top-live'

  const sectionTag =
    sectionTagOverride === null
      ? null
      : sectionTagOverride ?? (isHero || isTopLive ? metric.section : null)

  // Size-derived dimensions.
  const dims = sizeDims(size)

  // State-derived chrome.
  const chrome = stateChrome(state, isHero || isTopLive)

  return (
    <div style={{ ...chrome.container, ...dims.container }}>
      <CardHead
        title={metric.title}
        sectionTag={sectionTag}
        stateColor={chrome.glyph}
        isHero={isHero || isTopLive}
        size={size}
      />

      <CardBody
        metric={metric}
        result={result}
        state={state}
        size={size}
      />

      <CardMeta
        source={metric.source}
        note={metric.note}
        state={state}
        size={size}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function CardHead({
  title,
  sectionTag,
  stateColor,
  isHero,
}: {
  title: string
  sectionTag: string | null
  stateColor: string
  isHero: boolean
  size: MetricCardSize
}) {
  if (isHero) {
    // Hero/top-live: section-tag (gold mono caps) on the left, no glyph
    // on the right (the glyph for hero variants would crowd the
    // delta/sparkline slot we deferred to v2.1). The state is implicit
    // in the chrome (border/bg).
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        {sectionTag ? (
          <span
            className="geg-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-accent)',
            }}
          >
            {sectionTag}
          </span>
        ) : <span />}
      </div>
    )
  }

  // Grid: name on the left, state glyph dot on the right.
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
      <div
        className="geg-serif"
        style={{
          fontSize: 14,
          lineHeight: '18px',
          color: 'var(--color-geg-text)',
          letterSpacing: '-0.005em',
        }}
      >
        {title}
      </div>
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          marginTop: 7,
          flexShrink: 0,
          background: stateColor,
        }}
      />
    </div>
  )
}

function CardBody({
  metric,
  result,
  state,
  size,
}: {
  metric: MetricEntry
  result: FetchResult | undefined
  state: FetchResult['state'] | MetricEntry['status']
  size: MetricCardSize
}) {
  const isHero = size === 'hero-lede' || size === 'hero-support'
  const isTopLive = size === 'top-live'
  const isGrid = size === 'grid'

  // Hero/top-live always shows the metric NAME after the section-tag.
  const nameBlock =
    isHero || isTopLive ? (
      <div
        className="geg-serif"
        style={{
          fontSize: size === 'hero-lede' ? 17 : size === 'hero-support' ? 16 : 15.5,
          lineHeight: size === 'hero-lede' ? '21px' : size === 'hero-support' ? '20px' : '19px',
          color: 'var(--color-geg-text-2)',
          letterSpacing: '-0.005em',
        }}
      >
        {metric.title}
      </div>
    ) : null

  // The value/badge block.
  const valueBlock = renderValueBlock(state, result, metric, size)

  return (
    <>
      {nameBlock}
      <div
        style={
          isGrid
            ? { display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 'auto', minHeight: 32 }
            : { marginTop: 'auto' }
        }
      >
        {valueBlock}
      </div>
    </>
  )
}

function renderValueBlock(
  state: string,
  result: FetchResult | undefined,
  metric: MetricEntry,
  size: MetricCardSize,
): ReactNode {
  void state
  if (!result) {
    return <StateBadge label="LOADING" color="dim" />
  }
  if (result.state === 'pending') {
    return <StateBadge label="PENDING" color="warn" />
  }
  if (result.state === 'not_connected') {
    return <StateBadge label="NOT CONNECTED" color="dim" />
  }
  if (result.state === 'live_error') {
    return (
      <span
        className="geg-mono"
        title={result.message}
        style={{ fontSize: 12, color: 'var(--color-geg-neg)' }}
      >
        ERROR
      </span>
    )
  }
  // live
  const fontSize =
    size === 'hero-lede' ? 72 : size === 'hero-support' ? 56 : size === 'top-live' ? 44 : 28
  const lineHeight =
    size === 'hero-lede' ? '70px' : size === 'hero-support' ? '56px' : size === 'top-live' ? '46px' : '32px'
  const letterSpacing =
    size === 'hero-lede' ? '-0.03em' : size === 'hero-support' ? '-0.03em' : size === 'top-live' ? '-0.025em' : '-0.02em'
  const isGrid = size === 'grid'

  const valueNode = (
    <span
      className="geg-numeric-serif"
      style={{
        fontSize,
        lineHeight,
        letterSpacing,
        color: 'var(--color-geg-text)',
      }}
    >
      {formatMetricValue(result.value, metric.format ?? inferredFormat(metric.title))}
    </span>
  )

  const deltaNode = result.value !== null && result.value !== undefined && result.prior !== null && result.prior !== undefined
    ? <DeltaPill current={result.value} prior={result.prior} higherBetter={isHigherBetter(metric.title)} compact={isGrid} />
    : null

  const sparkSize = size === 'hero-lede'
    ? { w: 120, h: 28 }
    : size === 'hero-support'
      ? { w: 96, h: 24 }
      : size === 'top-live'
        ? { w: 84, h: 22 }
        : { w: 64, h: 18 }
  const sparkNode = result.series && result.series.length > 1
    ? <Sparkline data={result.series} width={sparkSize.w} height={sparkSize.h} stroke="var(--color-geg-text-3)" />
    : null

  if (isGrid) {
    // Grid: value on its own line, delta + spark on a tight second line.
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {valueNode}
        {(deltaNode || sparkNode) && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            {deltaNode}
            {sparkNode}
          </div>
        )}
      </div>
    )
  }

  // Hero / top-live: value + (delta column + sparkline) side-by-side.
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, justifyContent: 'space-between' }}>
      {valueNode}
      {(deltaNode || sparkNode) && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 6,
            paddingBottom: 6,
          }}
        >
          {deltaNode}
          {sparkNode}
        </div>
      )}
    </div>
  )
}

function DeltaPill({
  current,
  prior,
  higherBetter,
  compact,
}: {
  current: number
  prior: number
  higherBetter: boolean
  compact?: boolean
}) {
  if (prior === 0) {
    return (
      <span
        className="geg-mono"
        style={{
          fontSize: compact ? 9 : 10,
          letterSpacing: '0.08em',
          color: 'var(--color-geg-text-faint)',
        }}
      >
        —
      </span>
    )
  }
  const pct = (current - prior) / prior
  const isPositive = pct >= 0
  const isGood = isPositive === higherBetter
  const color = pct === 0
    ? 'var(--color-geg-text-faint)'
    : isGood
      ? 'var(--color-geg-pos)'
      : 'var(--color-geg-neg)'
  const arrow = pct === 0 ? '·' : isPositive ? '▲' : '▼'
  const display = `${arrow} ${Math.abs(pct * 100).toFixed(1)}%`
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: compact ? 10 : 11,
        letterSpacing: '0.04em',
        color,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {display}
    </span>
  )
}

function CardMeta({
  source,
  note,
  state,
  size,
}: {
  source: string
  note?: string
  state: string
  size: MetricCardSize
}) {
  const isGrid = size === 'grid'
  // Hero variants render source on a bottom row WITHOUT a sparkline
  // (sparklines deferred to v2.1 per spec § Out of scope).
  if (!isGrid) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginTop: size === 'hero-lede' || size === 'hero-support' ? 8 : 4,
        }}
      >
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-3)',
          }}
        >
          {source}
        </span>
      </div>
    )
  }

  // Grid: source on a meta line + optional note italic under it.
  const sourceColor =
    state === 'pending'
      ? 'var(--color-geg-warn)'
      : state === 'not_connected'
        ? 'var(--color-geg-text-faint)'
        : 'var(--color-geg-text-3)'
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span
          className="geg-mono"
          style={{
            fontSize: 9.5,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: sourceColor,
          }}
        >
          {source}
        </span>
      </div>
      {note ? (
        <div
          className="geg-serif"
          style={{
            fontStyle: 'italic',
            fontSize: 11.5,
            color: 'var(--color-geg-text-faint)',
            lineHeight: '14px',
            marginTop: -2,
          }}
        >
          {note}
        </div>
      ) : null}
    </>
  )
}

function StateBadge({ label, color }: { label: string; color: 'warn' | 'dim' }) {
  const fill = color === 'warn' ? 'var(--color-geg-warn)' : 'var(--color-geg-text-2)'
  const bg = color === 'warn' ? 'var(--color-geg-warn-fill)' : 'rgba(255, 255, 255, 0.03)'
  const border = color === 'warn' ? 'var(--color-geg-warn-border)' : 'var(--color-geg-border-strong)'
  return (
    <span
      className="geg-mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'flex-start',
        padding: '3px 8px 3px 7px',
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: '0.12em',
        color: fill,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 999,
        textTransform: 'uppercase',
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color === 'warn' ? 'var(--color-geg-warn)' : 'var(--color-geg-text-faint)',
        }}
      />
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Size + state styling tables
// ---------------------------------------------------------------------------

function sizeDims(size: MetricCardSize): { container: CSSProperties } {
  switch (size) {
    case 'hero-lede':
      return {
        container: {
          padding: '24px 26px 22px',
          minHeight: 200,
          gap: 12,
        },
      }
    case 'hero-support':
      return {
        container: {
          padding: '22px 24px 20px',
          minHeight: 168,
          gap: 12,
        },
      }
    case 'top-live':
      return {
        container: {
          padding: '22px 24px 20px',
          minHeight: 160,
          gap: 10,
        },
      }
    case 'grid':
      return {
        container: {
          padding: '14px 16px',
          minHeight: 124,
          gap: 8,
        },
      }
  }
}

function stateChrome(
  state: string,
  isHero: boolean,
): { container: CSSProperties; glyph: string } {
  // Hero/top-live variants live in row-grids that already provide the
  // dividing borders via background-color trickery, so per-card
  // border is suppressed — chrome reads via solid bg + border-left
  // accent only on live_error. Grid variants get a full per-card
  // border in the catalog grid.
  if (isHero) {
    if (state === 'live_error') {
      return {
        container: {
          background: 'var(--color-geg-bg-elev)',
          borderLeft: '3px solid var(--color-geg-neg)',
          display: 'flex',
          flexDirection: 'column',
        },
        glyph: 'var(--color-geg-neg)',
      }
    }
    if (state === 'pending') {
      return {
        container: {
          background: 'var(--color-geg-warn-fill)',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        },
        glyph: 'var(--color-geg-warn)',
      }
    }
    if (state === 'not_connected') {
      return {
        container: {
          background: 'transparent',
          display: 'flex',
          flexDirection: 'column',
        },
        glyph: 'var(--color-geg-text-faint)',
      }
    }
    // live or loading
    return {
      container: {
        background: 'var(--color-geg-bg-elev)',
        display: 'flex',
        flexDirection: 'column',
      },
      glyph: 'var(--color-geg-pos)',
    }
  }

  // Grid variants — per-card border, three state chromes.
  if (state === 'live_error') {
    return {
      container: {
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderLeft: '3px solid var(--color-geg-neg)',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
      },
      glyph: 'var(--color-geg-neg)',
    }
  }
  if (state === 'pending') {
    return {
      container: {
        background: 'var(--color-geg-warn-fill)',
        border: '1px solid var(--color-geg-warn-border)',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
      },
      glyph: 'var(--color-geg-warn)',
    }
  }
  if (state === 'not_connected') {
    return {
      container: {
        background: 'transparent',
        border: '1px dashed var(--color-geg-border)',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
      },
      glyph: 'var(--color-geg-text-faint)',
    }
  }
  // live or loading
  return {
    container: {
      background: 'var(--color-geg-bg-elev)',
      border: '1px solid var(--color-geg-border)',
      borderRadius: 6,
      display: 'flex',
      flexDirection: 'column',
    },
    glyph: 'var(--color-geg-pos)',
  }
}
