/**
 * Playwright visual-verification harness for the Ella pre-redesign
 * fixes (gregory-ella-pre-redesign-fixes spec).
 *
 * Covers fixes #2-#5 (#1 is hard-stopped — see the report). Walks
 * /ella/runs, finds a run with substantial message content, captures:
 *   - The triggering message section (collapsed, then expanded)
 *   - Ella's response section (collapsed, then expanded if long)
 *   - The detail page as a whole, confirming Surrounding messages is gone
 *
 * Read-only. No clicks beyond "Show more" toggles, which are
 * client-side and don't mutate any data.
 *
 * Output:
 *   scripts/.preview/ella-triggering-collapsed.png
 *   scripts/.preview/ella-triggering-expanded.png
 *   scripts/.preview/ella-response-collapsed.png
 *   scripts/.preview/ella-response-expanded.png
 *   scripts/.preview/ella-detail-no-surrounding.png
 *
 * Usage:
 *   npx --yes tsx scripts/verify-ella-pre-redesign-fixes.ts
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
      viewport: { width: 1440, height: 1200 },
      extraHTTPHeaders: { 'Cache-Control': 'no-cache' },
    })
    const page = await context.newPage()

    console.log(`[verify] GET ${PREVIEW_BASE}/ella/runs`)
    await page.goto(`${PREVIEW_BASE}/ella/runs`, { waitUntil: 'networkidle' })
    await page.waitForSelector('table tbody tr', { timeout: 30_000 })

    // Walk the first N rows, open each, probe for a substantial triggering
    // message (length > 500 chars to trigger truncation). Stop at first hit.
    let targetHref: string | null = null
    const maxScan = 20
    for (let i = 0; i < maxScan; i++) {
      const link = page.locator('table tbody tr').nth(i).locator('a').first()
      const href = await link.getAttribute('href')
      if (!href || !href.startsWith('/ella/runs/')) continue
      await page.goto(`${PREVIEW_BASE}${href}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('h1', { timeout: 30_000 })

      const probe = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'))
        const showMore = buttons.find((b) =>
          (b.textContent ?? '').includes('Show more'),
        )
        return { hasShowMore: showMore !== undefined }
      })
      if (probe.hasShowMore) {
        targetHref = href
        console.log(`[verify] target run (has Show more): ${href}`)
        break
      }
      await page.goBack({ waitUntil: 'networkidle' })
    }

    if (!targetHref) {
      // No long-enough message found; just capture a normal run's detail
      // page to confirm Surrounding messages is gone.
      console.log(
        '[verify] no run with long-enough messages to demo truncation; using first run',
      )
      const link = page.locator('table tbody tr').first().locator('a').first()
      const href = await link.getAttribute('href')
      if (href) {
        await page.goto(`${PREVIEW_BASE}${href}`, { waitUntil: 'networkidle' })
        await page.waitForSelector('h1', { timeout: 30_000 })
      }
    }

    // Confirm Surrounding messages section is gone (fix #5).
    const surroundingPresent = await page.evaluate(() => {
      const titles = Array.from(document.querySelectorAll('h2, h3, h4'))
      return titles.some((t) =>
        (t.textContent ?? '').includes('Surrounding messages'),
      )
    })
    console.log(
      `[verify] Surrounding messages section present: ${surroundingPresent}`,
    )
    const detailPath = path.join(OUT_DIR, 'ella-detail-no-surrounding.png')
    await page.screenshot({ path: detailPath, fullPage: true })
    console.log(`[verify] wrote ${detailPath}`)

    if (!targetHref) {
      console.log(
        '[verify] no long-message run found; truncation screenshots skipped',
      )
      return
    }

    // Capture collapsed state of both sections.
    const triggeringSection = page
      .locator('section, div')
      .filter({
        has: page.locator('h3, h2, h4', { hasText: 'Triggering message' }),
      })
      .first()
    const responseSection = page
      .locator('section, div')
      .filter({
        has: page.locator('h3, h2, h4', { hasText: "Ella's response" }),
      })
      .first()

    const triggeringCollapsedPath = path.join(
      OUT_DIR,
      'ella-triggering-collapsed.png',
    )
    await triggeringSection.screenshot({ path: triggeringCollapsedPath })
    console.log(`[verify] wrote ${triggeringCollapsedPath}`)

    const responseCollapsedPath = path.join(
      OUT_DIR,
      'ella-response-collapsed.png',
    )
    await responseSection.screenshot({ path: responseCollapsedPath })
    console.log(`[verify] wrote ${responseCollapsedPath}`)

    // Expand both, capture expanded state.
    const showMoreButtons = page.locator('button', { hasText: 'Show more' })
    const count = await showMoreButtons.count()
    console.log(`[verify] ${count} Show more buttons found`)
    for (let i = 0; i < count; i++) {
      await showMoreButtons.nth(i).click()
      await page.waitForTimeout(80)
    }

    const triggeringExpandedPath = path.join(
      OUT_DIR,
      'ella-triggering-expanded.png',
    )
    await triggeringSection.screenshot({ path: triggeringExpandedPath })
    console.log(`[verify] wrote ${triggeringExpandedPath}`)

    const responseExpandedPath = path.join(
      OUT_DIR,
      'ella-response-expanded.png',
    )
    await responseSection.screenshot({ path: responseExpandedPath })
    console.log(`[verify] wrote ${responseExpandedPath}`)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
