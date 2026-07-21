/**
 * The local job corpus, plus the filtering and ranking that turn it into a feed.
 *
 * The renderer never touches the network — it asks for a feed, and this reads from
 * memory. That is the whole performance story: the UI is always instant because it
 * is always reading a local array.
 */

import type { FeedFilter, FeedQuery, Job, Settings, WorkMode } from '../shared/types'
import { LOOKBACK_DAYS } from '../shared/types'
import { parseSalary } from './normalize'
import { createStore } from './store'

const DAY_MS = 86_400_000

interface CorpusFile {
  jobs: Job[]
}

const store = createStore<CorpusFile>('jobs.json', { jobs: [] })

/** id → job, rebuilt on boot. Keeps merge and lookup O(1). */
const index = new Map<string, Job>()
for (const job of store.get().jobs) index.set(job.id, migrate(job))

/**
 * Brings a stored job up to date with the current rules.
 *
 * Listings are cached indefinitely, so a parsing fix that only applies to newly
 * fetched jobs leaves the old bad data sitting in the feed for ever. Re-parsing
 * the salary from the original string is what removes, for example, a company's
 * review count that once parsed as a £305,500 salary and sorted itself to the top
 * of Highest paid.
 */
function migrate(job: Job): Job {
  const queries = job.queries ?? [job.query ?? '']
  const salary = job.salary?.raw ? parseSalary(job.salary.raw, job.salary.currency) : job.salary
  return { ...job, queries, salary: salary ?? null }
}

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
        // A job belongs to every search it has ever come back from, so arriving
        // via a search never removes it from the home feed and vice versa.
        queries: [...new Set([...(existing.queries ?? [existing.query]), ...job.queries])],
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

  // Freshness matters for "trending" — a hot job from today beats last month's.
  if (job.postedAt) {
    const ageDays = (now - job.postedAt) / DAY_MS
    score += Math.max(0, (LOOKBACK_DAYS - ageDays) / LOOKBACK_DAYS) * 0.4
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
    /*
      Strictly highest pay first — never date. Comparing yearly-normalised figures
      keeps an hourly rate honest against a salary, and the *top* of a range is
      what "highest paid" means to a person reading the list. Ties fall back to the
      bottom of the range, then to recency, so the order is stable rather than
      whatever the corpus happened to be holding.
    */
    const pay = (job: Job): number => job.salary?.maxYearly ?? job.salary?.minYearly ?? -1
    const floor = (job: Job): number => job.salary?.minYearly ?? -1
    return (a, b) => pay(b) - pay(a) || floor(b) - floor(a) || (b.postedAt ?? 0) - (a.postedAt ?? 0)
  }
  return (a, b) => popularityScore(b, now) - popularityScore(a, now)
}

export interface FeedOutput {
  jobs: Job[]
  filteredOut: number
  /** How many jobs cleared the work-mode filter, before salary/date narrowed it. */
  workModeMatches: number
}

/**
 * Applies every filter and sort in one pass. Ordering matters: blocks first (they
 * are absolute), then keywords, then the sub-filters.
 */
export function buildFeed(query: FeedQuery, settings: Settings, now = Date.now()): FeedOutput {
  let removed = 0

  const keywords =
    query.useSavedKeywords && settings.keywordFilterEnabled ? settings.savedKeywords : query.keywords

  /*
    Which searches a listing has to have come from.

    Cached jobs are kept for ever, so without this the home feed slowly became a
    pile of everything ever searched: type "nurse", clear the box, and the feed was
    still nursing jobs under all three filters because they were sitting in the
    corpus and happened to be in the right region. Now the home feed shows the home
    feed — the listings Indeed returns for the region with no search term — and a
    search shows what that search returned.
  */
  const searchTerms = keywords.length > 0 ? keywords.map((k) => k.toLowerCase().trim()) : ['']
  const fromRequestedSearch = (job: Job): boolean => {
    const origins = (job.queries ?? [job.query]).map((q) => q.toLowerCase().trim())
    return searchTerms.some((term) => origins.includes(term))
  }

  const pool = all().filter((job) => job.region === query.region)

  /*
    Counted separately so an empty feed can name the filter that emptied it.
    "Remote" plus "Salary shown" is a genuinely common way to land on zero results
    while dozens of remote jobs exist — they just don't state pay — and a generic
    "no jobs match" left the user thinking the remote filter was broken.
  */
  let workModeMatches = 0

  const kept = pool.filter((job) => {
    if (isBlocked(job, settings)) {
      removed++
      return false
    }
    /*
      With no search term this is the home feed, so only home-feed listings
      qualify. With a search term, a listing qualifies if it came back from that
      search *or* if its text matches — the second half is what lets cached
      results appear instantly while the fresh search is still loading.
    */
    if (keywords.length === 0) {
      if (!fromRequestedSearch(job)) {
        removed++
        return false
      }
    } else if (!fromRequestedSearch(job) && !matchesAnyKeyword(job, keywords)) {
      removed++
      return false
    }
    if (!matchesWorkMode(job, query.workMode, settings.remoteConfidenceFloor)) {
      removed++
      return false
    }
    workModeMatches++
    if (query.requireSalary && !hasSalary(job)) {
      removed++
      return false
    }

    // All three filters look back a full 30 days.
    if (job.postedAt && now - job.postedAt > LOOKBACK_DAYS * DAY_MS) {
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
  return { jobs: kept, filteredOut: removed, workModeMatches }
}

export function clearRegion(region: string): void {
  for (const [id, job] of index) if (job.region === region) index.delete(id)
  persist()
}

export function clearAll(): void {
  index.clear()
  persist()
}
