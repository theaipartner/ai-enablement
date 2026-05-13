/**
 * Playwright visual-verification harness for the Send-to-Slack action
 * items button (gregory-send-to-slack-action-items spec).
 *
 * SAFETY: this script DOES NOT click the Send button by default. The
 * spec hard-stop #3 forbids running with SLACK_DRY_RUN unset on the
 * preview — a click would send a real Slack message to a real client
 * channel. Pass --allow-send to opt into clicking; the runner is
 * expected to confirm preview env has SLACK_DRY_RUN=true before doing
 * so. Without --allow-send, only idle + disabled visuals are captured.
 *
 * What it captures (always):
 *   - The Action items box with the button in idle state ("Send to
 *     Slack →") for a client with open items + a mapped channel.
 *   - The Action items box with the button disabled for a client
 *     without a mapped channel.
 *
 * What it captures (only with --allow-send):
 *   - Sending… transition.
 *   - Sent ✓ flash.
 *   - Post-send state (button gone).
 *
 * Output:
 *   scripts/.preview/send-to-slack-idle.png
 *   scripts/.preview/send-to-slack-disabled.png
 *   scripts/.preview/send-to-slack-sending.png   (--allow-send only)
 *   scripts/.preview/send-to-slack-sent.png      (--allow-send only)
 *   scripts/.preview/send-to-slack-gone.png      (--allow-send only)
 *
 * Usage:
 *   npx --yes tsx scripts/verify-send-to-slack.ts
 *   npx --yes tsx scripts/verify-send-to-slack.ts --allow-send  # gated
 */

import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const PREVIEW_BASE =
  process.env.PREVIEW_URL ??
  'https://ai-enablement-git-gregory-csm-visual-fixes-drakeynes-projects.vercel.app'

const OUT_DIR = path.join(process.cwd(), 'scripts', '.preview')

const ALLOW_SEND = process.argv.includes('--allow-send')

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })

  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { 'Cache-Control': 'no-cache' },
    })
    const page = await context.newPage()

    // Find a client with open action items AND a mapped Slack channel.
    // Strategy: walk /clients table, open each, check Action items box +
    // probe the button's disabled state. Stop at the first that fits.
    console.log(`[verify] GET ${PREVIEW_BASE}/clients`)
    await page.goto(`${PREVIEW_BASE}/clients`, { waitUntil: 'networkidle' })
    await page.waitForSelector('table tbody tr', { timeout: 30_000 })

    let mappedClientHref: string | null = null
    let unmappedClientHref: string | null = null
    const maxScan = 30
    for (let i = 0; i < maxScan; i++) {
      if (mappedClientHref && unmappedClientHref) break
      const rowLink = page.locator('table tbody tr').nth(i).locator('a').first()
      const href = await rowLink.getAttribute('href')
      if (!href) continue
      await page.goto(`${PREVIEW_BASE}${href}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('h1', { timeout: 30_000 })

      const probe = await page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll('.geg-gold-box'))
        const actionBox = boxes.find((b) =>
          b
            .querySelector('.geg-gold-box-header h3')
            ?.textContent?.includes('Action items'),
        )
        if (!actionBox) return { hasItems: false, sendDisabled: false }
        const sendBtn = Array.from(actionBox.querySelectorAll('button')).find(
          (b) => (b.textContent ?? '').includes('Send to Slack'),
        ) as HTMLButtonElement | undefined
        // If there are items, the box shows checkboxes; if not, it
        // shows "No open action items." text instead of the list.
        const hasItems =
          actionBox.querySelector('.geg-checkbox') !== null &&
          sendBtn !== undefined
        const sendDisabled = sendBtn?.disabled === true
        return { hasItems, sendDisabled }
      })

      if (probe.hasItems && !probe.sendDisabled && !mappedClientHref) {
        mappedClientHref = href
        console.log(`[verify] mapped client (button enabled): ${href}`)
      }
      if (probe.hasItems && probe.sendDisabled && !unmappedClientHref) {
        unmappedClientHref = href
        console.log(`[verify] unmapped client (button disabled): ${href}`)
      }
      if (!probe.hasItems) {
        // Continue scanning; this client has no open items.
      }
      await page.goBack({ waitUntil: 'networkidle' })
    }

    if (!mappedClientHref) {
      console.error(
        '[verify] could not find a client with items + mapped Slack channel',
      )
      process.exitCode = 1
      return
    }

    // --- Idle state ---
    await page.goto(`${PREVIEW_BASE}${mappedClientHref}`, {
      waitUntil: 'networkidle',
    })
    await page.waitForSelector('.geg-checkbox', { timeout: 30_000 })
    const idlePath = path.join(OUT_DIR, 'send-to-slack-idle.png')
    const actionBox = page
      .locator('.geg-gold-box')
      .filter({
        has: page.locator('.geg-gold-box-header h3', { hasText: 'Action items' }),
      })
      .first()
    await actionBox.screenshot({ path: idlePath })
    console.log(`[verify] wrote ${idlePath}`)

    // --- Disabled state (if found) ---
    if (unmappedClientHref) {
      await page.goto(`${PREVIEW_BASE}${unmappedClientHref}`, {
        waitUntil: 'networkidle',
      })
      await page.waitForSelector('.geg-checkbox', { timeout: 30_000 })
      const disabledPath = path.join(OUT_DIR, 'send-to-slack-disabled.png')
      const disabledBox = page
        .locator('.geg-gold-box')
        .filter({
          has: page.locator('.geg-gold-box-header h3', {
            hasText: 'Action items',
          }),
        })
        .first()
      await disabledBox.screenshot({ path: disabledPath })
      console.log(`[verify] wrote ${disabledPath}`)
    } else {
      console.log(
        '[verify] no client found with items + unmapped channel; disabled-state screenshot skipped',
      )
    }

    // --- Send flow (gated) ---
    if (!ALLOW_SEND) {
      console.log(
        '[verify] --allow-send not set; skipping send-flow screenshots. ' +
          'Re-run with --allow-send AFTER confirming SLACK_DRY_RUN=true ' +
          'on Vercel preview env.',
      )
      return
    }

    console.log('[verify] --allow-send set; proceeding with send flow')
    await page.goto(`${PREVIEW_BASE}${mappedClientHref}`, {
      waitUntil: 'networkidle',
    })
    await page.waitForSelector('.geg-checkbox', { timeout: 30_000 })
    const sendBtn = page.locator('button', { hasText: 'Send to Slack' }).first()
    await sendBtn.click()
    await page.waitForTimeout(150)
    const sendingPath = path.join(OUT_DIR, 'send-to-slack-sending.png')
    await actionBox.screenshot({ path: sendingPath })
    console.log(`[verify] wrote ${sendingPath}`)

    // Wait for either "Sent ✓" or "Failed" state.
    await page.waitForFunction(
      () => {
        const btns = Array.from(document.querySelectorAll('button'))
        return btns.some((b) => {
          const t = b.textContent ?? ''
          return t.includes('Sent') || t.includes('Failed')
        })
      },
      { timeout: 10_000 },
    )
    const sentPath = path.join(OUT_DIR, 'send-to-slack-sent.png')
    await actionBox.screenshot({ path: sentPath })
    console.log(`[verify] wrote ${sentPath}`)

    // Wait for the button to disappear (~3s in the state machine).
    await page.waitForTimeout(4_000)
    const gonePath = path.join(OUT_DIR, 'send-to-slack-gone.png')
    await actionBox.screenshot({ path: gonePath })
    console.log(`[verify] wrote ${gonePath}`)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
