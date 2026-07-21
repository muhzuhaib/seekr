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
    workMode: classifyWorkMode(job.title, job.location || location || '', body, false, null)
  }
}

/**
 * The description for a job, from cache when we have it.
 *
 * `background: true` marks a speculative prefetch: it yields the lane to anything
 * the user is actually waiting for, and gives up quietly when the queue is busy.
 */
export function detailFor(jobId: string, background = false): Promise<Job | null> {
  const job = getJob(jobId)
  if (!job) return Promise.resolve(null)

  // Already cached — no network at all. This is the common case after the first view.
  if (job.description) return Promise.resolve(job)

  const existing = inflight.get(jobId)
  if (existing) return existing

  if (background) {
    if (failed.has(jobId)) return Promise.resolve(job)
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
      if (background) prefetching--
    })

  inflight.set(jobId, run)
  return run
}

/** Fire-and-forget warm-up, used when the pointer rests on a card. */
export function prefetchDetail(jobId: string): void {
  void detailFor(jobId, true).catch(() => undefined)
}
