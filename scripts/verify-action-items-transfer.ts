/**
 * Playwright visual-verification harness for the action items transfer
 * fix (gregory-action-items-transfer-fix spec).
 *
 * Read-only verification:
 *   1. Navigate to /calls list, pick first call with action items.
 *   2. Screenshot the call's Action items box.
 *   3. Extract the rendered action-item descriptions.
 *   4. Navigate to that call's primary client at /clients/[id].
 *   5. Screenshot the Action items box.
 *   6. Extract the rendered open action-item descriptions.
 *   7. Confirm: every item from step 3 (assuming status='open') appears
 *      in step 6.
 *
 * Does NOT click Confirm or check the completion checkbox — those would
 * write to the shared preview Supabase. Visual verification is on the
 * data-shape parity, not on the write flow itself. The Confirm flow's
 * shape is independent of this bug (the bug is in the read path).
 *
 * Output:
 *   scripts/.preview/ai-transfer-call.png
 *   scripts/.preview/ai-transfer-client.png
 *
 * Usage:
 *   npx --yes tsx scripts/verify-action-items-transfer.ts
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

    // --- Find a call with action items ---
    console.log(`[verify] GET ${PREVIEW_BASE}/calls`)
    await page.goto(`${PREVIEW_BASE}/calls`, { waitUntil: 'networkidle' })
    await page.waitForSelector('table tbody tr', { timeout: 30_000 })
    const callRows = await page.locator('table tbody tr').count()
    console.log(`[verify] /calls: ${callRows} rows`)

    // Walk rows; for each, open the call, count action items, stop at
    // the first one with items.
    let targetCallHref: string | null = null
    let targetCallTitle: string | null = null
    let targetClientHref: string | null = null
    let callItemDescriptions: string[] = []
    let maxScan = Math.min(20, callRows)
    for (let i = 0; i < maxScan; i++) {
      const rowLink = page.locator('table tbody tr').nth(i).locator('a').first()
      const href = await rowLink.getAttribute('href')
      const title = (await rowLink.textContent())?.trim() ?? ''
      if (!href) continue
      console.log(`[verify] probing call ${i}: ${href}`)
      await page.goto(`${PREVIEW_BASE}${href}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('h1', { timeout: 30_000 })

      // Action items box: read the inputs (each item is rendered as
      // an editable <input>).
      const aiInputs = page.locator('.geg-action-item input')
      const count = await aiInputs.count()
      if (count > 0) {
        callItemDescriptions = []
        for (let j = 0; j < count; j++) {
          const val = await aiInputs.nth(j).inputValue()
          callItemDescriptions.push(val)
        }
        // Extract client href from the Data box's Client field.
        const clientLink = page.locator('.geg-link').first()
        const clientHref = await clientLink.getAttribute('href')
        if (clientHref && clientHref.startsWith('/clients/')) {
          targetCallHref = href
          targetCallTitle = title
          targetClientHref = clientHref
          break
        }
      }
      await page.goBack({ waitUntil: 'networkidle' })
    }

    if (!targetCallHref || !targetClientHref) {
      console.error(
        '[verify] could not find a call with action items + primary client',
      )
      process.exitCode = 1
      return
    }
    console.log(
      `[verify] target call: ${targetCallTitle} ${targetCallHref} → ${targetClientHref}`,
    )
    console.log(
      `[verify] call action items (${callItemDescriptions.length}):`,
      JSON.stringify(callItemDescriptions),
    )

    // Screenshot the call detail page with the action items box visible.
    await page.goto(`${PREVIEW_BASE}${targetCallHref}`, {
      waitUntil: 'networkidle',
    })
    await page.waitForSelector('.geg-action-item input', { timeout: 30_000 })
    const callShotPath = path.join(OUT_DIR, 'ai-transfer-call.png')
    await page.screenshot({ path: callShotPath })
    console.log(`[verify] wrote ${callShotPath}`)

    // Navigate to the client detail page.
    console.log(`[verify] GET ${PREVIEW_BASE}${targetClientHref}`)
    await page.goto(`${PREVIEW_BASE}${targetClientHref}`, {
      waitUntil: 'networkidle',
    })
    await page.waitForSelector('h1', { timeout: 30_000 })

    // Action items on the client page render via ActionItemsList — look
    // for the descriptions rendered in the right column's box. The
    // structure is items list with description text + linked source call.
    const clientItemDescriptions = await page.evaluate(() => {
      // The Action items box has the heading "Action items" — find that
      // box and read each item's primary text. Items are in a <ul>
      // or list-shaped container; descriptions are the main text node.
      const boxes = Array.from(document.querySelectorAll('.geg-gold-box'))
      const actionBox = boxes.find((b) => {
        const h = b.querySelector('.geg-gold-box-header h3')
        return h?.textContent?.includes('Action items')
      })
      if (!actionBox) return []
      // Read non-link text from each direct item row, excluding the
      // "↳ from <call title>" trail line and the box header.
      const rows = Array.from(
        actionBox.querySelectorAll('[data-action-item-id], li, .geg-action-item-row'),
      )
      if (rows.length === 0) {
        // Fall back: any element with a click target that looks like a
        // description. Easier: grab all text nodes in the box body and
        // split on the source-call trail.
        const body = actionBox.querySelector('div:not(.geg-gold-box-header)')
        if (!body) return []
        return Array.from(body.children).map((c) => {
          return (c.textContent ?? '').trim()
        })
      }
      return rows.map((r) => (r.textContent ?? '').trim())
    })
    console.log(
      `[verify] client action items (${clientItemDescriptions.length}):`,
      JSON.stringify(clientItemDescriptions),
    )

    const clientShotPath = path.join(OUT_DIR, 'ai-transfer-client.png')
    await page.screenshot({ path: clientShotPath })
    console.log(`[verify] wrote ${clientShotPath}`)

    // Cross-check: every call item should appear as a substring in some
    // client item row (the client renders description + source call).
    const matched: string[] = []
    const missed: string[] = []
    for (const callItem of callItemDescriptions) {
      const normalized = callItem.trim()
      if (normalized === '') continue
      const found = clientItemDescriptions.some((c) =>
        c.includes(normalized.slice(0, Math.min(40, normalized.length))),
      )
      if (found) matched.push(normalized)
      else missed.push(normalized)
    }
    console.log(
      `[verify] match summary: ${matched.length} matched, ${missed.length} missed`,
    )
    if (missed.length > 0) {
      console.log(`[verify] MISSED items:`, JSON.stringify(missed))
      process.exitCode = 1
    } else {
      console.log(`[verify] ALL call items appear on client page ✓`)
    }
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
