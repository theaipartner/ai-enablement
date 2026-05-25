/**
 * Playwright verifier for /sales-dashboard v2.
 *
 * Visits each of the v2 surfaces (Overview, two section pages — one
 * with live metrics, one all-not-connected — and the Three-states
 * reference), screenshots them full-page, and runs structural
 * assertions against the rendered DOM.
 *
 * Defaults to `http://localhost:3033`. Set `PREVIEW_URL` to point at a
 * Vercel preview deploy. Requires `NEXT_PUBLIC_DISABLE_AUTH=true` on
 * the target (the gate bypass already lives in the layout).
 *
 * Spec: docs/specs/sales-dashboard-v2.md
 * Mock: docs/specs/sales-dashboard-v2.html
 *
 * Invoke:
 *   PREVIEW_URL=http://localhost:3033 npx --yes tsx scripts/verify-sales-dashboard-v2-preview.ts
 */
import { chromium, type ConsoleMessage, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const PREVIEW_BASE = process.env.PREVIEW_URL ?? 'http://localhost:3033'
const OUTPUT_DIR = path.resolve('scripts/.preview/sales-v2')

type Probe = {
  url: string
  screenshot: string
  assert: (page: Page) => Promise<void>
}

async function assertOverview(page: Page) {
  // HeaderBand title
  const title = await page.locator('h1.geg-display').first().innerText()
  if (!/Today\./i.test(title)) {
    throw new Error(`overview: HeaderBand title expected "Today.", got "${title}"`)
  }

  // Sidebar present + 240px wide
  const sidebar = page.locator('aside').first()
  await sidebar.waitFor({ state: 'visible' })
  const sidebarWidth = await sidebar.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width)
  if (Math.abs(sidebarWidth - 240) > 2) {
    throw new Error(`overview: sidebar width expected ~240px, got ${sidebarWidth}px`)
  }

  // Sidebar lists Overview + 9 section links + Three states. Match
  // case-insensitively because the Overview link is text-transform:
  // uppercase ("OVERVIEW") while the section links keep their cased
  // titles ("Advertising", "Back-End Rev").
  const sidebarLinks = await page.locator('aside a').all()
  const labels = await Promise.all(sidebarLinks.map((l) => l.innerText()))
  const lowered = labels.map((l) => l.toLowerCase())
  const expectedLabels = ['Overview', 'Advertising', 'Content', 'Funnels', 'Appointment Setting', 'Closing', 'Sales Data', 'Back-End Rev', 'Business Costs', 'Fulfillment', 'Three states']
  for (const expected of expectedLabels) {
    if (!lowered.some((l) => l.includes(expected.toLowerCase()))) {
      throw new Error(`overview: sidebar missing "${expected}". Labels: ${JSON.stringify(labels)}`)
    }
  }

  // Overview link should be active
  const overviewLink = page.locator('aside a').first()
  const overviewActive = await overviewLink.getAttribute('data-active')
  if (overviewActive !== 'true') {
    throw new Error(`overview: Overview sidebar link should be active`)
  }

  // Hero cards — assert the 7 catalog-locked titles are present.
  // (3 lede + 4 support per spec § Hero metric catalog.)
  const main = page.locator('main').first()
  const stripText = await main.innerText()
  const ledeTitles = ['Total Cash Collected', 'Total Closed Deals', 'Typeform Submits']
  const supportTitles = ['Total Closer Bookings', 'Total Adspend', 'Total Dials', 'Calls Held']
  for (const t of [...ledeTitles, ...supportTitles]) {
    if (!stripText.includes(t)) {
      throw new Error(`overview: hero card "${t}" missing from page text`)
    }
  }
  for (const token of ['LIVE', 'PENDING', 'NOT CONNECTED']) {
    if (!stripText.includes(token)) {
      throw new Error(`overview: status strip missing "${token}"`)
    }
  }
  if (!/at least one live signal/i.test(stripText) || !/Engine coverage/i.test(stripText)) {
    throw new Error(`overview: status strip note line missing`)
  }
}

async function mainText(page: Page): Promise<string> {
  // The parent (authenticated)/layout.tsx renders the only <main>;
  // .first() makes the intent explicit. After the v2 nested-main fix,
  // there's only one — but keep the qualifier so a future regression
  // is loud instead of silent.
  return page.locator('main').first().innerText()
}

async function assertSectionLive(page: Page) {
  const title = await page.locator('h1.geg-display').first().innerText()
  if (!/Advertising\./i.test(title)) {
    throw new Error(`section/advertising: title expected "Advertising.", got "${title}"`)
  }

  // Backlink present
  const backlink = await page.locator('a:has-text("BACK TO OVERVIEW")').first()
  if (!(await backlink.isVisible())) {
    throw new Error(`section/advertising: backlink missing`)
  }

  // Sidebar should mark "Advertising" active
  const activeLink = page.locator('aside a[data-active="true"]')
  const activeLabel = await activeLink.innerText()
  if (!/Advertising/i.test(activeLabel)) {
    throw new Error(`section/advertising: active sidebar link should be "Advertising", got "${activeLabel}"`)
  }

  // Status pill shows N LIVE · N PENDING · N N/C
  const headerText = await page.locator('header').first().innerText()
  if (!/\d+ LIVE/.test(headerText) || !/\d+ PENDING/.test(headerText) || !/\d+ N\/C/.test(headerText)) {
    throw new Error(`section/advertising: header status pill missing LIVE/PENDING/N/C counts. Got: ${headerText}`)
  }

  // TOP LIVE group head
  const main = await mainText(page)
  if (!/TOP LIVE/.test(main)) {
    throw new Error(`section/advertising: TOP LIVE group head missing`)
  }
  if (!/FULL CATALOG/.test(main)) {
    throw new Error(`section/advertising: FULL CATALOG group head missing`)
  }
}

async function assertSectionAllNotConnected(page: Page) {
  // Content section has 0 live, all not_connected
  const main = await mainText(page)
  if (!/Content\./i.test(main)) throw new Error(`section/content: title missing`)
  if (!/No live metrics in this section yet/i.test(main)) {
    throw new Error(`section/content: empty-section-stub message missing`)
  }
  // TOP LIVE group should be SUPPRESSED when zero live
  if (/TOP LIVE/.test(main)) {
    throw new Error(`section/content: TOP LIVE group head should NOT render when there are zero live metrics`)
  }
  // FULL CATALOG still present with all NOT CONNECTED cards
  if (!/FULL CATALOG/.test(main)) {
    throw new Error(`section/content: FULL CATALOG missing`)
  }
  const ncCount = await page.locator('text=NOT CONNECTED').count()
  // 16 NC cards in CONTENT + 1 in the status pill = 17 minimum. Just
  // assert >= 10 to avoid an exact-N brittleness.
  if (ncCount < 10) {
    throw new Error(`section/content: expected >=10 "NOT CONNECTED" labels, got ${ncCount}`)
  }
}

async function assertStates(page: Page) {
  const main = await mainText(page)
  if (!/Three states\./i.test(main)) throw new Error(`states: title missing`)
  for (const token of ['LIVE', 'PENDING', 'NOT CONNECTED', 'Mapping rules']) {
    if (!main.includes(token)) throw new Error(`states: missing "${token}"`)
  }
  // Three example cards present
  const exampleCount = await page.locator('text=Total Adspend').count()
  if (exampleCount < 1) throw new Error(`states: LIVE example "Total Adspend" missing`)
}

const PROBES: Probe[] = [
  { url: '/sales-dashboard', screenshot: '01-overview.png', assert: assertOverview },
  { url: '/sales-dashboard/advertising', screenshot: '02-section-advertising-live.png', assert: assertSectionLive },
  { url: '/sales-dashboard/content', screenshot: '03-section-content-all-nc.png', assert: assertSectionAllNotConnected },
  { url: '/sales-dashboard/funnels', screenshot: '04-section-funnels-mix.png', assert: async () => {} },
  { url: '/sales-dashboard/closing', screenshot: '05-section-closing.png', assert: async () => {} },
  { url: '/sales-dashboard/states', screenshot: '06-states.png', assert: assertStates },
]

async function run() {
  await mkdir(OUTPUT_DIR, { recursive: true })

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()

  // Capture browser console errors per page (load-bearing — silent
  // hydration errors otherwise pass through).
  const consoleErrors: string[] = []
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(`[${msg.type()}] ${msg.text()}`)
  })

  const failures: string[] = []

  for (const probe of PROBES) {
    consoleErrors.length = 0
    const url = `${PREVIEW_BASE}${probe.url}`
    console.log(`\n→ ${url}`)
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
    if (!resp || !resp.ok()) {
      failures.push(`${probe.url}: HTTP ${resp?.status() ?? 'no-response'}`)
      continue
    }
    // Settle a bit for any client-side hydration.
    await page.waitForTimeout(400)

    const outPath = path.join(OUTPUT_DIR, probe.screenshot)
    await page.screenshot({ path: outPath, fullPage: true })
    console.log(`  ✓ screenshot → ${outPath}`)

    try {
      await probe.assert(page)
      console.log(`  ✓ assertions pass`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      failures.push(`${probe.url}: ${msg}`)
      console.log(`  ✗ ${msg}`)
    }

    if (consoleErrors.length > 0) {
      // Filter out React's well-known hydration prop warnings that
      // don't reflect real bugs (none expected today, but keep the
      // pattern consistent with the cost-hub verifier).
      const real = consoleErrors.filter(
        (e) =>
          !/Download the React DevTools/i.test(e) &&
          !/Fast Refresh/i.test(e) &&
          // Hot-reloader-client occasionally fires "Failed to fetch RSC
          // payload" mid-traverse when the dev server rebuilds between
          // navigations. Pure dev-mode artifact — the page still renders
          // (screenshot captures it correctly).
          !/Failed to fetch RSC payload.*hot-reloader-client/i.test(e),
      )
      if (real.length > 0) {
        failures.push(`${probe.url}: console errors:\n  ${real.join('\n  ')}`)
        console.log(`  ✗ ${real.length} console error(s)`)
      }
    }
  }

  await browser.close()

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`\nAll ${PROBES.length} probes pass. Screenshots in ${OUTPUT_DIR}/`)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
