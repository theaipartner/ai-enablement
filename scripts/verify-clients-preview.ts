/**
 * Playwright visual-verification harness for the Clients redesign.
 *
 * Loads the preview's /clients list, picks the first client in the
 * table, opens its detail page, screenshots each at the 1440 baseline.
 * Auth bypass on the preview removes the credential dance.
 *
 * Output:
 *   scripts/.preview/clients-list.png
 *   scripts/.preview/clients-detail.png
 *
 * Usage:
 *   npx --yes tsx scripts/verify-clients-preview.ts
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
      extraHTTPHeaders: { 'Cache-Control': 'no-cache' },
    })
    const page = await context.newPage()

    // --- /clients list ---
    console.log(`[verify] GET ${PREVIEW_BASE}/clients`)
    await page.goto(`${PREVIEW_BASE}/clients`, { waitUntil: 'networkidle' })
    await page.waitForSelector('table tbody tr', { timeout: 30_000 })
    const rowCount = await page.locator('table tbody tr').count()
    console.log(`[verify] list: ${rowCount} rows rendered`)

    // Computed border style dump — keeps the divider-rendering bug
    // from the Calls redesign permanently observable from the harness.
    const borders = await page.evaluate(() => {
      const td = document.querySelector('tbody tr td')
      if (!td) return null
      const cs = window.getComputedStyle(td)
      return {
        borderBottomColor: cs.borderBottomColor,
        borderBottomWidth: cs.borderBottomWidth,
        backgroundColor: cs.backgroundColor,
      }
    })
    console.log('[verify] td border:', JSON.stringify(borders))

    const listPath = path.join(OUT_DIR, 'clients-list.png')
    await page.screenshot({ path: listPath })
    console.log(`[verify] wrote ${listPath}`)

    // --- /clients/[id] detail ---
    const firstLink = page.locator('table tbody tr a').first()
    const href = await firstLink.getAttribute('href')
    if (!href) {
      console.error('[verify] no detail link found on first row')
      process.exitCode = 1
      return
    }
    console.log(`[verify] GET ${PREVIEW_BASE}${href}`)
    await page.goto(`${PREVIEW_BASE}${href}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1', { timeout: 30_000 })
    const detailPath = path.join(OUT_DIR, 'clients-detail.png')
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
