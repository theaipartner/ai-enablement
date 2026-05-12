'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type NavItem = { href: string; label: string; icon: string }
type NavSection = { label: string | null; items: NavItem[] }

const NAV: NavSection[] = [
  {
    label: null,
    items: [
      { href: '/promethean', label: 'Overview', icon: '◆' },
      { href: '/promethean/inbox', label: 'Inbox', icon: '✉' },
      { href: '/promethean/triage-inbox', label: 'Triage Inbox', icon: '▽' },
      { href: '/promethean/ai-mode', label: 'AI Mode', icon: '✦' },
    ],
  },
  {
    label: 'SALES',
    items: [
      { href: '/promethean/contacts', label: 'Contacts', icon: '○' },
      { href: '/promethean/closers', label: 'Closers', icon: '◐' },
      { href: '/promethean/setters', label: 'Setters', icon: '◌' },
      { href: '/promethean/setter-qc', label: 'Setter QC', icon: '◉' },
      { href: '/promethean/number-health', label: 'Number Health', icon: '#' },
      { href: '/promethean/setter-eod', label: 'Setter EOD', icon: '▤' },
    ],
  },
  {
    label: 'ACQUISITION',
    items: [
      { href: '/promethean/marketing', label: 'Marketing', icon: '▣' },
      { href: '/promethean/deep-dive', label: 'Deep Dive', icon: '◊' },
      { href: '/promethean/money-on-table', label: 'Money on Table', icon: '$' },
      { href: '/promethean/payment-plans', label: 'Payment Plans', icon: '⊟' },
      { href: '/promethean/cohort-retention', label: 'Cohort Retention', icon: '∾' },
      { href: '/promethean/pnl', label: 'P&L', icon: '≡' },
    ],
  },
  {
    label: 'WORKBENCH',
    items: [
      { href: '/promethean/pipeline', label: 'Pipeline', icon: '▦' },
      { href: '/promethean/financials', label: 'Financials', icon: '∑' },
    ],
  },
]

function isActive(pathname: string, href: string) {
  if (href === '/promethean') return pathname === '/promethean'
  return pathname === href || pathname.startsWith(href + '/')
}

export function PrometheanShell({
  userEmail,
  children,
}: {
  userEmail: string
  children: React.ReactNode
}) {
  const pathname = usePathname() ?? ''
  const router = useRouter()

  async function onLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="flex min-h-screen">
      <aside
        className="hidden md:flex flex-col shrink-0 border-r"
        style={{
          width: 240,
          background: 'var(--color-prom-bg)',
          borderColor: 'var(--color-prom-border)',
        }}
      >
        {/* Brand block */}
        <div className="px-5 pt-6 pb-5">
          <div className="flex items-center gap-2">
            <span
              className="inline-block rounded-full prom-pulse"
              style={{
                width: 7,
                height: 7,
                background: 'var(--color-prom-accent)',
                boxShadow: '0 0 8px var(--color-prom-accent-dim)',
              }}
            />
            <span className="prom-eyebrow" style={{ color: 'var(--color-prom-text-2)' }}>
              Promethean · LIVE
            </span>
          </div>
          <div className="mt-4 prom-serif" style={{ fontSize: 26, lineHeight: '30px' }}>
            Helios
          </div>
          <div className="prom-eyebrow mt-1">HELIOS · SCALE-2</div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2 pb-6">
          {NAV.map((section, idx) => (
            <div key={idx} className={section.label ? 'mt-5' : 'mt-1'}>
              {section.label ? (
                <div className="prom-section-label px-3 mb-2">— {section.label} —</div>
              ) : null}
              {section.items.map((item) => {
                const active = isActive(pathname, item.href)
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="group relative flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors"
                    style={{
                      color: active
                        ? 'var(--color-prom-text)'
                        : 'var(--color-prom-text-2)',
                      background: active
                        ? 'rgba(212, 225, 87, 0.06)'
                        : 'transparent',
                    }}
                  >
                    {active ? (
                      <span
                        className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r"
                        style={{ background: 'var(--color-prom-accent)' }}
                      />
                    ) : null}
                    <span
                      className="inline-flex w-4 justify-center"
                      style={{ color: 'var(--color-prom-text-3)', fontSize: 12 }}
                    >
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                  </Link>
                )
              })}
            </div>
          ))}

          {/* Configuration footer */}
          <div className="mt-8 px-3">
            <div className="prom-section-label mb-2">— CONFIGURATION —</div>
            <div className="rounded-md px-3 py-2.5" style={{ background: 'var(--color-prom-bg-elev)' }}>
              <div className="prom-eyebrow mb-0.5">OWNER</div>
              <div className="text-xs truncate" style={{ color: 'var(--color-prom-text-2)' }}>
                {userEmail || 'thomas@heliosscale.com'}
              </div>
              <div className="prom-eyebrow mt-2">APP ADMIN</div>
              <button
                onClick={onLogout}
                className="mt-2 text-xs underline-offset-2 hover:underline"
                style={{ color: 'var(--color-prom-text-3)' }}
              >
                Log out
              </button>
            </div>
            <div className="mt-3 text-center">
              <Link
                href="/clients"
                className="prom-eyebrow hover:underline"
                style={{ color: 'var(--color-prom-text-3)' }}
              >
                ← Back to Gregory
              </Link>
            </div>
          </div>
        </nav>
      </aside>

      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
