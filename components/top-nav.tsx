'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { tierAtLeast, type AccessTier } from '@/lib/auth/access-tier-shared'

type NavItem = {
  href: string
  label: string
  requiredTier: AccessTier
}

// Nav vocabulary + per-item gate. Server-side filter in the layout
// passes the resolved tier down; the conditional render below hides
// items the user can't access. requiredTier='csm' is "everyone with an
// authenticated session", admin gates Ella, etc.
const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { href: '/clients', label: 'Clients', requiredTier: 'csm' },
  { href: '/calls', label: 'Calls', requiredTier: 'csm' },
  { href: '/teams', label: 'Teams', requiredTier: 'head_csm' },
  { href: '/ella/runs', label: 'Ella', requiredTier: 'admin' },
  { href: '/cost-hub', label: 'Cost hub', requiredTier: 'admin' },
  { href: '/tasks', label: 'Tasks', requiredTier: 'creator' },
] as const

export function TopNav({
  userEmail,
  accessTier,
}: {
  userEmail: string
  accessTier: AccessTier
}) {
  const router = useRouter()
  const supabase = createClient()
  const pathname = usePathname() ?? ''

  async function onLogout() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  function isActive(href: string): boolean {
    if (href === '/clients') return pathname === '/clients' || pathname.startsWith('/clients/')
    if (href === '/calls') return pathname === '/calls' || pathname.startsWith('/calls/')
    if (href === '/ella/runs') return pathname === '/ella/runs' || pathname.startsWith('/ella/runs/')
    if (href === '/teams') return pathname === '/teams' || pathname.startsWith('/teams/')
    if (href === '/tasks') return pathname === '/tasks' || pathname.startsWith('/tasks/')
    if (href === '/cost-hub') return pathname === '/cost-hub' || pathname.startsWith('/cost-hub/')
    return false
  }

  return (
    <nav
      className="flex items-center justify-between px-8"
      style={{
        height: 64,
        background: 'var(--color-geg-bg)',
        borderBottom: '1px solid var(--color-geg-border-strong)',
      }}
    >
      <div className="flex items-center gap-10">
        {/* Wordmark — serif, with LIVE indicator */}
        <div className="flex items-center gap-2.5">
          <span
            className="inline-block rounded-full geg-pulse"
            style={{
              width: 7,
              height: 7,
              background: 'var(--color-geg-accent)',
              boxShadow: '0 0 8px var(--color-geg-accent-dim)',
            }}
          />
          <Link
            href="/clients"
            className="geg-serif"
            style={{
              fontSize: 22,
              lineHeight: '24px',
              color: 'var(--color-geg-text)',
            }}
          >
            Gregory
          </Link>
        </div>

        <div className="flex items-center gap-1">
          {NAV_ITEMS.filter((item) => tierAtLeast(accessTier, item.requiredTier)).map((item) => {
            const active = isActive(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                className="relative inline-flex items-center px-3.5 py-1.5 text-sm transition-colors"
                style={{
                  color: active
                    ? 'var(--color-geg-text)'
                    : 'var(--color-geg-text-2)',
                  letterSpacing: active ? '0.02em' : 0,
                  fontWeight: active ? 500 : 400,
                }}
              >
                {item.label}
                {active ? (
                  <span
                    className="absolute left-3.5 right-3.5"
                    style={{
                      bottom: -19,
                      height: 2,
                      background: 'var(--color-geg-accent)',
                    }}
                  />
                ) : null}
              </Link>
            )
          })}
        </div>
      </div>

      <div className="flex items-center gap-4">
        <span
          className="text-xs"
          style={{ color: 'var(--color-geg-text-3)' }}
        >
          {userEmail}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onLogout}
          style={{
            background: 'transparent',
            color: 'var(--color-geg-text)',
            borderColor: 'var(--color-geg-border-strong)',
          }}
        >
          Logout
        </Button>
      </div>
    </nav>
  )
}
