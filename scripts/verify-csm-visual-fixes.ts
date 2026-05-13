/**
 * Playwright visual-verification harness for the Primary CSM visual
 * polish + list-page editability spec.
 *
 * Loads the preview deployment at /clients, screenshots the list (with
 * a focused crop on the Primary CSM column), opens the first row's
 * detail page, screenshots the Details box, hovers + clicks the new
 * editable Primary CSM cell to demonstrate the affordance + dropdown.
 *
 * Does NOT pick a new CSM — that would write to the live Supabase. The
 * persistence step belongs to Drake's gate (c) manual verification.
 *
 * Also measures + prints the rendered height of each Details-box row
 * so the Primary CSM compactness fix can be objectively compared to its
 * siblings (Email / Phone / Country / ...).
 *
 * Output:
 *   scripts/.preview/csm-list-full.png
 *   scripts/.preview/csm-list-cropped.png
 *   scripts/.preview/csm-detail-box.png
 *   scripts/.preview/csm-detail-hover.png
 *   scripts/.preview/csm-detail-dropdown.png
 *
 * Usage:
 *   npx --yes tsx scripts/verify-csm-visual-fixes.ts
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

    // --- /clients list ---
    console.log(`[verify] GET ${PREVIEW_BASE}/clients`)
    await page.goto(`${PREVIEW_BASE}/clients`, { waitUntil: 'networkidle' })
    await page.waitForSelector('table tbody tr', { timeout: 30_000 })
    const rowCount = await page.locator('table tbody tr').count()
    console.log(`[verify] list: ${rowCount} rows rendered`)

    const listFullPath = path.join(OUT_DIR, 'csm-list-full.png')
    await page.screenshot({ path: listFullPath, fullPage: false })
    console.log(`[verify] wrote ${listFullPath}`)

    // Crop on the Primary CSM column (4th column, width 140px per
    // clients-table.tsx). Compute the column's bounding box and clip.
    const primaryCsmTh = page.locator('thead th').nth(3)
    const thBox = await primaryCsmTh.boundingBox()
    if (thBox) {
      const listCropPath = path.join(OUT_DIR, 'csm-list-cropped.png')
      await page.screenshot({
        path: listCropPath,
        clip: {
          x: Math.max(0, thBox.x - 8),
          y: thBox.y - 8,
          width: thBox.width + 16,
          height: Math.min(800, 60 + 60 * Math.min(10, rowCount)),
        },
      })
      console.log(`[verify] wrote ${listCropPath}`)
    }

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

    // Measure rendered heights of every Details-box row so we can compare
    // Primary CSM to its plain-text siblings objectively.
    const rowHeights = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.geg-data-row'))
      return rows.map((r) => {
        const k = r.querySelector('.geg-data-k')?.textContent?.trim() ?? '?'
        const rect = (r as HTMLElement).getBoundingClientRect()
        return { key: k, height: Math.round(rect.height) }
      })
    })
    console.log('[verify] Details-box row heights:', JSON.stringify(rowHeights))

    // Screenshot the Details box specifically (left column, top box).
    const detailsBox = page.locator('.geg-gold-box').first()
    const detailsBoxPath = path.join(OUT_DIR, 'csm-detail-box.png')
    await detailsBox.screenshot({ path: detailsBoxPath })
    console.log(`[verify] wrote ${detailsBoxPath}`)

    // Hover over the Primary CSM value's editable display cell.
    // It's the .geg-editable-display in the same row as the "Primary CSM" label.
    const primaryCsmRow = page.locator('.geg-data-row', {
      has: page.locator('.geg-data-k', { hasText: 'Primary CSM' }),
    })
    const primaryCsmEditable = primaryCsmRow.locator('.geg-editable-display')
    await primaryCsmEditable.hover()
    await page.waitForTimeout(200) // let the hover transition land
    const hoverPath = path.join(OUT_DIR, 'csm-detail-hover.png')
    await detailsBox.screenshot({ path: hoverPath })
    console.log(`[verify] wrote ${hoverPath}`)

    // Click to open the dropdown, screenshot the open state.
    await primaryCsmEditable.click()
    await page.waitForTimeout(200)
    const dropdownPath = path.join(OUT_DIR, 'csm-detail-dropdown.png')
    await detailsBox.screenshot({ path: dropdownPath })
    console.log(`[verify] wrote ${dropdownPath}`)

    // Inspect the open <select> to confirm omitEmptyOption took effect.
    const selectOptions = await page.evaluate(() => {
      const sel = document.querySelector('.geg-data-row select.geg-select')
      if (!sel) return null
      return Array.from(sel.querySelectorAll('option')).map((o) => ({
        value: o.value,
        label: o.textContent,
      }))
    })
    console.log(
      '[verify] Primary CSM dropdown options:',
      JSON.stringify(selectOptions),
    )
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
