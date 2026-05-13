// Diagnostic: dump the DOM-level state for all three reported issues so
// we know whether the deployed preview reflects the latest fixes or is
// still serving a stale build.

import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

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

const env = readEnvLocal()
const cookieValue = readFileSync('.preview-cookie', 'utf8').trim()

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
})
await context.addCookies([{
  name: 'sb-sjjovsjcfffrftnraocu-auth-token',
  value: cookieValue,
  domain: env.PREVIEW_HOST,
  path: '/',
  httpOnly: false, secure: true, sameSite: 'Lax',
}])
const page = await context.newPage()

// --- LIST PAGE ---
console.log('========= /ella/runs =========')
await page.goto(`${env.PREVIEW_URL}/ella/runs`, { waitUntil: 'networkidle' })

// Check row borders.
const rowBorder = await page.evaluate(() => {
  const r = document.querySelector('tbody tr')
  if (!r) return { error: 'no rows' }
  const s = getComputedStyle(r)
  return {
    borderTopColor: s.borderTopColor,
    borderTopWidth: s.borderTopWidth,
    borderTopStyle: s.borderTopStyle,
    borderBottomColor: s.borderBottomColor,
    borderBottomWidth: s.borderBottomWidth,
  }
})
console.log('first row border:', JSON.stringify(rowBorder))

// Check the build id (Next.js exposes it in the page source).
const buildId = await page.evaluate(() => {
  const m = document.body.innerHTML.match(/"buildId":"([^"]+)"/)
  return m ? m[1] : 'not-found'
})
console.log('build id:', buildId)

// --- REACTIVE DETAIL ---
console.log('\n========= /ella/runs/6ca843b0-... (reactive) =========')
await page.goto(
  `${env.PREVIEW_URL}/ella/runs/6ca843b0-0ec2-49b3-b09a-2a16fde00865`,
  { waitUntil: 'networkidle' },
)
const reactiveSurrounding = await page.evaluate(() => {
  // The Surrounding-messages section is inside a section with the
  // text "SURROUNDING MESSAGES" header. Find its children.
  const allSections = Array.from(document.querySelectorAll('section'))
  for (const sec of allSections) {
    const h2 = sec.querySelector('h2')
    if (h2 && /SURROUNDING/i.test(h2.textContent || '')) {
      // Count child message-divs (one per row).
      const rows = sec.querySelectorAll('div > div > div > span.font-medium')
      return {
        innerText: (sec.textContent || '').slice(0, 600),
        messageRowCount: rows.length,
      }
    }
  }
  return { error: 'section not found' }
})
console.log('reactive surrounding:', JSON.stringify(reactiveSurrounding, null, 2))

const reactiveTriggerText = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('section'))
  for (const sec of all) {
    const h2 = sec.querySelector('h2')
    if (h2 && /TRIGGERING/i.test(h2.textContent || '')) {
      return sec.textContent
    }
  }
  return null
})
console.log('reactive triggering message text:', JSON.stringify(reactiveTriggerText?.slice(0, 200)))

// --- PASSIVE DETAIL ---
console.log('\n========= /ella/runs/9e73a8fa-... (passive) =========')
await page.goto(
  `${env.PREVIEW_URL}/ella/runs/9e73a8fa-ae94-4d59-9195-01a87c4d8aef`,
  { waitUntil: 'networkidle' },
)
const passiveSurrounding = await page.evaluate(() => {
  const allSections = Array.from(document.querySelectorAll('section'))
  for (const sec of allSections) {
    const h2 = sec.querySelector('h2')
    if (h2 && /SURROUNDING/i.test(h2.textContent || '')) {
      const rows = sec.querySelectorAll('div > div > div > span.font-medium')
      return {
        innerText: (sec.textContent || '').slice(0, 600),
        messageRowCount: rows.length,
      }
    }
  }
  return { error: 'section not found' }
})
console.log('passive surrounding:', JSON.stringify(passiveSurrounding, null, 2))

await browser.close()
