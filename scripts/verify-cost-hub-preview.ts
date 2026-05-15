/**
 * Playwright verification harness for /cost-hub.
 *
 * Exercises the admin cost-hub page end-to-end against a deployment
 * with auth disabled (NEXT_PUBLIC_DISABLE_AUTH=true — set on Vercel
 * preview deploys; for local runs, start `next dev` with that env and
 * point PREVIEW_URL at http://localhost:3000).
 *
 * Steps:
 *   1. Visit /cost-hub, assert it renders without error.
 *   2. Assert the five Anthropic bucket boxes are present.
 *   3. Assert the "Total this month" box renders a dollar amount.
 *   4. Add a test monthly subscription, assert it appears, delete it.
 *   5. Add a test one-off extra, assert it appears, delete it.
 *   6. Screenshot to scripts/.preview/cost-hub.png.
 *
 * Note: the delete is a SOFT archive (the row stays in the table with
 * archived_at set). The test rows use a clearly-marked provider /
 * description so they're identifiable in SQL if cleanup is ever wanted.
 *
 * Usage:
 *   PREVIEW_URL=http://localhost:3000 npx --yes tsx scripts/verify-cost-hub-preview.ts
 */

import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const PREVIEW_BASE = process.env.PREVIEW_URL ?? 'http://localhost:3000'
const OUT_DIR = path.join(process.cwd(), 'scripts', '.preview')

// Marker strings so the verifier's test rows are SQL-identifiable.
const TEST_SUB_PROVIDER = `__verify_sub_${Date.now()}`
const TEST_EXTRA_DESC = `__verify_extra_${Date.now()}`

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })

  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { 'Cache-Control': 'no-cache' },
    })
    const page = await context.newPage()

    // --- 1. Page renders ---
    console.log(`[verify] GET ${PREVIEW_BASE}/cost-hub`)
    await page.goto(`${PREVIEW_BASE}/cost-hub`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1', { timeout: 30_000 })
    const h1 = await page.locator('h1').first().textContent()
    console.log(`[verify] h1: ${h1?.trim()}`)
    if (!h1 || !h1.includes('Cost Hub')) {
      throw new Error(`unexpected h1: ${h1}`)
    }

    // --- 2. Five Anthropic bucket boxes ---
    const bucketLabels = [
      'ELLA SONNET',
      'ELLA HAIKU',
      'CALL REVIEW SONNET',
      'CALL REVIEW HAIKU',
      'GREGORY BRAIN SONNET',
    ]
    for (const label of bucketLabels) {
      const found = await page
        .locator(`.geg-gold-box-header h3:has-text("${label}")`)
        .count()
      if (found < 1) {
        throw new Error(`bucket box missing: ${label}`)
      }
      console.log(`[verify] bucket box present: ${label}`)
    }

    // --- 3. Total this month renders a dollar amount ---
    const totalBox = page
      .locator('.geg-gold-box', { hasText: 'TOTAL · THIS MONTH' })
      .first()
    const totalText = await totalBox.textContent()
    if (!totalText || !/\$\d/.test(totalText)) {
      throw new Error(`total-this-month box has no $ amount: ${totalText}`)
    }
    console.log('[verify] total-this-month box renders a dollar amount')

    // --- 4. Add + delete a monthly subscription ---
    const subBox = page
      .locator('.geg-gold-box', { hasText: 'MONTHLY · SUBSCRIPTIONS' })
      .first()

    // Two-months-ago date for the backdated sub.
    const now = new Date()
    const backMonth = new Date(now.getFullYear(), now.getMonth() - 2, 15)
    const backDated = `${backMonth.getFullYear()}-${String(
      backMonth.getMonth() + 1,
    ).padStart(2, '0')}-15`
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
      2,
      '0',
    )}-${String(now.getDate()).padStart(2, '0')}`

    const TEST_SUB_BACKDATED = `${TEST_SUB_PROVIDER}_backdated`

    // 4a. Backdated sub (effective_from = ~2 months ago). Appears in
    // the active table because backdated ≤ today.
    await subBox.locator('input[placeholder="Provider"]').fill(TEST_SUB_BACKDATED)
    await subBox.locator('input[placeholder="Monthly cost USD"]').fill('20.00')
    await subBox.locator('input[placeholder="Notes (optional)"]').fill('backdated')
    await subBox.locator('input[aria-label="Effective from"]').fill(backDated)
    await subBox.locator('button[type="submit"]:has-text("Add")').click()
    await page.waitForSelector(`text=${TEST_SUB_BACKDATED}`, { timeout: 15_000 })
    console.log(
      `[verify] backdated subscription added (effective_from=${backDated}) + visible in active table`,
    )

    // 4b. Today-dated sub. Also appears in the active table.
    await subBox.locator('input[placeholder="Provider"]').fill(TEST_SUB_PROVIDER)
    await subBox.locator('input[placeholder="Monthly cost USD"]').fill('12.34')
    await subBox.locator('input[placeholder="Notes (optional)"]').fill('verify')
    await subBox.locator('input[aria-label="Effective from"]').fill(today)
    await subBox.locator('button[type="submit"]:has-text("Add")').click()
    await page.waitForSelector(`text=${TEST_SUB_PROVIDER}`, { timeout: 15_000 })
    console.log(
      `[verify] today-dated subscription added (effective_from=${today}) + visible in active table`,
    )

    // Cost-rollup correctness (backdated sub counts in 2-months-ago
    // history, today-dated sub does NOT) is validated via SQL
    // inspection in the report — the History view's per-month totals
    // are server-rendered and fiddly to assert through Playwright.

    // 4c. Delete both (soft-archive cleanup).
    for (const prov of [TEST_SUB_BACKDATED, TEST_SUB_PROVIDER]) {
      page.once('dialog', (d) => d.accept())
      const subRow = subBox.locator('div', { hasText: prov }).last()
      await subRow.locator(`button[aria-label="Delete ${prov}"]`).click()
      await page.waitForSelector(`text=${prov}`, {
        state: 'detached',
        timeout: 15_000,
      })
    }
    console.log('[verify] both test subscriptions deleted (soft-archived)')

    // --- 5. Add + delete a one-off extra ---
    const extraBox = page
      .locator('.geg-gold-box', { hasText: 'ONE-OFF · EXTRAS' })
      .first()
    await extraBox
      .locator('input[placeholder="Description"]')
      .fill(TEST_EXTRA_DESC)
    await extraBox.locator('input[placeholder="Cost USD"]').fill('7.89')
    await extraBox.locator('button[type="submit"]:has-text("Add")').click()
    await page.waitForSelector(`text=${TEST_EXTRA_DESC}`, { timeout: 15_000 })
    console.log('[verify] test extra added + visible')

    page.once('dialog', (d) => d.accept())
    const extraRow = extraBox
      .locator('div', { hasText: TEST_EXTRA_DESC })
      .last()
    await extraRow
      .locator(`button[aria-label="Delete ${TEST_EXTRA_DESC}"]`)
      .click()
    await page.waitForSelector(`text=${TEST_EXTRA_DESC}`, {
      state: 'detached',
      timeout: 15_000,
    })
    console.log('[verify] test extra deleted (soft-archived)')

    // --- 6. Screenshot ---
    const shotPath = path.join(OUT_DIR, 'cost-hub.png')
    await page.screenshot({ path: shotPath, fullPage: true })
    console.log(`[verify] wrote ${shotPath}`)
    console.log('[verify] PASS')
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('[verify] FAIL')
  console.error(err)
  process.exit(1)
})
