import 'server-only'

// Parallel query helpers for the sales data layer.
//
// The sales pages fan out into many chunked `.in(idChunk)` reads. Issuing those
// chunks one-at-a-time (the historic `for (let i...; i += N)` pattern) makes the
// page latency the SUM of all chunk round-trips. These helpers issue the chunks
// CONCURRENTLY and return the rows in **chunk order**, so:
//
//   - For id-partitioned reads (each id in exactly one chunk), no key ever spans
//     two chunks, so the merge result is identical regardless of order.
//   - For reads where the caller's merge is order-dependent (first-wins /
//     last-wins), processing the returned array in order reproduces the exact
//     sequential result, because chunk order is preserved.
//
// Pagination loops (`for (from...; from += 1000)`) are NOT parallelized here —
// their termination depends on the previous page's row count, so each chunk's
// own pages stay sequential. `fetchChunkedPaged` parallelizes across chunks
// while keeping each chunk's pagination sequential.

type PostgrestResult = { data: unknown; error: { message: string } | null }

// Max concurrent Supabase fetches per chunked-read call. The sales pages fan out
// MANY loaders at once (the roster/rep page alone runs ~9 in parallel, several of
// which call these helpers), and an unbounded `Promise.all` over every chunk
// would burst dozens-to-hundreds of simultaneous requests at Supabase's REST +
// pooler — which intermittently drops/hangs connections and surfaces as
// `TypeError: fetch failed`, crashing the whole render. Capping the in-flight
// count keeps peak concurrency sane while preserving most of the parallel speedup.
const CHUNK_CONCURRENCY = 6

// Transient network failures from undici/Supabase — retried (vs. real query
// errors like a bad column, which must surface immediately). The `fetch failed`
// case is the live one: supabase-js catches the undici throw and returns it as
// `{ error: { message: 'TypeError: fetch failed' } }`.
const TRANSIENT_RE =
  /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|und_err|connection (?:closed|reset|terminated)|terminated/i

function isTransient(message: string): boolean {
  return TRANSIENT_RE.test(message)
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Max encoded query-string budget per `.in(col, chunk)` read. PostgREST sits
// behind a gateway that drops over-long request URIs as `TypeError: fetch
// failed` (NOT a clean 414) — the live failure mode was `calendly_invitees`
// keyed on 78-char Calendly URLs: at chunkSize 200 the encoded `?col=in.(…)`
// hit ~18k chars and the chunk silently failed, crashing the whole render. This
// breaks the moment a long-key set crosses the count threshold, so chunking must
// be LENGTH-aware, not count-only. 6000 leaves wide margin under the gateway cap.
const MAX_CHUNK_QS_BYTES = 6000

// Split ids into chunks bounded by BOTH `chunkSize` (count) and the encoded
// query-string budget. A single id longer than the budget still gets its own
// chunk (degenerate but correct). Encoded length is what the URL actually
// carries (`:` / `/` in URLs expand under encodeURIComponent).
function buildChunks(ids: string[], chunkSize: number): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let currentLen = 0
  for (const id of ids) {
    const idLen = encodeURIComponent(id).length + 1 // +1 for the comma separator
    if (current.length > 0 && (current.length >= chunkSize || currentLen + idLen > MAX_CHUNK_QS_BYTES)) {
      chunks.push(current)
      current = []
      currentLen = 0
    }
    current.push(id)
    currentLen += idLen
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

// Order-preserving concurrency-limited map. Runs at most `limit` `fn`s at once.
async function mapPool<I, O>(
  items: I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const results = new Array<O>(items.length)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// Retry a Supabase read on transient network failure (whether the failure
// surfaces as a thrown exception or as a returned `{ error }`). Real query
// errors fall straight through to the caller. Backoff: 250ms, 500ms.
export async function withRetry<T extends PostgrestResult>(
  run: () => PromiseLike<T>,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await run()
      if (res.error && isTransient(res.error.message) && attempt < attempts) {
        await delay(attempt * 250)
        continue
      }
      return res
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isTransient(message) && attempt < attempts) {
        await delay(attempt * 250)
        continue
      }
      throw err
    }
  }
}

// Single fetch per id-chunk, chunks run concurrently (capped + retried). Returns
// rows in chunk order.
export async function fetchChunked<T>(
  ids: string[],
  build: (chunk: string[]) => PromiseLike<PostgrestResult>,
  label: string,
  chunkSize = 100,
): Promise<T[]> {
  const chunks = buildChunks(ids, chunkSize)
  const parts = await mapPool(chunks, CHUNK_CONCURRENCY, async (chunk) => {
    const { data, error } = await withRetry(() => build(chunk))
    if (error) throw new Error(`${label}: ${error.message}`)
    return (data ?? []) as T[]
  })
  return parts.flat()
}

// Like fetchChunked, but each chunk is fully paginated (1000-row pages) before
// resolving. Chunks run concurrently; pages within a chunk stay sequential (the
// page count isn't known up front). Returns rows in chunk order.
export async function fetchChunkedPaged<T>(
  ids: string[],
  build: (chunk: string[], from: number, to: number) => PromiseLike<PostgrestResult>,
  label: string,
  chunkSize = 100,
  pageSize = 1000,
): Promise<T[]> {
  const chunks = buildChunks(ids, chunkSize)
  const parts = await mapPool(chunks, CHUNK_CONCURRENCY, async (chunk) => {
    const out: T[] = []
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await withRetry(() => build(chunk, from, from + pageSize - 1))
      if (error) throw new Error(`${label}: ${error.message}`)
      const page = (data ?? []) as T[]
      out.push(...page)
      if (page.length < pageSize) break
    }
    return out
  })
  return parts.flat()
}
