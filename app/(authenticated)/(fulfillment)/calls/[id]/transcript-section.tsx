'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

// Section 6 — Transcript. Collapsed by default; toggle to expand.
// Read-only, scrollable. Transcripts can be very long (10k+ words);
// the max-h-96 + overflow-auto keeps the page navigable.
export function TranscriptSection({ transcript }: { transcript: string | null }) {
  const [expanded, setExpanded] = useState(false)

  if (!transcript) {
    return (
      <p className="text-sm text-muted-foreground">
        No transcript available for this call.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? 'Hide transcript' : 'Show transcript'}
      </Button>
      {expanded ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
          {transcript}
        </pre>
      ) : null}
    </div>
  )
}
