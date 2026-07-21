/**
 * Request pacing. Seekr browses at human speed on purpose: one page in flight at a
 * time, a real gap between pages, and an exponential back-off whenever Indeed tells
 * us to slow down. This is the whole rate-limit strategy — there is deliberately no
 * retry storm and no parallelism anywhere else in the codebase.
 */

const MIN_GAP_MS = 2500
const JITTER_MS = 1200

/**
 * Interactive gap: the user clicked a job and is watching a spinner.
 *
 * The rule we hold ourselves to is "browse at human pace, one request in flight" —
 * and a person reading a results list genuinely does open listings faster than one
 * every 2.5 s. Making *them* wait out the bulk-crawl gap was our pacing being
 * conservative in the one place it costs the user something, so foreground page
 * views get a shorter gap. Background crawling is unchanged.
 */
const INTERACTIVE_GAP_MS = 700
const INTERACTIVE_JITTER_MS = 300

const MAX_BACKOFF_MS = 10 * 60_000

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

/** Interactive work runs before background work. Still one request at a time. */
export type Lane = 'background' | 'interactive'

interface Waiting {
  lane: Lane
  start: () => void
}

const waiting: Waiting[] = []
let running = false

function pump(): void {
  if (running) return
  // Interactive first, otherwise oldest-first. A background crawl must never make
  // the user wait behind it for a page they are actively looking at.
  const index = waiting.findIndex((w) => w.lane === 'interactive')
  const next = waiting.splice(index >= 0 ? index : 0, 1)[0]
  if (!next) return
  running = true
  next.start()
}

/**
 * Serialises every network-touching task. Callers just `await schedule(fn)` and
 * never think about pacing again. Pass `'interactive'` for anything a user is
 * waiting on right now.
 */
export function schedule<T>(task: () => Promise<T>, lane: Lane = 'background'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = async (): Promise<void> => {
      try {
        const now = Date.now()
        if (cooldownUntil > now) await sleep(cooldownUntil - now)

        const since = Date.now() - lastRequestAt
        const gap =
          lane === 'interactive'
            ? INTERACTIVE_GAP_MS + Math.random() * INTERACTIVE_JITTER_MS
            : MIN_GAP_MS + Math.random() * JITTER_MS
        if (since < gap) await sleep(gap - since)

        lastRequestAt = Date.now()
        resolve(await task())
      } catch (err) {
        reject(err)
      } finally {
        // Always hand the lane on, even if this task threw — otherwise one failure
        // would wedge every request behind it forever.
        running = false
        pump()
      }
    }

    waiting.push({ lane, start })
    pump()
  })
}
