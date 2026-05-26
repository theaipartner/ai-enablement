#!/usr/bin/env node
// One-shot cloud→local Supabase sync for the sales-dashboard tables.
//
// READS from cloud Supabase using creds in .env.local.cloud-backup.
// WRITES to local Supabase (127.0.0.1:54321) using creds in .env.local.
// NEVER writes to cloud — the cloud client only does .select().
//
// Usage:
//   node scripts/sync_cloud_to_local.mjs           # default: last 5 days
//   node scripts/sync_cloud_to_local.mjs --days 2  # custom window
//
// Tables synced:
//   - clarity_metrics_daily  (last N days, key: snapshot_date+metric_name+url)
//   - wistia_media_daily     (last N days, key: hashed_id+day)
//   - wistia_medias          (full table, key: hashed_id)
//   - typeform_responses     (last N days, key: response_id)
//   - calendly_scheduled_events (last N days, key: uri)
//   - calendly_invitees      (last N days, key: uri)
//   - calendly_event_types   (full table, key: uri)
//   - meta_ad_daily          (full table, key: day)
//   - airtable_full_closer_report  (last N days, key: record_id)

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function parseEnvFile(path) {
  const out = {}
  const text = readFileSync(path, 'utf8')
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1')
    out[key] = value
  }
  return out
}

const cloudEnv = parseEnvFile(resolve(process.cwd(), '.env.local.cloud-backup'))
const localEnv = parseEnvFile(resolve(process.cwd(), '.env.local'))

const cloudUrl = cloudEnv.SUPABASE_URL
const cloudKey = cloudEnv.SUPABASE_SERVICE_ROLE_KEY
const localUrl = localEnv.SUPABASE_URL
const localKey = localEnv.SUPABASE_SERVICE_ROLE_KEY

if (!cloudUrl?.startsWith('https://')) throw new Error('cloud SUPABASE_URL not https — bailing for safety')
if (!localUrl?.startsWith('http://127.0.0.1')) throw new Error('local SUPABASE_URL must be 127.0.0.1 — bailing for safety')

const cloud = createClient(cloudUrl, cloudKey, { auth: { persistSession: false } })
const local = createClient(localUrl, localKey, { auth: { persistSession: false } })

// CLI arg parsing.
const args = process.argv.slice(2)
let days = 5
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) {
    days = parseInt(args[i + 1], 10)
    i++
  }
}
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
const sinceIso = since.toISOString()
const sinceDate = since.toISOString().slice(0, 10)

console.log(`Cloud → local sync starting`)
console.log(`Cloud:  ${cloudUrl}`)
console.log(`Local:  ${localUrl}`)
console.log(`Window: last ${days} days (since ${sinceDate})`)
console.log('')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Pull rows from cloud in pages (default Supabase cap is 1000 per request).
async function fetchAll(table, query) {
  const PAGE = 1000
  const rows = []
  let from = 0
  while (true) {
    const q = query()
    const { data, error } = await q.range(from, from + PAGE - 1)
    if (error) throw new Error(`cloud ${table} fetch failed: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return rows
}

async function upsertBatched(table, rows, onConflict) {
  if (rows.length === 0) return
  const BATCH = 500
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    const { error } = await local.from(table).upsert(slice, { onConflict })
    if (error) throw new Error(`local ${table} upsert failed (batch ${i}): ${error.message}`)
  }
}

async function sync({ name, fetch, conflict }) {
  process.stdout.write(`  ${name}: fetching from cloud... `)
  const t0 = Date.now()
  const rows = await fetch()
  process.stdout.write(`${rows.length} rows. upserting to local... `)
  await upsertBatched(name, rows, conflict)
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

// ---------------------------------------------------------------------------
// Per-table syncs
// ---------------------------------------------------------------------------

await sync({
  name: 'clarity_metrics_daily',
  conflict: 'snapshot_date,metric_name,url',
  fetch: () => fetchAll('clarity_metrics_daily', () =>
    cloud.from('clarity_metrics_daily').select('*').gte('snapshot_date', sinceDate)),
})

await sync({
  name: 'wistia_medias',
  conflict: 'hashed_id',
  fetch: () => fetchAll('wistia_medias', () => cloud.from('wistia_medias').select('*')),
})

await sync({
  name: 'wistia_media_daily',
  conflict: 'hashed_id,day',
  fetch: () => fetchAll('wistia_media_daily', () =>
    cloud.from('wistia_media_daily').select('*').gte('day', sinceDate)),
})

await sync({
  name: 'typeform_responses',
  conflict: 'response_id',
  fetch: () => fetchAll('typeform_responses', () =>
    cloud.from('typeform_responses').select('*').gte('submitted_at', sinceIso)),
})

await sync({
  name: 'calendly_event_types',
  conflict: 'uri',
  fetch: () => fetchAll('calendly_event_types', () => cloud.from('calendly_event_types').select('*')),
})

await sync({
  name: 'calendly_scheduled_events',
  conflict: 'uri',
  fetch: () => fetchAll('calendly_scheduled_events', () =>
    cloud.from('calendly_scheduled_events').select('*').gte('event_created_at', sinceIso)),
})

await sync({
  name: 'calendly_invitees',
  conflict: 'uri',
  fetch: () => fetchAll('calendly_invitees', () =>
    cloud.from('calendly_invitees').select('*').gte('invitee_created_at', sinceIso)),
})

// Meta ad-spend mirror — tiny table (one row per day), full sync.
// PK is `day`; cron upserts on conflict so duplicate-day writes
// just refresh the row.
await sync({
  name: 'meta_ad_daily',
  conflict: 'day',
  fetch: () => fetchAll('meta_ad_daily', () => cloud.from('meta_ad_daily').select('*')),
})

await sync({
  name: 'typeform_form_insights_snapshots',
  conflict: 'form_id,snapshot_at',
  fetch: () => fetchAll('typeform_form_insights_snapshots', () =>
    cloud.from('typeform_form_insights_snapshots').select('*').gte('snapshot_at', sinceIso)),
})

// Full Closer Report Form — canonical source for the Closing page.
// PK = record_id (Airtable rec*). Filter by airtable_created_at.
// Setter Triage form is intentionally NOT synced here; the
// Appointment Setting page reads it on a different cadence.
await sync({
  name: 'airtable_full_closer_report',
  conflict: 'record_id',
  fetch: () => fetchAll('airtable_full_closer_report', () =>
    cloud.from('airtable_full_closer_report').select('*').gte('airtable_created_at', sinceIso)),
})

// Close tables — power the Appointment Setting stage. Pull a
// broader window than the rest because outcome attribution looks
// 7 days past the call's date, and speed-to-lead needs the lead's
// date_created to bracket the first call.
const closeSinceIso = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
await sync({
  name: 'close_leads',
  conflict: 'close_id',
  fetch: () => fetchAll('close_leads', () =>
    cloud.from('close_leads').select('*').gte('date_created', closeSinceIso)),
})

await sync({
  name: 'close_calls',
  conflict: 'close_id',
  fetch: () => fetchAll('close_calls', () =>
    cloud.from('close_calls').select('*').gte('activity_at', closeSinceIso)),
})

await sync({
  name: 'close_sms',
  conflict: 'close_id',
  fetch: () => fetchAll('close_sms', () =>
    cloud.from('close_sms').select('*').gte('activity_at', closeSinceIso)),
})

await sync({
  name: 'close_lead_status_changes',
  conflict: 'close_id',
  fetch: () => fetchAll('close_lead_status_changes', () =>
    cloud.from('close_lead_status_changes').select('*').gte('date_created', closeSinceIso)),
})

console.log('')
console.log('Sync complete.')
