/**
 * Playwright visual-verification harness for the Calls redesign.
 *
 * Loads the preview deployment's /calls list, picks the first call in
 * the table, opens its detail page, and screenshots both. Auth is
 * disabled on the preview via NEXT_PUBLIC_DISABLE_AUTH=true so no
 * credential dance is required.
 *
 * Output:
 *   scripts/.preview/calls-list.png
 *   scripts/.preview/calls-detail.png
 *
 * Usage:
 *   npx tsx scripts/verify-calls-preview.ts
 */

import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const PREVIEW_BASE =
  process.env.PREVIEW_URL ??
  'https://ai-enablement-git-gregory-redesign-pa-5dc926-drakeynes-projects.vercel.app'

const OUT_DIR = path.join(process.cwd(), 'scripts', '.preview')

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })

  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      // Vercel sometimes serves cached HTML; force-clear cache so each
      // run gets the latest deploy. JS bundles cache separately and
      // get fresh hashes on each deploy.
      extraHTTPHeaders: { 'Cache-Control': 'no-cache' },
    })
    const page = await context.newPage()

    // --- /calls list ---
    console.log(`[verify] GET ${PREVIEW_BASE}/calls`)
    await page.goto(`${PREVIEW_BASE}/calls`, { waitUntil: 'networkidle' })
    // Wait for the SSR'd rows to actually render. The page renders rows
    // synchronously, so a presence check is enough.
    await page.waitForSelector('table tbody tr', { timeout: 30_000 })
    const rowCount = await page.locator('table tbody tr').count()
    console.log(`[verify] list: ${rowCount} rows rendered`)
    const listPath = path.join(OUT_DIR, 'calls-list.png')
    // Viewport-only (1440×900 baseline) — matches the design mock's
    // canvas so visual comparison reads as a like-for-like.
    await page.screenshot({ path: listPath })
    console.log(`[verify] wrote ${listPath}`)

    // --- /calls/[id] detail (first row) ---
    const firstRowLink = page.locator('table tbody tr a').first()
    const href = await firstRowLink.getAttribute('href')
    if (!href) {
      console.error('[verify] first row link has no href; cannot open detail')
      process.exitCode = 1
      return
    }
    console.log(`[verify] GET ${PREVIEW_BASE}${href}`)
    await page.goto(`${PREVIEW_BASE}${href}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1', { timeout: 30_000 })
    const detailPath = path.join(OUT_DIR, 'calls-detail.png')
    await page.screenshot({ path: detailPath })
    console.log(`[verify] wrote ${detailPath}`)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
