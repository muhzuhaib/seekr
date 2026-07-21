/**
 * The local job corpus, plus the filtering and ranking that turn it into a feed.
 *
 * The renderer never touches the network — it asks for a feed, and this reads from
 * memory. That is the whole performance story: the UI is always instant because it
 * is always reading a local array.
 */

import type { FeedFilter, FeedQuery, Job, Settings, WorkMode } from '../shared/types'
import { createStore } from './store'

const DAY_MS = 86_400_000

interface CorpusFile {
  jobs: Job[]
}

const store = createStore<CorpusFile>('jobs.json', { jobs: [] })

/** id → job, rebuilt on boot. Keeps merge and lookup O(1). */
const index = new Map<string, Job>()
for (const job of store.get().jobs) index.set(job.id, job)

// ---------------------------------------------------------------- writing

/**
 * Merges freshly ingested jobs in. Newer data wins, except that we never let a
 * later fetch overwrite a real description or an exact timestamp with a null.
 */
export function merge(jobs: Job[], corpusLimit: number): void {
  for (const job of jobs) {
    const existing = index.get(job.id)
    if (existing) {
      index.set(job.id, {
        ...existing,
        ...job,
        description: job.description ?? existing.description,
        postedAt: job.postedAtApproximate && existing.postedAt && !existing.postedAtApproximate
          ? existing.postedAt
          : (job.postedAt ?? existing.postedAt),
        postedAtApproximate:
          existing.postedAt && !existing.postedAtApproximate
            ? false
            : job.postedAtApproximate
      })
    } else {
      index.set(job.id, job)
    }
  }
  evict(corpusLimit)
  persist()
}

export function upsert(job: Job): void {
  index.set(job.id, job)
  persist()
}

export function getJob(id: string): Job | null {
  return index.get(id) ?? null
}

export function all(): Job[] {
  return [...index.values()]
}

/** Oldest-fetched jobs go first, so the file stays a few megabytes forever. */
function evict(limit: number): void {
  if (index.size <= limit) return
  const sorted = [...index.values()].sort((a, b) => a.fetchedAt - b.fetchedAt)
  const drop = sorted.slice(0, index.size - limit)
  for (const job of drop) index.delete(job.id)
}

function persist(): void {
  store.set({ jobs: [...index.values()] })
}

// ---------------------------------------------------------------- filtering

function matchesAnyKeyword(job: Job, keywords: string[]): boolean {
  if (keywords.length === 0) return true
  const haystack = `${job.title} ${job.company} ${job.snippet} ${job.description ?? ''}`.toLowerCase()
  return keywords.some((k) => haystack.includes(k.toLowerCase().trim()))
}

/**
 * Block keywords are checked against the whole listing — title, company, snippet
 * and full description — because the spec is explicit that a blocked word anywhere
 * removes the listing.
 */
function isBlocked(job: Job, settings: Settings): boolean {
  const haystack =
    `${job.title} ${job.company} ${job.location} ${job.snippet} ${job.description ?? ''}`.toLowerCase()

  for (const word of settings.blockedKeywords) {
    const w = word.toLowerCase().trim()
    if (w && haystack.includes(w)) return true
  }

  const company = job.company.toLowerCase().trim()
  for (const blocked of settings.blockedCompanies) {
    const b = blocked.toLowerCase().trim()
    if (b && company === b) return true
    // Also catch "Acme Corp" when the user blocked "Acme".
    if (b && company.includes(b)) return true
  }

  return false
}

function matchesWorkMode(job: Job, want: WorkMode | 'any', floor: number): boolean {
  if (want === 'any') return true
  if (want === 'remote') {
    // The clickbait guard: claiming remote is not enough, the classifier has to agree.
    return job.workMode.mode === 'remote' && job.workMode.confidence >= floor
  }
  if (want === 'hybrid') return job.workMode.mode === 'hybrid'
  if (want === 'onsite') return job.workMode.mode === 'onsite'
  return true
}

function hasSalary(job: Job): boolean {
  return !!job.salary && job.salary.minYearly !== null
}

// ---------------------------------------------------------------- ranking

/**
 * "Top jobs" proxy. Indeed publishes no popularity number, so this blends the
 * signals that do exist. The UI labels the result an estimate rather than claiming
 * it is Indeed's own ranking.
 */
export function popularityScore(job: Job, now = Date.now()): number {
  let score = 0

  // Indeed's own result ordering is the strongest available relevance signal.
  score += Math.max(0, 60 - job.rank) / 60

  if (job.urgentlyHiring) score += 0.35
  if (job.promoted) score += 0.15
  if (job.applicantHint !== null) score += Math.min(job.applicantHint / 100, 0.5)

  // Freshness matters for "trending" — a hot job from today beats one from day nine.
  if (job.postedAt) {
    const ageDays = (now - job.postedAt) / DAY_MS
    score += Math.max(0, (10 - ageDays) / 10) * 0.4
  }

  // A stated salary correlates with a serious, well-engaged posting.
  if (hasSalary(job)) score += 0.1

  return score
}

function sortFor(filter: FeedFilter, now: number): (a: Job, b: Job) => number {
  if (filter === 'recent') {
    return (a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0)
  }
  if (filter === 'paid') {
    return (a, b) => {
      // Comparing yearly-normalised maxima keeps hourly and salaried roles honest
      // against each other.
      const av = a.salary?.maxYearly ?? a.salary?.minYearly ?? -1
      const bv = b.salary?.maxYearly ?? b.salary?.minYearly ?? -1
      return bv - av
    }
  }
  return (a, b) => popularityScore(b, now) - popularityScore(a, now)
}

export interface FeedOutput {
  jobs: Job[]
  filteredOut: number
}

/**
 * Applies every filter and sort in one pass. Ordering matters: blocks first (they
 * are absolute), then keywords, then the sub-filters.
 */
export function buildFeed(query: FeedQuery, settings: Settings, now = Date.now()): FeedOutput {
  const pool = all().filter((job) => job.region === query.region)
  let removed = 0

  const keywords =
    query.useSavedKeywords && settings.keywordFilterEnabled ? settings.savedKeywords : query.keywords

  const kept = pool.filter((job) => {
    if (isBlocked(job, settings)) {
      removed++
      return false
    }
    if (!matchesAnyKeyword(job, keywords)) {
      removed++
      return false
    }
    if (!matchesWorkMode(job, query.workMode, settings.remoteConfidenceFloor)) {
      removed++
      return false
    }
    if (query.requireSalary && !hasSalary(job)) {
      removed++
      return false
    }

    // Recent and Top are both defined as "the last 10 days".
    if (query.filter !== 'paid' && job.postedAt && now - job.postedAt > 10 * DAY_MS) {
      removed++
      return false
    }

    // Highest-paid is meaningless for a listing with no salary.
    if (query.filter === 'paid' && !hasSalary(job)) {
      removed++
      return false
    }

    return true
  })

  kept.sort(sortFor(query.filter, now))
  return { jobs: kept, filteredOut: removed }
}

export function clearRegion(region: string): void {
  for (const [id, job] of index) if (job.region === region) index.delete(id)
  persist()
}

export function clearAll(): void {
  index.clear()
  persist()
}
