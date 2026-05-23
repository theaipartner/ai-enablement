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
 *   4. Add + Cancel a monthly subscription (Part 2/4 invariants):
 *        4a. Backdated sub → appears in active table.
 *        4b. Today-dated sub → appears in active table.
 *        4c. Capture baseline total, add a today-dated test sub of
 *            known cost ($77.77), assert the total moved by exactly
 *            that delta.
 *        4d. Cancel the test sub via the Cancel button (soft archive).
 *            Assert the row stays VISIBLE with a "Cancelled" badge
 *            AND the total is unchanged (Part 2 invariant + Q1 fix
 *            invariant from prior spec).
 *   5. Add + Remove a monthly subscription (Part 4 Remove invariant):
 *        5a. Add a test sub of known cost.
 *        5b. Remove it via × → confirm. Hard delete.
 *        5c. Assert the row is gone from the visible list AND the
 *            total dropped by exactly the test cost (NOT just by
 *            zero — Remove takes the cost out of the total).
 *   6. Add + Remove a one-off extra (extras have Remove only).
 *   7. Part 3 add-button diagnosis instrumentation. The previous
 *      investigation found no code-level bug but Drake said add still
 *      doesn't work. Capture browser console errors + network failures
 *      throughout the run and surface them in the final report.
 *   8. Screenshot to scripts/.preview/cost-hub.png.
 *   9. Cleanup (try/finally): hard-DELETE every `__verify_*` test row
 *      regardless of the step that created it, via direct Supabase
 *      admin SDK call. The preview hits PROD DB so polluted rows
 *      would otherwise inflate Drake's running total — this is the
 *      lesson from the 2026-05-23 incident where the prior verifier
 *      soft-archived its rows and they silently accumulated.
 *
 * Hard rules:
 *   - Only `__verify_*` test rows are touched in PROD DB. Real subs/
 *     extras (ElevenLabs, Claude Max, etc.) are READ-ONLY targets;
 *     the verifier never edits or removes them.
 *   - Cleanup runs in finally so a failed assertion still cleans up.
 *
 * Usage:
 *   PREVIEW_URL=https://ai-enablement-xxxx-drakeynes-projects.vercel.app \
 *   NEXT_PUBLIC_SUPABASE_URL=$SUPABASE_URL \
 *   SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY \
 *   npx --yes tsx scripts/verify-cost-hub-preview.ts
 *
 * For local runs you can source .env.local to populate both Supabase
 * envs; the PREVIEW_URL must still point at a deployed preview (or
 * `next dev`).
 */

import { chromium, type ConsoleMessage, type Page, type Request } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const PREVIEW_BASE = process.env.PREVIEW_URL ?? 'http://localhost:3000'
const OUT_DIR = path.join(process.cwd(), 'scripts', '.preview')

// Marker strings so the verifier's test rows are SQL-identifiable +
// the cleanup pass can target only test rows (never real data).
const RUN_ID = Date.now()
const TEST_SUB_PROVIDER = `__verify_sub_${RUN_ID}`
const TEST_SUB_BACKDATED = `${TEST_SUB_PROVIDER}_backdated`
const TEST_SUB_TOTAL_DELTA = `${TEST_SUB_PROVIDER}_total_delta`
const TEST_SUB_CANCEL = `${TEST_SUB_PROVIDER}_cancel_invariant`
const TEST_SUB_REMOVE = `${TEST_SUB_PROVIDER}_remove_invariant`
const TEST_EXTRA_DESC = `__verify_extra_${RUN_ID}`

// Browser-side diagnostic capture for Part 3 (add-button live diagnosis).
type Capture = {
  consoleErrors: { type: string; text: string; location?: string }[]
  pageErrors: string[]
  failedRequests: { url: string; method: string; failure: string }[]
  serverActionResponses: { url: string; status: number; statusText: string }[]
}

function makeCapture(): Capture {
  return {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    serverActionResponses: [],
  }
}

function attachCapture(page: Page, cap: Capture): void {
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      cap.consoleErrors.push({
        type: msg.type(),
        text: msg.text(),
        location: msg.location()?.url,
      })
    }
  })
  page.on('pageerror', (err) => {
    cap.pageErrors.push(`${err.name}: ${err.message}`)
  })
  page.on('requestfailed', (req: Request) => {
    cap.failedRequests.push({
      url: req.url(),
      method: req.method(),
      failure: req.failure()?.errorText ?? 'unknown',
    })
  })
  // Server actions in Next 13+ App Router POST back to the same URL
  // with a Next-Action header. Capture every POST to /cost-hub so the
  // Part 3 diagnosis can see whether the action even fired + what it
  // returned (status code).
  page.on('response', (resp) => {
    const url = resp.url()
    if (resp.request().method() === 'POST' && url.includes('/cost-hub')) {
      cap.serverActionResponses.push({
        url,
        status: resp.status(),
        statusText: resp.statusText(),
      })
    }
  })
}

function printCapture(cap: Capture, label: string): void {
  console.log(`[capture:${label}] console errors/warnings:`, cap.consoleErrors.length)
  for (const e of cap.consoleErrors) {
    console.log(`  ${e.type}: ${e.text}${e.location ? ` @ ${e.location}` : ''}`)
  }
  console.log(`[capture:${label}] page errors:`, cap.pageErrors.length)
  for (const e of cap.pageErrors) console.log(`  ${e}`)
  console.log(`[capture:${label}] failed requests:`, cap.failedRequests.length)
  for (const r of cap.failedRequests) {
    console.log(`  ${r.method} ${r.url} → ${r.failure}`)
  }
  console.log(`[capture:${label}] /cost-hub server actions:`, cap.serverActionResponses.length)
  for (const r of cap.serverActionResponses) {
    console.log(`  ${r.status} ${r.statusText}  ${r.url}`)
  }
}

// Read the "TOTAL · THIS MONTH" big-number value as a USD number.
async function readTotalThisMonthUsd(page: Page): Promise<number> {
  const totalBox = page
    .locator('.geg-gold-box', { hasText: 'TOTAL · THIS MONTH' })
    .first()
  const heading = totalBox.locator('.geg-serif').first()
  const text = (await heading.textContent()) ?? ''
  const m = text.match(/\$([\d,]+\.\d{2})/)
  if (!m) {
    throw new Error(`could not parse total-this-month dollar amount from: ${text}`)
  }
  return Number(m[1].replace(/,/g, ''))
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })

  const browser = await chromium.launch()
  const cap = makeCapture()

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { 'Cache-Control': 'no-cache' },
    })
    const page = await context.newPage()
    attachCapture(page, cap)

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
    }
    console.log('[verify] all 5 Anthropic bucket boxes present')

    // --- 3. Total this month renders a dollar amount ---
    const baselineTotal = await readTotalThisMonthUsd(page)
    console.log(`[verify] baseline total: $${baselineTotal.toFixed(2)}`)

    // --- 4. Add + Cancel a subscription (Parts 2 + 4 invariants) ---
    const subBox = page
      .locator('.geg-gold-box', { hasText: 'MONTHLY · SUBSCRIPTIONS' })
      .first()

    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
      2,
      '0',
    )}-${String(now.getDate()).padStart(2, '0')}`
    const backMonth = new Date(now.getFullYear(), now.getMonth() - 2, 15)
    const backDated = `${backMonth.getFullYear()}-${String(
      backMonth.getMonth() + 1,
    ).padStart(2, '0')}-15`

    // 4a. Backdated sub — appears in active table.
    await addSubscription(page, subBox, TEST_SUB_BACKDATED, '20.00', 'backdated', backDated)
    console.log(`[verify] 4a backdated sub added (effective_from=${backDated})`)

    // 4b. Today-dated sub — appears in active table.
    await addSubscription(page, subBox, TEST_SUB_PROVIDER, '12.34', 'verify', today)
    console.log(`[verify] 4b today-dated sub added (effective_from=${today})`)

    // 4c. Add a test sub of known cost; assert total moved by exactly that delta.
    const TOTAL_DELTA_COST = 77.77
    const totalBefore = await readTotalThisMonthUsd(page)
    await addSubscription(
      page,
      subBox,
      TEST_SUB_TOTAL_DELTA,
      TOTAL_DELTA_COST.toFixed(2),
      'delta',
      today,
    )
    const totalAfterAdd = await readTotalThisMonthUsd(page)
    assertWithin(
      totalAfterAdd,
      totalBefore + TOTAL_DELTA_COST,
      0.01,
      `4c: total should have moved by exactly $${TOTAL_DELTA_COST} (${totalBefore} → ${totalAfterAdd})`,
    )
    console.log(
      `[verify] 4c add moved total by exactly +$${TOTAL_DELTA_COST.toFixed(2)} (${totalBefore.toFixed(2)} → ${totalAfterAdd.toFixed(2)})`,
    )

    // 4d. Cancel-invariant test. Add a test sub, capture the total,
    // cancel via the Cancel button (soft-archive), assert (a) the row
    // stays VISIBLE with a "Cancelled" badge AND (b) the total is
    // unchanged. This is Part 2's sum-to-total invariant + the Q1
    // fix's mid-month-archived-counts invariant.
    const CANCEL_COST = 33.33
    const beforeCancel = await readTotalThisMonthUsd(page)
    await addSubscription(
      page,
      subBox,
      TEST_SUB_CANCEL,
      CANCEL_COST.toFixed(2),
      'cancel-invariant',
      today,
    )
    const afterAddBeforeCancel = await readTotalThisMonthUsd(page)
    assertWithin(
      afterAddBeforeCancel,
      beforeCancel + CANCEL_COST,
      0.01,
      `4d: add of cancel-test sub moved total by exactly $${CANCEL_COST}`,
    )

    // Click Cancel on the row. The Cancel button has a native confirm()
    // dialog; auto-accept it. The row should stay in the table with a
    // "Cancelled" badge.
    page.once('dialog', (d) => d.accept())
    const cancelTargetRow = subBox.locator('div', { hasText: TEST_SUB_CANCEL }).last()
    await cancelTargetRow
      .locator('button[title^="Cancel — stops next month"]')
      .click()
    // Wait for refresh + assert the badge is present + the row is
    // still in the visible list.
    await page.waitForFunction(
      (label) => {
        // The badge text "Cancelled" should appear in the row.
        const rows = Array.from(document.querySelectorAll('.geg-gold-box'))
          .find((b) => b.textContent?.includes('MONTHLY · SUBSCRIPTIONS'))
          ?.querySelectorAll('div')
        if (!rows) return false
        for (const r of Array.from(rows)) {
          if (r.textContent?.includes(label) && r.textContent?.includes('Cancelled')) {
            return true
          }
        }
        return false
      },
      TEST_SUB_CANCEL,
      { timeout: 15_000 },
    )
    const afterCancel = await readTotalThisMonthUsd(page)
    assertWithin(
      afterCancel,
      afterAddBeforeCancel,
      0.01,
      `4d cancel-invariant: total unchanged after Cancel (was ${afterAddBeforeCancel}, now ${afterCancel}). Spec Part 2: cancelled-this-month subs stay counted.`,
    )
    console.log(
      `[verify] 4d Cancel: row stays visible with "Cancelled" badge AND total unchanged ($${afterCancel.toFixed(2)})`,
    )

    // --- 5. Add + Remove a subscription (Part 4 Remove invariant) ---
    const REMOVE_COST = 44.44
    const beforeRemoveAdd = await readTotalThisMonthUsd(page)
    await addSubscription(
      page,
      subBox,
      TEST_SUB_REMOVE,
      REMOVE_COST.toFixed(2),
      'remove-invariant',
      today,
    )
    const afterRemoveAdd = await readTotalThisMonthUsd(page)
    assertWithin(
      afterRemoveAdd,
      beforeRemoveAdd + REMOVE_COST,
      0.01,
      `5: add of remove-test sub moved total by exactly $${REMOVE_COST}`,
    )

    // Click × (Remove) on the row.
    page.once('dialog', (d) => d.accept())
    const removeTargetRow = subBox.locator('div', { hasText: TEST_SUB_REMOVE }).last()
    await removeTargetRow
      .locator(`button[aria-label="Remove ${TEST_SUB_REMOVE} permanently"]`)
      .click()
    // Wait for the row to disappear from the visible list.
    await page.waitForFunction(
      (label) => {
        const subBoxEl = Array.from(document.querySelectorAll('.geg-gold-box')).find(
          (b) => b.textContent?.includes('MONTHLY · SUBSCRIPTIONS'),
        )
        return subBoxEl ? !subBoxEl.textContent?.includes(label) : true
      },
      TEST_SUB_REMOVE,
      { timeout: 15_000 },
    )
    const afterRemove = await readTotalThisMonthUsd(page)
    assertWithin(
      afterRemove,
      beforeRemoveAdd,
      0.01,
      `5 remove-invariant: total returned to baseline after Remove (was ${beforeRemoveAdd} pre-add, ${afterRemoveAdd} post-add, ${afterRemove} post-remove). Spec Part 4: Remove takes cost out of total.`,
    )
    console.log(
      `[verify] 5 Remove: row gone from list AND total dropped by exactly $${REMOVE_COST} (back to $${afterRemove.toFixed(2)})`,
    )

    // --- 6. Add + Remove a one-off extra ---
    const extraBox = page
      .locator('.geg-gold-box', { hasText: 'ONE-OFF · EXTRAS' })
      .first()
    await extraBox
      .locator('input[placeholder="Description"]')
      .fill(TEST_EXTRA_DESC)
    await extraBox.locator('input[placeholder="Cost USD"]').fill('7.89')
    await extraBox.locator('button[type="submit"]:has-text("Add")').click()
    await page.waitForSelector(`text=${TEST_EXTRA_DESC}`, { timeout: 15_000 })
    console.log(`[verify] 6 extra added (${TEST_EXTRA_DESC})`)

    page.once('dialog', (d) => d.accept())
    const extraRow = extraBox.locator('div', { hasText: TEST_EXTRA_DESC }).last()
    await extraRow
      .locator(`button[aria-label="Remove ${TEST_EXTRA_DESC} permanently"]`)
      .click()
    await page.waitForSelector(`text=${TEST_EXTRA_DESC}`, {
      state: 'detached',
      timeout: 15_000,
    })
    console.log('[verify] 6 extra removed (hard delete)')

    // --- 7. Part 3 add-button diagnosis surface ---
    console.log('[verify] 7 add-button diagnosis — captured throughout run')
    printCapture(cap, 'final')
    // If no failed requests + no console errors but Drake's report
    // says add fails, the issue is environmental on Drake's side
    // (browser cache / extension / session). If the captures show
    // anything, that's the smoking gun.

    // --- 8. Screenshot ---
    const shotPath = path.join(OUT_DIR, 'cost-hub.png')
    await page.screenshot({ path: shotPath, fullPage: true })
    console.log(`[verify] wrote ${shotPath}`)
    console.log('[verify] PASS')
  } finally {
    // --- 9. CLEANUP — hard-DELETE every __verify_* row. ALWAYS runs. ---
    // Direct Supabase admin write — sidesteps the UI so it works even
    // if the page errored mid-run + targets only test rows so real
    // data is untouched.
    try {
      await cleanupVerifyRows()
    } catch (cleanupErr) {
      console.error('[verify] CLEANUP FAILED — leftover __verify_* rows may exist:')
      console.error(cleanupErr)
    }
    await browser.close()
  }
}

// Hard-DELETE every `__verify_*` row across both tables. Strict LIKE
// match on the `__verify_` prefix; never touches real data.
async function cleanupVerifyRows(): Promise<void> {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.warn(
      '[verify] cleanup: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set; skipping cleanup. ' +
        'Leftover __verify_* rows may inflate the running total — delete via SQL:\n' +
        "  DELETE FROM monthly_subscriptions WHERE provider LIKE '__verify_%';\n" +
        "  DELETE FROM cost_extras WHERE description LIKE '__verify_%';",
    )
    return
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } })
  // Subs.
  const { error: subErr, count: subCount } = await supabase
    .from('monthly_subscriptions')
    .delete({ count: 'exact' })
    .like('provider', '__verify_%')
  if (subErr) throw new Error(`cleanup subs: ${subErr.message}`)
  console.log(`[verify] cleanup: deleted ${subCount ?? 0} __verify_* sub rows`)
  // Extras.
  const { error: extraErr, count: extraCount } = await supabase
    .from('cost_extras')
    .delete({ count: 'exact' })
    .like('description', '__verify_%')
  if (extraErr) throw new Error(`cleanup extras: ${extraErr.message}`)
  console.log(`[verify] cleanup: deleted ${extraCount ?? 0} __verify_* extra rows`)
}

// Fill the add form + click Add + wait for the row to appear in the table.
async function addSubscription(
  page: Page,
  subBox: ReturnType<Page['locator']>,
  provider: string,
  cost: string,
  notes: string,
  effectiveFrom: string,
): Promise<void> {
  await subBox.locator('input[placeholder="Provider"]').fill(provider)
  await subBox.locator('input[placeholder="Monthly cost USD"]').fill(cost)
  await subBox.locator('input[placeholder="Notes (optional)"]').fill(notes)
  await subBox.locator('input[aria-label="Effective from"]').fill(effectiveFrom)
  await subBox.locator('button[type="submit"]:has-text("Add")').click()
  await page.waitForSelector(`text=${provider}`, { timeout: 15_000 })
}

function assertWithin(actual: number, expected: number, tolerance: number, msg: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`ASSERTION FAILED — ${msg}`)
  }
}

main().catch((err) => {
  console.error('[verify] FAIL')
  console.error(err)
  process.exit(1)
})
