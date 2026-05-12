import { prometheanSerif, prometheanSans } from './fonts'

// Loads the editorial-dark fonts only on /promethean routes — Gregory keeps
// its Geist stack untouched. The data-theme attribute scopes the warm-dark
// palette defined in app/globals.css.
export default function PrometheanLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div
      data-theme="promethean"
      className={`${prometheanSerif.variable} ${prometheanSans.variable} min-h-screen`}
      style={{ background: 'var(--color-prom-bg)', color: 'var(--color-prom-text)' }}
    >
      {children}
    </div>
  )
}
