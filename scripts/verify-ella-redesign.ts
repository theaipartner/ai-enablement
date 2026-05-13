/**
 * Playwright visual-verification harness for the Ella audit redesign.
 *
 * Captures both surfaces:
 *   - /ella/runs (full list page, header + metric strip + filter bar + table)
 *   - /ella/runs/[id] (detail page, both columns + show-more states)
 *
 * Read-only — no clicks beyond the Show-more toggles which are client-side.
 *
 * Output:
 *   scripts/.preview/ella-redesign-list.png
 *   scripts/.preview/ella-redesign-list-cropped.png      (above-the-fold)
 *   scripts/.preview/ella-redesign-detail.png            (collapsed)
 *   scripts/.preview/ella-redesign-detail-expanded.png   (after Show more clicks)
 *
 * Usage:
 *   npx --yes tsx scripts/verify-ella-redesign.ts
 */

import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const PREVIEW_BASE =
  process.env.PREVIEW_URL ??
  'https://ai-enablement-git-gregory-csm-visual-fixes-drakeynes-projects.vercel.app'

const OUT_DIR = path.join(process.cwd(), 'scripts', '.preview')

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })

  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { 'Cache-Control': 'no-cache' },
    })
    const page = await context.newPage()

    // --- /ella/runs list ---
    console.log(`[verify] GET ${PREVIEW_BASE}/ella/runs`)
    await page.goto(`${PREVIEW_BASE}/ella/runs`, { waitUntil: 'networkidle' })
    await page.waitForSelector('table tbody tr', { timeout: 30_000 })
    const rowCount = await page.locator('table tbody tr').count()
    console.log(`[verify] list: ${rowCount} rows`)

    const listFullPath = path.join(OUT_DIR, 'ella-redesign-list.png')
    await page.screenshot({ path: listFullPath, fullPage: false })
    console.log(`[verify] wrote ${listFullPath}`)

    // Cropped above-the-fold for the redesign report.
    const listCroppedPath = path.join(
      OUT_DIR,
      'ella-redesign-list-cropped.png',
    )
    await page.screenshot({
      path: listCroppedPath,
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    })
    console.log(`[verify] wrote ${listCroppedPath}`)

    // --- /ella/runs/[id] detail ---
    // Walk first ~20 rows, find one with a long enough message to trigger
    // "Show more" — that gives the best demonstration of the layout +
    // truncation contract together.
    let targetHref: string | null = null
    const maxScan = Math.min(20, rowCount)
    for (let i = 0; i < maxScan; i++) {
      const link = page.locator('table tbody tr').nth(i).locator('a').first()
      const href = await link.getAttribute('href')
      if (!href || !href.startsWith('/ella/runs/')) continue
      await page.goto(`${PREVIEW_BASE}${href}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('h1', { timeout: 30_000 })

      const hasShowMore = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'))
        return btns.some((b) =>
          (b.textContent ?? '').toLowerCase().includes('show full'),
        )
      })
      if (hasShowMore) {
        targetHref = href
        console.log(`[verify] target detail (Show more present): ${href}`)
        break
      }
    }

    if (!targetHref) {
      // Fall back to first run for the detail screenshot.
      const firstLink = page.locator('table tbody tr').first().locator('a').first()
      const href = await firstLink.getAttribute('href')
      if (href) {
        targetHref = href
        await page.goto(`${PREVIEW_BASE}${href}`, { waitUntil: 'networkidle' })
        await page.waitForSelector('h1', { timeout: 30_000 })
        console.log(
          `[verify] no run with long-enough messages; using first row: ${href}`,
        )
      }
    }

    if (!targetHref) {
      console.error('[verify] could not find any detail href')
      process.exitCode = 1
      return
    }

    const detailPath = path.join(OUT_DIR, 'ella-redesign-detail.png')
    await page.screenshot({ path: detailPath, fullPage: true })
    console.log(`[verify] wrote ${detailPath}`)

    // Click every Show more in sequence to demonstrate expanded state.
    let safety = 0
    while (safety < 10) {
      const next = page
        .locator('button', { hasText: /show full|show more/i })
        .first()
      if ((await next.count()) === 0) break
      await next.click()
      await page.waitForTimeout(120)
      safety++
    }
    console.log(`[verify] clicked ${safety} Show more buttons`)

    const detailExpandedPath = path.join(
      OUT_DIR,
      'ella-redesign-detail-expanded.png',
    )
    await page.screenshot({ path: detailExpandedPath, fullPage: true })
    console.log(`[verify] wrote ${detailExpandedPath}`)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
