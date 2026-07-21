/**
 * Job descriptions: fetch once, keep forever, and fetch *early*.
 *
 * Opening a listing used to mean a visible 2–3 second wait. Almost none of that
 * was Indeed being slow — it was our own crawl pacing making the user queue behind
 * a bulk gap for a page they were staring at. Three things fix it, in order of how
 * much they matter:
 *
 *  1. **Cache.** A fetched description is written back into the corpus and
 *     persisted, so a job only ever costs a wait once, even across restarts.
 *  2. **Prefetch on hover.** Pointing at a card starts the fetch, so by the time
 *     the click lands the text is usually already here.
 *  3. **A short queue.** User-initiated views use the interactive lane; hover
 *     prefetches use the background lane and are capped, so speculative work can
 *     never delay a real one.
 *
 * Fetching the full description is also what makes the *work-mode* verdict
 * trustworthy — Indeed's structured "Work Location:" line lives in the description,
 * not in the search-results card — so every fetch re-runs the classifier.
 */

import type { Job } from '../shared/types'
import { fetchJobDetail } from './ingest'
import { getJob, upsert } from './corpus'
import { classifyWorkMode, parseSalary } from './normalize'
import { regionByCode } from '../shared/types'

/**
 * One in-flight request per job. Hovering a card and then clicking it must join
 * the same fetch rather than starting a second one.
 */
const inflight = new Map<string, Promise<Job | null>>()

/** Jobs we tried and failed on, so a broken listing isn't retried on every hover. */
const failed = new Set<string>()

/** Speculative fetches are capped: past this many at once, hovering does nothing. */
const MAX_PREFETCH_IN_FLIGHT = 3
let prefetching = 0

/**
 * Merge a freshly fetched description into a job.
 *
 * The description is strictly more information than the search card carried, so
 * the work mode is re-decided with it — this is what promotes a listing whose only
 * remote evidence was "Work Location: Remote" in the body. Salary and location are
 * only *filled in*, never overwritten, since the card's own values came from
 * Indeed's structured search data.
 */
function enrich(job: Job, description: string, salaryText: string | null, location: string | null): Job {
  const body = `${job.snippet}\n${description}`
  const region = regionByCode(job.region)

  return {
    ...job,
    description,
    location: job.location || location || '',
    salary: job.salary ?? parseSalary(salaryText, region.currency),
    /*
      Indeed's own remote tag and work model are passed back in.

      They used to be dropped here (`false, null`), which quietly *demoted* jobs:
      a listing Indeed itself labelled remote would be re-judged from prose alone,
      and a named city in the location field was enough to push it to on-site. That
      is a large part of why the Remote filter looked empty. The description's own
      "Job Location:" line still outranks both, so a genuine correction still wins.
    */
    workMode: classifyWorkMode(
      job.title,
      job.location || location || '',
      body,
      job.remoteFlag,
      job.remoteModel
    )
  }
}

/**
 * The description for a job, from cache when we have it.
 *
 * `background: true` marks a speculative prefetch: it yields the lane to anything
 * the user is actually waiting for, and gives up quietly when the queue is busy.
 */
export function detailFor(
  jobId: string,
  background = false,
  speculative = background
): Promise<Job | null> {
  const job = getJob(jobId)
  if (!job) return Promise.resolve(null)

  // Already cached — no network at all. This is the common case after the first view.
  if (job.description) return Promise.resolve(job)

  const existing = inflight.get(jobId)
  if (existing) return existing

  if (failed.has(jobId)) return Promise.resolve(job)

  // Only *guesses* are capped. Work the user asked for — even indirectly, like
  // verifying the remote filter — is queued in full, just at background priority.
  if (speculative) {
    if (prefetching >= MAX_PREFETCH_IN_FLIGHT) return Promise.resolve(job)
    prefetching++
  }

  const run = fetchJobDetail(job.url, background ? 'background' : 'interactive')
    .then((detail) => {
      if (!detail?.description) {
        failed.add(jobId)
        return job
      }
      const enriched = enrich(job, detail.description, detail.salaryText, detail.location)
      upsert(enriched)
      return enriched
    })
    .catch(() => {
      failed.add(jobId)
      return job
    })
    .finally(() => {
      inflight.delete(jobId)
      if (speculative) prefetching--
    })

  inflight.set(jobId, run)
  return run
}

/** Fire-and-forget warm-up, used when the pointer rests on a card. */
export function prefetchDetail(jobId: string): void {
  void detailFor(jobId, true).catch(() => undefined)
}

/** How many cards a delivered feed warms up. */
const PREFETCH_BATCH = 8

/**
 * Warms a whole screenful at once, in the order the user is likely to read it.
 * Called when a feed is delivered, so the first clicks of a browsing session are
 * already answered from cache.
 */
export function prefetchMany(jobIds: string[]): void {
  for (const id of jobIds.slice(0, PREFETCH_BATCH)) prefetchDetail(id)
}

// -------------------------------------------------------------- remote backfill

/**
 * The Remote filter's missing half.
 *
 * Whether a job is genuinely remote is usually only decidable from the "Job
 * Location:" line at the foot of its description — and a search card carries no
 * description at all. So a listing that really is remote sat in the corpus judged
 * on prose, and the Remote filter looked broken while Indeed's own site showed the
 * job plainly.
 *
 * This fetches the descriptions of everything that *might* be remote, so the
 * verdict is made on the employer's own words. Each job costs this exactly once,
 * ever, because the description is then cached for good.
 */
const MAYBE_REMOTE = /\bremote\b|\bwork from home\b|\bwfh\b|\bwork from anywhere\b|\btelecommut/i

export function couldBeRemote(job: Job): boolean {
  if (job.workMode.mode === 'remote') return false // already settled
  if (job.description) return false // already judged on the full text
  if (job.remoteFlag || job.remoteModel) return true
  return MAYBE_REMOTE.test(`${job.title}\n${job.location}\n${job.snippet}`)
}

/** How many unverified listings one pass will check. Keeps a session polite. */
const VERIFY_BATCH = 12

/**
 * Fetches descriptions for the remote candidates in `jobs` and reports how many
 * came out remote, so the UI can refresh itself once rather than per job.
 */
export async function verifyRemoteCandidates(jobs: Job[]): Promise<number> {
  const candidates = jobs.filter(couldBeRemote).slice(0, VERIFY_BATCH)
  if (candidates.length === 0) return 0

  const results = await Promise.all(
    candidates.map(async (job) => {
      // Interactive lane: the user is sitting on the Remote tab waiting for this
      // answer, so it is foreground work, not a guess.
      const updated = await detailFor(job.id, false, false).catch(() => null)
      return updated?.workMode.mode === 'remote' ? 1 : 0
    })
  )

  return results.reduce((a: number, b: number) => a + b, 0)
}
