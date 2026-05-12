import {
  PromPage,
  PromPageHeader,
  PromCard,
  PreviewBadge,
} from '@/components/promethean/primitives'

export const metadata = { title: 'AI Mode — Promethean' }

const SAMPLE_QUERIES = [
  'What\'s going to move the needle this week?',
  'Why are we losing deals at the pitch stage?',
  'Which setter–closer pairings should I run more often?',
  'Where am I leaving money on the table right now?',
  'How do we help Aiden Rodriguez close more like Sebastian?',
]

export default function PrometheanAiModePage() {
  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · AI MODE"
        title="Ask anything about the data."
        trailing={<PreviewBadge />}
        meta={<span>Powered by the same data layer the dashboards run on.</span>}
      />

      <div className="mt-10 max-w-[820px]">
        <PromCard className="p-7">
          <div className="prom-eyebrow mb-3">YOUR QUESTION</div>
          <textarea
            placeholder="Type a question about pipeline, performance, anything..."
            rows={5}
            className="w-full rounded-lg px-4 py-3 text-base"
            style={{
              background: 'var(--color-prom-bg)',
              color: 'var(--color-prom-text)',
              border: '1px solid var(--color-prom-border)',
              lineHeight: '1.6',
            }}
          />
          <div className="mt-4 flex justify-end">
            <button
              className="text-xs prom-eyebrow py-2.5 px-6 rounded-full font-semibold"
              style={{
                background: 'var(--color-prom-accent)',
                color: 'var(--color-prom-bg)',
              }}
            >
              ✦ ASK PROMETHEAN
            </button>
          </div>
        </PromCard>

        <div className="mt-8">
          <div className="prom-eyebrow mb-3">SAMPLE QUESTIONS</div>
          <div className="space-y-2">
            {SAMPLE_QUERIES.map((q) => (
              <div
                key={q}
                className="px-4 py-3 rounded-lg text-sm cursor-pointer hover:bg-white/[0.02] transition-colors"
                style={{
                  background: 'var(--color-prom-bg-elev)',
                  border: '1px solid var(--color-prom-border)',
                  color: 'var(--color-prom-text-2)',
                }}
              >
                <span style={{ color: 'var(--color-prom-accent)', marginRight: 10 }}>→</span>
                {q}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-8 text-xs" style={{ color: 'var(--color-prom-text-3)' }}>
          Demo-only. Live AI features land in V1 — wired to the same Supabase brain that powers
          the dashboards. Answers will quote real call recordings, real dial logs, real cash data.
        </div>
      </div>
    </PromPage>
  )
}
