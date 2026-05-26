// Capture the Pulse page at 1d / 7d / 30d to compare layouts and find
// clipping / alignment regressions. Outputs to /tmp/dashboard-shots.

import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const OUT = '/tmp/dashboard-shots'
const BASE = 'http://localhost:3000'
const WINDOWS = ['1d', '7d', '30d']

async function run() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  for (const w of WINDOWS) {
    process.stdout.write(`→ window=${w} ... `)
    await page.goto(`${BASE}/sales-dashboard?window=${w}`, { waitUntil: 'networkidle', timeout: 30_000 })
    await page.screenshot({ path: `${OUT}/pulse-${w}.png`, fullPage: true })
    // Also capture only the money-flow region for crisper inspection.
    const moneyFlow = await page.$('section[aria-label="Money flow"]')
    if (moneyFlow) await moneyFlow.screenshot({ path: `${OUT}/pulse-${w}-money.png` })
    const funnel = await page.$('section[aria-label="Sales funnel"]')
    if (funnel) await funnel.screenshot({ path: `${OUT}/pulse-${w}-funnel.png` })
    const closers = await page.$('section[aria-label="Top closers this period"]')
    if (closers) await closers.screenshot({ path: `${OUT}/pulse-${w}-closers.png` })
    const overflowCheck = await page.evaluate(() => {
      const out = []
      // Find any element whose right edge exceeds its parent's right edge by > 2px
      const all = document.querySelectorAll('section, div, span')
      for (const el of all) {
        if (!el.parentElement) continue
        const r = el.getBoundingClientRect()
        const pr = el.parentElement.getBoundingClientRect()
        if (r.right > pr.right + 2 && el.offsetWidth > 60) {
          const cls = (typeof el.className === 'string' ? el.className : '').slice(0, 50)
          out.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls.split(' ').slice(0, 2).join('.') : ''} child-right=${Math.round(r.right)} parent-right=${Math.round(pr.right)}`)
          if (out.length > 8) break
        }
      }
      return out
    })
    console.log(`ok${overflowCheck.length ? ' — child-overflow:' : ''}`)
    for (const o of overflowCheck) console.log('    ' + o)
  }
  await browser.close()
}

run().catch((e) => { console.error(e); process.exit(1) })
