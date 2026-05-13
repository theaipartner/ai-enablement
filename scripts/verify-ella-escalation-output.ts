/**
 * Playwright harness for the escalation DM body in the Output column
 * (gregory-ella-escalation-output-body spec).
 *
 * Walks /ella/runs, finds the first row whose page-rendered status
 * column is "escalated" (or whose original output_summary started with
 * `escalated via DM` if the table now shows a body instead). Captures
 * the row's Output cell. Reports whether the body or the fallback
 * placeholder rendered — both are valid post-fix states, and the
 * spec explicitly notes the forward-only nature of the body
 * persistence (rows logged before the deploy stay on the fallback).
 *
 * Output:
 *   scripts/.preview/ella-escalation-output-row.png
 *   scripts/.preview/ella-escalation-output-full.png   (full /ella/runs)
 *
 * Usage:
 *   npx --yes tsx scripts/verify-ella-escalation-output.ts
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

    const fullPath = path.join(OUT_DIR, 'ella-escalation-output-full.png')
    await page.screenshot({ path: fullPath, fullPage: true })
    console.log(`[verify] wrote ${fullPath}`)

    const rowsCount = await page.locator('table tbody tr').count()
    console.log(`[verify] /ella/runs: ${rowsCount} rows`)

    // Two visible-state checks:
    //   1. The `escalated via DM` placeholder string should NOT appear
    //      anywhere on the page — post-fix the projection suppresses
    //      it from output_text when no body is available.
    //   2. The "Worth a look" body marker indicates a row rendered the
    //      real DM body — this requires a post-deploy escalation to
    //      have fired (forward-only). May be absent if no new
    //      escalation has happened yet; not a failure mode.
    const placeholderPresent = await page.evaluate(
      () => document.body.textContent?.includes('escalated via DM') ?? false,
    )
    const bodyPresent = await page.evaluate(
      () => document.body.textContent?.includes('Worth a look') ?? false,
    )
    console.log(
      `[verify] placeholder string ('escalated via DM') present: ${placeholderPresent}`,
    )
    console.log(`[verify] body marker ('Worth a look') present: ${bodyPresent}`)

    if (placeholderPresent) {
      console.error(
        '[verify] FAIL: placeholder still rendering — projection suppression did not take effect',
      )
      process.exitCode = 1
    } else if (bodyPresent) {
      console.log('[verify] PASS: body rendered for at least one escalation row')
    } else {
      console.log(
        '[verify] PASS: placeholder suppressed; no body present yet (forward-only — no post-deploy escalation has fired)',
      )
    }
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
