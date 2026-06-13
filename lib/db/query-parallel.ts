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

// Single fetch per id-chunk, all chunks concurrent. Returns rows in chunk order.
export async function fetchChunked<T>(
  ids: string[],
  build: (chunk: string[]) => PromiseLike<PostgrestResult>,
  label: string,
  chunkSize = 100,
): Promise<T[]> {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize))
  const parts = await Promise.all(
    chunks.map(async (chunk) => {
      const { data, error } = await build(chunk)
      if (error) throw new Error(`${label}: ${error.message}`)
      return (data ?? []) as T[]
    }),
  )
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
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize))
  const parts = await Promise.all(
    chunks.map(async (chunk) => {
      const out: T[] = []
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await build(chunk, from, from + pageSize - 1)
        if (error) throw new Error(`${label}: ${error.message}`)
        const page = (data ?? []) as T[]
        out.push(...page)
        if (page.length < pageSize) break
      }
      return out
    }),
  )
  return parts.flat()
}
