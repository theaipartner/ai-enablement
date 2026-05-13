// Visual verification harness for the Ella audit pages on the
// gregory-redesign-part-1-foundations preview. Loads the deploy preview
// with Drake's pasted Supabase auth cookie, navigates the three target
// pages (list + reactive detail + passive detail), screenshots each.
//
// Inputs (read at runtime):
//   - .env.local: PREVIEW_URL, PREVIEW_HOST
//   - .preview-cookie: raw value for `sb-sjjovsjcfffrftnraocu-auth-token`
//     (the literal string Drake pasted from his browser; starts with
//     `base64-`).
//
// Outputs:
//   - scripts/preview-screenshots/list.png
//   - scripts/preview-screenshots/reactive-detail.png
//   - scripts/preview-screenshots/passive-detail.png
//
// Run with: `node scripts/verify-ella-preview.mjs`. Requires Playwright
// + Chromium installed; both landed in this branch as @playwright/test
// + ~/.cache/ms-playwright. Headless mode by default; pass HEADED=1 to
// see the browser.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const REACTIVE_RUN_ID = '6ca843b0-0ec2-49b3-b09a-2a16fde00865'
const PASSIVE_RUN_ID = '9e73a8fa-ae94-4d59-9195-01a87c4d8aef'

function readEnvLocal() {
  const raw = readFileSync('.env.local', 'utf8')
  const out = {}
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

async function main() {
  const env = readEnvLocal()
  const PREVIEW_URL = env.PREVIEW_URL
  const PREVIEW_HOST = env.PREVIEW_HOST
  if (!PREVIEW_URL || !PREVIEW_HOST) {
    throw new Error('PREVIEW_URL or PREVIEW_HOST missing from .env.local')
  }
  const cookieValue = readFileSync('.preview-cookie', 'utf8').trim()
  if (!cookieValue.startsWith('base64-')) {
    throw new Error(
      '.preview-cookie does not start with `base64-`. Did the export work?',
    )
  }

  const browser = await chromium.launch({ headless: !process.env.HEADED })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  })
  await context.addCookies([
    {
      name: 'sb-sjjovsjcfffrftnraocu-auth-token',
      value: cookieValue,
      domain: PREVIEW_HOST,
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    },
  ])
  const page = await context.newPage()

  // Console + network logs surface anything weird (failed requests, auth
  // redirects). Cheap visibility.
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-error]', msg.text())
  })

  const targets = [
    { name: 'list', path: '/ella/runs' },
    { name: 'reactive-detail', path: `/ella/runs/${REACTIVE_RUN_ID}` },
    { name: 'passive-detail', path: `/ella/runs/${PASSIVE_RUN_ID}` },
  ]

  for (const t of targets) {
    const url = `${PREVIEW_URL}${t.path}`
    console.log(`→ ${url}`)
    const response = await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000,
    })
    const status = response?.status() ?? 0
    const finalUrl = page.url()
    console.log(`   status=${status} finalUrl=${finalUrl}`)
    // Auth check — if we got redirected to /login, the cookie didn't
    // work. Bail loudly per spec hard-stop #2.
    if (finalUrl.includes('/login')) {
      console.error(
        '!! Redirected to /login. Auth cookie failed. ' +
          'Aborting before more bad screenshots accumulate.',
      )
      await browser.close()
      process.exit(2)
    }

    // Wait a beat for any client-side rendering (RolePill etc).
    await page.waitForTimeout(500)

    const outPath = join('scripts', 'preview-screenshots', `${t.name}.png`)
    await page.screenshot({ path: outPath, fullPage: true })
    console.log(`   → ${outPath}`)
  }

  await browser.close()
  console.log('done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
