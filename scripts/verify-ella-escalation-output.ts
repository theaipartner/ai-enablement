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
    await page.screenshot({ path: fullPath, fullPage: false })
    console.log(`[verify] wrote ${fullPath}`)

    // Walk rows; first whose Status pill contains "escalated" is the
    // target. The Status column index in EllaRunsTable is the cell
    // immediately before the Output cell.
    const rowsCount = await page.locator('table tbody tr').count()
    console.log(`[verify] /ella/runs: ${rowsCount} rows`)

    let targetIdx = -1
    for (let i = 0; i < Math.min(50, rowsCount); i++) {
      const row = page.locator('table tbody tr').nth(i)
      const statusText = await row.evaluate((el) => {
        // Read each cell's text; find one with "escalated" (case-insensitive).
        const cells = Array.from(el.querySelectorAll('td'))
        return cells.map((c) => (c.textContent ?? '').trim()).join(' | ')
      })
      if (/escalated/i.test(statusText)) {
        targetIdx = i
        console.log(
          `[verify] escalation row at index ${i}: ${statusText.slice(0, 200)}`,
        )
        break
      }
    }

    if (targetIdx === -1) {
      console.log(
        '[verify] no escalation rows visible on /ella/runs — fallback / body cannot be demonstrated in this preview',
      )
      return
    }

    // Screenshot just the row. Scroll into view first so the clip
    // box lands inside the viewport.
    const targetRow = page.locator('table tbody tr').nth(targetIdx)
    await targetRow.scrollIntoViewIfNeeded()
    await page.waitForTimeout(150)
    const rowPath = path.join(OUT_DIR, 'ella-escalation-output-row.png')
    await targetRow.screenshot({ path: rowPath })
    console.log(`[verify] wrote ${rowPath}`)

    // Probe the row's Output text — distinguish fallback ("—") vs body.
    const outputText = await targetRow.evaluate((el) => {
      const cells = Array.from(el.querySelectorAll('td'))
      // Output is one of the wider text cells; pick the longest one
      // matching neither the status pill nor the numeric/timestamp cells.
      return cells
        .map((c) => (c.textContent ?? '').trim())
        .reduce((a, b) => (a.length > b.length ? a : b), '')
    })
    console.log(
      `[verify] target row's longest cell text (${outputText.length} chars): ${outputText.slice(0, 200)}`,
    )
    if (outputText.includes('Worth a look') || outputText.includes('Ella decided to escalate')) {
      console.log('[verify] BODY rendered — new audit payload reached the row')
    } else if (outputText === '—' || outputText.length < 3) {
      console.log('[verify] FALLBACK rendered — no body in audit (likely a pre-deploy escalation)')
    } else {
      console.log('[verify] unexpected output content; check screenshot')
    }
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
