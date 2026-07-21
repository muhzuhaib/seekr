/**
 * Request pacing.
 *
 * Seekr browses like a person, not a crawler. The rules that never change:
 * background crawling stays slow and strictly serial, and any failure backs off
 * exponentially. What *did* change (v0.4.0) is the foreground: a person reading a
 * results page has several tabs opening at once, and making them wait out a bulk
 * crawl gap for pages they are staring at was our pacing being conservative in the
 * one place it costs the user real time.
 *
 * So lanes now carry their own concurrency as well as their own gap:
 *
 *   interactive — up to 3 at once, ~250 ms apart. Job descriptions, and search
 *                 pages the user pressed Refresh for.
 *   background  — one at a time, ~2.2 s apart. Speculative prefetch, backfill.
 *
 * Background work never starts while interactive work is queued, so guessing can
 * never delay something the user is actually waiting for.
 */

const MAX_BACKOFF_MS = 10 * 60_000

export type Lane = 'background' | 'interactive'

interface LaneConfig {
  concurrency: number
  gap: number
  jitter: number
}

const LANES: Record<Lane, LaneConfig> = {
  interactive: { concurrency: 3, gap: 250, jitter: 150 },
  background: { concurrency: 1, gap: 2200, jitter: 800 }
}

let backoffMs = 0
let cooldownUntil = 0

/** Last start time per lane, so a fast lane isn't held back by a slow one. */
const lastStartAt: Record<Lane, number> = { interactive: 0, background: 0 }
const active: Record<Lane, number> = { interactive: 0, background: 0 }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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

interface Waiting {
  lane: Lane
  start: () => void
}

const waiting: Waiting[] = []

function canStart(lane: Lane): boolean {
  if (active[lane] >= LANES[lane].concurrency) return false
  // Background yields entirely while anything interactive is pending or running.
  if (lane === 'background') {
    if (active.interactive > 0) return false
    if (waiting.some((w) => w.lane === 'interactive')) return false
  }
  return true
}

function pump(): void {
  // Interactive first, otherwise oldest-first.
  for (;;) {
    const index = waiting.findIndex((w) => w.lane === 'interactive' && canStart('interactive'))
    const pick = index >= 0 ? index : waiting.findIndex((w) => canStart(w.lane))
    if (pick < 0) return
    const next = waiting.splice(pick, 1)[0]
    active[next.lane]++
    next.start()
  }
}

/**
 * Serialises (and now, in the foreground, *paces*) every network-touching task.
 * Callers just `await schedule(fn)` and never think about it again.
 */
export function schedule<T>(task: () => Promise<T>, lane: Lane = 'background'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = async (): Promise<void> => {
      try {
        const now = Date.now()
        if (cooldownUntil > now) await sleep(cooldownUntil - now)

        const config = LANES[lane]
        const gap = config.gap + Math.random() * config.jitter
        const since = Date.now() - lastStartAt[lane]
        if (since < gap) await sleep(gap - since)

        lastStartAt[lane] = Date.now()
        resolve(await task())
      } catch (err) {
        reject(err)
      } finally {
        // Always hand the slot back, even if this task threw — otherwise one
        // failure would wedge every request behind it forever.
        active[lane]--
        pump()
      }
    }

    waiting.push({ lane, start })
    pump()
  })
}
