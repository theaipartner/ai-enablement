// Re-exports + tiny helpers so surface files have a flat import surface.
// Anything not generic enough to live in primitives.tsx but used in
// multiple surfaces lands here.

import { AvatarCircle } from './primitives'
import type { Setter, Closer } from '@/lib/mock-data'

export * from './primitives'

export function setterDisplay(s: Setter | Closer) {
  return (
    <span className="inline-flex items-center gap-2">
      <AvatarCircle initials={s.avatar_initials} />
      <span className="text-xs">{s.name}</span>
    </span>
  )
}
