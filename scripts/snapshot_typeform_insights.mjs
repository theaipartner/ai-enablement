#!/usr/bin/env node
// Snapshot Typeform's /insights/{form_id}/summary into
// typeform_form_insights_snapshots. Drives the LP page's "starts"
// metric (lifetime-totals endpoint → daily delta).
//
// Local-dev script for on-demand snapshotting. Production uses the
// Vercel cron at api/typeform_insights_cron.py (every 15 min).
//
// Usage:
//   node scripts/snapshot_typeform_insights.mjs           # snapshot to local
//   node scripts/snapshot_typeform_insights.mjs --cloud   # snapshot to cloud (rare; cron handles this)
//   node scripts/snapshot_typeform_insights.mjs --form X  # explicit form_id

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

function parseEnv(p) {
  const o = {}
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    const t = l.trim()
    if (!t || t.startsWith('#')) continue
    const e = t.indexOf('=')
    if (e === -1) continue
    o[t.slice(0, e)] = t.slice(e + 1)
  }
  return o
}

const args = process.argv.slice(2)
const useCloud = args.includes('--cloud')
let formId = 'SFedWelr'
const formIdx = args.indexOf('--form')
if (formIdx >= 0 && args[formIdx + 1]) formId = args[formIdx + 1]

const envFile = useCloud ? '.env.local.cloud-backup' : '.env.local'
const env = parseEnv(envFile)
const tfKey = parseEnv('.env.local').TYPEFORM_API_KEY
if (!tfKey) throw new Error('TYPEFORM_API_KEY missing in .env.local')

if (useCloud && !env.SUPABASE_URL?.startsWith('https://')) {
  throw new Error('--cloud requires cloud SUPABASE_URL; bailing for safety')
}

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

console.log(`Snapshotting Typeform insights for form_id=${formId} → ${useCloud ? 'CLOUD' : 'LOCAL'}`)

// Node's undici fetch was timing out from WSL on this network; system
// curl is reliable here. Shell out instead of using global fetch.
const url = `https://api.typeform.com/insights/${formId}/summary`
const stdout = execSync(
  `curl -fsS -H "Authorization: Bearer ${tfKey}" "${url}"`,
  { encoding: 'utf8' },
)
const payload = JSON.parse(stdout)
const summary = payload?.form?.summary
if (!summary) {
  console.error('Unexpected payload shape — no form.summary')
  console.error(JSON.stringify(payload).slice(0, 500))
  process.exit(1)
}

const snapshot = {
  form_id: formId,
  snapshot_at: new Date().toISOString(),
  total_visits: summary.total_visits ?? null,
  unique_visits: summary.unique_visits ?? null,
  responses_count: summary.responses_count ?? null,
  completion_rate: summary.completion_rate ?? null,
  average_time_seconds: summary.average_time ?? null,
  raw: payload,
}

console.log('Snapshot:', {
  ...snapshot,
  raw: '<jsonb, omitted>',
})

const { error } = await sb.from('typeform_form_insights_snapshots').insert(snapshot)
if (error) {
  console.error(`Insert failed: ${error.message}`)
  process.exit(1)
}
console.log('OK — row written.')
