'use client'

// Filter-bar primitive for /clients (M5.5). One trigger button, one
// dropdown of checkboxes, OR-within / multi-select. Built on the
// existing base-ui DropdownMenu + DropdownMenuCheckboxItem in
// components/ui/dropdown-menu.tsx — no new primitive system installed.
//
// Stay-open behavior: base-ui's Menu.CheckboxItem already defaults to
// closeOnClick=false (verified against the package's d.ts), so the
// menu stays open across multiple checkbox clicks with no extra prop.
//
// Disabled state renders the same trigger silhouette but as a plain
// button with a `title` attribute so hovering surfaces the tooltip
// hint. (No Tooltip primitive available; codebase is base-ui-only and
// installing a Radix-based shadcn primitive would fragment the
// component aesthetic.)

import { ChevronDownIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export type MultiSelectDropdownProps = {
  label: string
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>
  selected: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  disabledTooltip?: string
  /**
   * 'multi' (default) renders the trigger as "{label}: {first} +{N}".
   * 'toggle' renders "{label}: on" when anything is selected — used for
   * single-value toggles like Needs review where the option label is
   * descriptive ("Auto-created — needs review") and including it in the
   * trigger reads awkwardly.
   */
  mode?: 'multi' | 'toggle'
}

const TRIGGER_BASE =
  'inline-flex h-8 items-center gap-1.5 rounded-md border bg-transparent px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  disabled = false,
  disabledTooltip,
  mode = 'multi',
}: MultiSelectDropdownProps) {
  if (disabled) {
    return (
      <button
        type="button"
        disabled
        title={disabledTooltip}
        className={cn(
          TRIGGER_BASE,
          'border-input text-muted-foreground/60 cursor-not-allowed opacity-60',
        )}
      >
        <span>{label}</span>
        <ChevronDownIcon className="size-3.5" aria-hidden />
      </button>
    )
  }

  // Compute the trigger label preserving the option-list order so
  // "+N" always counts the trailing items deterministically (independent
  // of click order).
  const selectedLabels = options
    .filter((opt) => selected.includes(opt.value))
    .map((opt) => opt.label)

  const triggerText =
    selectedLabels.length === 0
      ? label
      : mode === 'toggle'
        ? `${label}: on`
        : selectedLabels.length === 1
          ? `${label}: ${selectedLabels[0]}`
          : `${label}: ${selectedLabels[0]} +${selectedLabels.length - 1}`

  const isActive = selected.length > 0

  function toggle(value: string, next: boolean) {
    if (next) {
      // Append rather than rebuild from option order — preserves the
      // user's click order in the URL serialization, which makes Clear
      // -> re-check-defaults round-trip cleanly via set equality even
      // when the user clicks them in a different order.
      if (!selected.includes(value)) {
        onChange([...selected, value])
      }
    } else {
      onChange(selected.filter((v) => v !== value))
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          TRIGGER_BASE,
          'cursor-pointer hover:bg-accent',
          isActive
            ? 'border-primary/40 bg-primary/5 text-foreground'
            : 'border-input text-muted-foreground',
        )}
      >
        <span>{triggerText}</span>
        <ChevronDownIcon className="size-3.5" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        {options.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt.value}
            checked={selected.includes(opt.value)}
            onCheckedChange={(next) => toggle(opt.value, next)}
          >
            {opt.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
