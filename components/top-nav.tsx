'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

const NAV_ITEMS = [
  { href: '/clients', label: 'Clients' },
  { href: '/calls', label: 'Calls' },
  { href: '/ella/runs', label: 'Ella' },
] as const

export function TopNav({ userEmail }: { userEmail: string }) {
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
          {NAV_ITEMS.map((item) => {
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
