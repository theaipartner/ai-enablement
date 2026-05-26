// Quick Playwright runner to capture the dashboard pages for visual
// review. Writes to /tmp/dashboard-shots/<route>.png. Local-only — not
// committed long-term.
//
// Usage: node scripts/dashboard-screenshots.mjs

import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const ROUTES = [
  ['pulse', '/sales-dashboard'],
  ['funnel', '/sales-dashboard/funnel'],
  ['funnel-ads', '/sales-dashboard/funnel/ads'],
  ['funnel-lp', '/sales-dashboard/funnel/landing-pages'],
  ['funnel-submits', '/sales-dashboard/funnel/submits'],
  ['funnel-apt', '/sales-dashboard/funnel/appointment-setting'],
  ['funnel-showed', '/sales-dashboard/funnel/showed'],
  ['funnel-closed', '/sales-dashboard/funnel/closed'],
  ['revenue', '/sales-dashboard/revenue'],
  ['revenue-new-cash', '/sales-dashboard/revenue/new-cash'],
  ['revenue-future', '/sales-dashboard/revenue/future'],
  ['revenue-refunds', '/sales-dashboard/revenue/refunds'],
  ['revenue-expenses', '/sales-dashboard/revenue/expenses'],
  ['revenue-profit', '/sales-dashboard/revenue/profit'],
  ['people-closers', '/sales-dashboard/people'],
  ['people-setters', '/sales-dashboard/people?role=setters'],
  ['people-csms', '/sales-dashboard/people?role=csms'],
  ['people-closer-detail', '/sales-dashboard/people/closer/closer-0'],
  ['people-setter-detail', '/sales-dashboard/people/setter/setter-0'],
]

const OUT = '/tmp/dashboard-shots'
const BASE = 'http://localhost:3000'

const WIDTHS = [1920, 1440, 1280, 1024]

async function run() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch()
  for (const width of WIDTHS) {
    console.log(`\n=== Viewport width: ${width} ===`)
    const ctx = await browser.newContext({ viewport: { width, height: 900 } })
    const page = await ctx.newPage()
    for (const [name, path] of ROUTES) {
      process.stdout.write(`→ ${path} ... `)
      try {
        await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30_000 })
        await page.screenshot({ path: `${OUT}/${name}-${width}.png`, fullPage: true })
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
        const clientWidth = await page.evaluate(() => document.documentElement.clientWidth)
        const overflow = scrollWidth > clientWidth
        let overflowingElems = []
        if (overflow) {
          overflowingElems = await page.evaluate(() => {
            const out = []
            const all = document.querySelectorAll('*')
            for (const el of all) {
              const r = el.getBoundingClientRect()
              if (r.right > document.documentElement.clientWidth + 1 && el.offsetWidth > 50) {
                const cls = (el.className && typeof el.className === 'string' ? el.className.slice(0, 60) : '')
                out.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls.split(' ').slice(0, 2).join('.') : ''} right=${Math.round(r.right)} w=${el.offsetWidth}`)
                if (out.length > 6) break
              }
            }
            return out
          })
        }
        console.log(`scroll=${scrollWidth} client=${clientWidth}${overflow ? ' ⚠ OVERFLOW' : ''}`)
        for (const el of overflowingElems) console.log(`     ${el}`)
      } catch (e) {
        console.log(`FAIL ${e.message}`)
      }
    }
    await ctx.close()
  }
  await browser.close()
}

run().catch((e) => { console.error(e); process.exit(1) })
