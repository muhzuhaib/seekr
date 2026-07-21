/**
 * Request pacing. Seekr browses at human speed on purpose: one page in flight at a
 * time, a real gap between pages, and an exponential back-off whenever Indeed tells
 * us to slow down. This is the whole rate-limit strategy — there is deliberately no
 * retry storm and no parallelism anywhere else in the codebase.
 */

const MIN_GAP_MS = 2500
const JITTER_MS = 1200
const MAX_BACKOFF_MS = 10 * 60_000

let queue: Promise<unknown> = Promise.resolve()
let lastRequestAt = 0
let backoffMs = 0
let cooldownUntil = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function cooldownRemaining(): number {
  return Math.max(0, cooldownUntil - Date.now())
}

/** Called when Indeed returns 429/403 or serves a bot challenge. */
export function penalise(): number {
  backoffMs = backoffMs === 0 ? 30_000 : Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  cooldownUntil = Date.now() + backoffMs
  return backoffMs
}

/** Called after any successful fetch — one good response clears the penalty. */
export function reward(): void {
  backoffMs = 0
  cooldownUntil = 0
}

/**
 * Serialises every network-touching task through a single chain. Callers just
 * `await schedule(fn)` and never think about pacing again.
 */
export function schedule<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const now = Date.now()

    if (cooldownUntil > now) await sleep(cooldownUntil - now)

    const since = Date.now() - lastRequestAt
    const gap = MIN_GAP_MS + Math.random() * JITTER_MS
    if (since < gap) await sleep(gap - since)

    lastRequestAt = Date.now()
    return task()
  })

  // Keep the chain alive even if this task rejects, otherwise one failure would
  // wedge every future request behind a rejected promise.
  queue = run.catch(() => undefined)
  return run
}
