/**
 * The fetcher.
 *
 * Seekr has no API to call, so it loads real Indeed pages in an offscreen Chromium
 * window that shares one persistent session with the login and apply panels. That
 * shared session is what makes a single sign-in cover the whole app.
 *
 * Every navigation goes through `throttle.schedule`, so no matter how eagerly the
 * UI asks for data, Seekr browses one page at a time at human pace.
 */

import { BrowserWindow, session } from 'electron'
import type { FeedFilter, Job, Region } from '../shared/types'
import { LOOKBACK_DAYS } from '../shared/types'
import {
  buildAuthExtractor,
  buildDetailExtractor,
  buildSearchExtractor,
  type ExtractionResult
} from './extract'
import { normaliseJob } from './normalize'
import type { Lane } from './throttle'
import { cooldownRemaining, penalise, reward, schedule } from './throttle'

/** One partition for the whole app — ingest, login and apply all share this jar. */
export const PARTITION = 'persist:indeed'

/**
 * We deliberately do NOT override the User-Agent.
 *
 * An earlier build claimed `Chrome/131`, but the browser's own client hints report
 * `Chromium=130` — and Cloudflare ties its clearance token to the client fingerprint.
 * You'd pass the check as one browser and make the next request as a different one,
 * so the clearance was rejected and a fresh challenge issued every single time. That
 * was the cause of the endless verification loop.
 *
 * Electron's default UA is internally consistent and honest about what this app is.
 * Do not "fix" this by inventing a UA again.
 */

// Pages walked per feed refresh. They are now fetched concurrently (the throttle
// still paces them), so a deeper feed no longer costs proportionally more time.
const PAGES_PER_FEED = 3
const RESULTS_PER_PAGE = 15

/**
 * Reader windows.
 *
 * There used to be exactly one, which meant every description the user opened
 * queued behind whatever else was loading. The pool lets a few pages load at once
 * — the throttle still decides how fast anything may start, so this widens the
 * pipe without changing the pacing rules.
 *
 * Index 0 is the *primary*: search, the auth probe and the Cloudflare check all
 * use it, so the one window the user ever sees is the one that gets challenged.
 */
const MAX_WINDOWS = 4
const pool: BrowserWindow[] = []
const busy = new Set<BrowserWindow>()

export function indeedSession(): Electron.Session {
  return session.fromPartition(PARTITION)
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 860,
    title: 'Indeed',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: PARTITION,
      // The page is untrusted third-party content. It gets no Node, no preload,
      // and its own isolated context — we only ever read strings out of it.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Must stay false. When Chromium throttles a hidden window, Cloudflare's
      // verification widget never finishes running, so the check can never be
      // passed and every fetch re-challenges forever.
      backgroundThrottling: false
      // NOTE: images are deliberately left ON. Disabling them was faster, but the
      // verification widget could not render, which made the check unsolvable in
      // this window — the cause of the endless re-verification loop.
    }
  })

  win.on('closed', () => {
    const i = pool.indexOf(win)
    if (i >= 0) pool.splice(i, 1)
    busy.delete(win)
  })

  return win
}

/**
 * The window the user might actually see: the one that shows the verification
 * check, and the one search and the auth probe use.
 */
function getWorker(): BrowserWindow {
  if (pool[0] && !pool[0].isDestroyed()) return pool[0]
  const win = createWindow()
  pool.unshift(win)
  return win
}

/** A free reader window, growing the pool up to `MAX_WINDOWS` on demand. */
function acquireWindow(preferPrimary: boolean): BrowserWindow {
  if (preferPrimary) {
    const primary = getWorker()
    busy.add(primary)
    return primary
  }

  for (const win of pool) {
    if (!win.isDestroyed() && !busy.has(win)) {
      busy.add(win)
      return win
    }
  }

  if (pool.length < MAX_WINDOWS) {
    const win = createWindow()
    pool.push(win)
    busy.add(win)
    return win
  }

  // Every window is busy — fall back to the primary rather than refusing work.
  // The throttle caps concurrency below MAX_WINDOWS, so this is a safety net only.
  const win = getWorker()
  busy.add(win)
  return win
}

function releaseWindow(win: BrowserWindow): void {
  busy.delete(win)
}

export function destroyWorker(): void {
  for (const win of [...pool]) {
    if (!win.isDestroyed()) win.destroy()
  }
  pool.length = 0
  busy.clear()
}

/** True while the user is being asked to clear a check, so we never stack windows. */
let resolvingChallenge = false

/**
 * Shows the fetcher's *own* window so the user can clear Cloudflare's check in the
 * exact browsing context that was blocked, then hides it again and reports success.
 *
 * Doing it in this window matters. An earlier build opened a separate panel at a
 * different URL; the user would pass the check there, but the fetcher's own window
 * was still sitting on an unsolved challenge, so the next request challenged again
 * and the app looped forever. Same window, same context, one check.
 */
export function resolveChallengeInteractively(): Promise<boolean> {
  if (resolvingChallenge) return Promise.resolve(false)
  const win = getWorker()
  if (win.isDestroyed()) return Promise.resolve(false)

  resolvingChallenge = true
  win.show()
  win.focus()

  return new Promise<boolean>((resolve) => {
    let settled = false

    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(giveUp)
      resolvingChallenge = false
      if (!win.isDestroyed()) {
        win.removeListener('closed', onClosed)
        win.hide()
      }
      resolve(ok)
    }

    // Closing the window is the user saying "not now".
    const onClosed = (): void => finish(false)
    win.on('closed', onClosed)

    // Watch for the challenge clearing itself. Cloudflare reloads the page on
    // success, so we poll the document rather than listening for one event.
    const poll = setInterval(() => {
      if (win.isDestroyed()) return finish(false)
      win.webContents
        .executeJavaScript(
          `(function () {
             var t = (document.title || '').toLowerCase();
             var blocked = t.indexOf('just a moment') >= 0 ||
                           t.indexOf('verify') >= 0 ||
                           t.indexOf('security check') >= 0 ||
                           !!document.querySelector('#challenge-running, form#challenge-form');
             return !blocked;
           })()`,
          true
        )
        .then((cleared: boolean) => {
          if (cleared) finish(true)
        })
        .catch(() => undefined)
    }, 1500)

    // Don't hold a window open forever if the user walks away.
    const giveUp = setTimeout(() => finish(false), 5 * 60_000)
  })
}

// ---------------------------------------------------------------- urls

/**
 * Indeed's own "Remote" refinement, as it appears in their URL when you tick the
 * Remote box on the results page. Asking Indeed for remote jobs is far better than
 * fetching a general feed and hoping our classifier rescues the remote ones — it
 * is their structured data doing the filtering.
 */
const INDEED_REMOTE_REFINEMENT = 'attr(DSQF7)'

export function buildSearchUrl(
  region: Region,
  query: string,
  filter: FeedFilter,
  page: number,
  /** Ask Indeed itself for remote-only results. */
  remoteOnly = false
): string {
  const params = new URLSearchParams()

  /*
    Never send an empty query AND an empty location together. Indeed treats that as
    a malformed search and silently redirects to its homepage
    (`/?from=jobsearch-empty-whatwhere`), which has no job cards on it at all — so
    extraction found nothing and blamed a "layout change" that had not happened.

    Setting the location to the region keeps a keyword-less feed valid: it means
    "everything in this country", which is exactly what the homefeed is.
  */
  if (query) params.set('q', query)
  params.set('l', region.label)
  params.set('start', String(page * RESULTS_PER_PAGE))

  // Indeed only offers date and relevance sorting. "Recent" maps to date; the other
  // two are ranked by Seekr after ingestion, since Indeed exposes neither a
  // popularity figure nor a salary sort. All three now look back a full 30 days.
  params.set('sort', filter === 'recent' ? 'date' : 'relevance')
  params.set('fromage', String(LOOKBACK_DAYS))

  if (remoteOnly) params.set('sc', `0kf:${INDEED_REMOTE_REFINEMENT};`)

  return `https://${region.domain}/jobs?${params.toString()}`
}

// ---------------------------------------------------------------- fetching

export class BotChallengeError extends Error {
  constructor() {
    super('Indeed is showing a verification check')
    this.name = 'BotChallengeError'
  }
}

export class RateLimitedError extends Error {
  constructor(public readonly waitMs: number) {
    super('Indeed is rate-limiting us')
    this.name = 'RateLimitedError'
  }
}

/**
 * Loads one URL and runs an extractor against it. Distinguishes the two failures
 * that actually matter — rate limiting and bot challenges — so callers can react
 * differently instead of treating everything as a generic error.
 */
const NAV_TIMEOUT_MS = 12_000
const EXTRACT_TIMEOUT_MS = 8_000

/** Rejects if the promise hasn't settled in time, so nothing can wedge the queue. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * Resolves once the page stops loading, or when the deadline passes — whichever
 * comes first. Never rejects: a page that keeps reloading (which is exactly what a
 * verification interstitial does) is still worth reading, because reading it is how
 * we find out it's a challenge.
 */
function waitForPageSettled(wc: Electron.WebContents, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      wc.removeListener('did-stop-loading', finish)
      resolve()
    }
    wc.once('did-stop-loading', finish)
    const deadline = setTimeout(finish, ms)
  })
}

/**
 * How long we keep re-reading a page that loaded but hasn't rendered its content
 * yet. Indeed hydrates its cards client-side, so there is a window where the DOM
 * is present but empty.
 *
 * This used to be a flat 600 ms sleep on *every* fetch, paid whether the page
 * needed it or not. Polling instead means a page that is already complete is read
 * immediately, and a slow one still gets more grace than it used to.
 */
const SETTLE_POLL_MS = 120
const SETTLE_BUDGET_MS = 1200

interface LoadOptions {
  lane?: Lane
  /** Use the window the user can be shown (search, auth, challenge). */
  primary?: boolean
  /** Returns true once the extraction is worth keeping, ending the poll early. */
  isComplete?: (result: ExtractionResult) => boolean
}

async function loadAndExtract(
  url: string,
  extractor: string,
  options: LoadOptions = {}
): Promise<ExtractionResult> {
  const { lane = 'background', primary = false, isComplete } = options

  return schedule(async () => {
    const win = acquireWindow(primary)
    const wc = win.webContents

    // `did-navigate` carries the HTTP status, which is how we tell a real page from
    // a 429 that happens to render as HTML.
    let statusCode = 200
    const onNavigate = (_e: unknown, _url: string, httpResponseCode: number) => {
      if (httpResponseCode) statusCode = httpResponseCode
    }
    wc.on('did-navigate', onNavigate)

    try {
      // Deliberately not awaiting loadURL's promise. A verification page reloads
      // itself repeatedly, and each reload aborts the previous navigation, so that
      // promise may never settle — which used to hang the whole fetch. Instead we
      // kick off the navigation, swallow the aborts, and wait for the page to go
      // quiet or for a deadline, then read whatever is actually there.
      void wc.loadURL(url).catch(() => undefined)

      await waitForPageSettled(wc, NAV_TIMEOUT_MS)

      /*
        Read straight away, then keep re-reading only while the page still has
        nothing for us. Most pages answer on the first attempt, which is where the
        old flat 600 ms sleep went from "safe" to "pure latency".
      */
      const deadline = Date.now() + SETTLE_BUDGET_MS
      let result = (await withTimeout(
        wc.executeJavaScript(extractor, true),
        EXTRACT_TIMEOUT_MS,
        'extraction timed out'
      )) as ExtractionResult

      while (!result.challenged && isComplete && !isComplete(result) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, SETTLE_POLL_MS))
        result = (await withTimeout(
          wc.executeJavaScript(extractor, true),
          EXTRACT_TIMEOUT_MS,
          'extraction timed out'
        )) as ExtractionResult
      }

      if (result.challenged) {
        penalise()
        throw new BotChallengeError()
      }

      if (statusCode === 429 || statusCode === 403) {
        const wait = penalise()
        throw new RateLimitedError(wait)
      }

      reward()
      return result
    } finally {
      wc.removeListener('did-navigate', onNavigate)
      releaseWindow(win)
    }
  }, lane)
}

export interface IngestOptions {
  region: Region
  /** Search terms. Empty string means "whatever Indeed shows for this region". */
  query: string
  filter: FeedFilter
  pages?: number
  /** Ask Indeed for remote-only results, using its own refinement. */
  remoteOnly?: boolean
  onProgress?: (done: number, total: number) => void
  /** Fired when we're about to ask the user to clear a verification check. */
  onChallenge?: () => void
}

export interface IngestOutcome {
  jobs: Job[]
  /** Set when something went wrong in a way the user should hear about. */
  warning: string | null
  health: number
}

/**
 * Walks a few pages of results and returns normalised jobs. Partial failure is
 * fine and expected: if page 3 gets rate-limited we keep pages 1–2 rather than
 * throwing away good data.
 */
export async function ingestFeed(options: IngestOptions): Promise<IngestOutcome> {
  const { region, query, filter, pages = PAGES_PER_FEED, remoteOnly = false, onProgress } = options
  const extractor = buildSearchExtractor()

  /** A results page is worth reading the moment it actually has cards on it. */
  const hasCards = (r: ExtractionResult): boolean => r.jobs.length > 0

  const jobs: Job[] = []
  const seen = new Set<string>()
  let warning: string | null = null
  let healthSum = 0
  let healthCount = 0
  let done = 0

  const collect = (result: ExtractionResult, page: number): void => {
    healthSum += result.health
    healthCount++
    for (const raw of result.jobs) {
      if (seen.has(raw.id)) continue
      seen.add(raw.id)
      // Rank is per-page; make it global so the "top jobs" score is comparable.
      raw.rank += page * RESULTS_PER_PAGE
      jobs.push(normaliseJob(raw, region.code, region.currency, query, Date.now(), remoteOnly))
    }
    onProgress?.(++done, pages)
  }

  const describe = (err: unknown): string => {
    if (err instanceof BotChallengeError) {
      return "Indeed's verification check wasn't completed, so no new listings could be loaded. Press Refresh to try again — the check opens in a window, and once you pass it Seekr carries on from where it stopped."
    }
    if (err instanceof RateLimitedError) {
      const mins = Math.ceil(err.waitMs / 60_000)
      return `Indeed asked Seekr to slow down. Pausing for about ${mins} minute${mins === 1 ? '' : 's'}.`
    }
    return `Could not load results: ${(err as Error).message}`
  }

  /*
    Page 1 goes first and alone, in the window the user can be shown. If Indeed
    challenges, this is where it happens, and clearing it once covers the rest —
    firing all the pages at once would have popped the check mid-flight with two
    other requests already in the air.
  */
  try {
    const firstUrl = buildSearchUrl(region, query, filter, 0, remoteOnly)
    const firstOptions = { lane: 'interactive' as const, primary: true, isComplete: hasCards }

    let first: ExtractionResult
    try {
      first = await loadAndExtract(firstUrl, extractor, firstOptions)
    } catch (err) {
      if (!(err instanceof BotChallengeError)) throw err

      options.onChallenge?.()
      const cleared = await resolveChallengeInteractively()
      if (!cleared) throw err

      // The check is passed, so the back-off it earned no longer applies.
      reward()
      first = await loadAndExtract(firstUrl, extractor, firstOptions)
    }
    collect(first, 0)

    /*
      The remaining pages go out together. They are still paced by the throttle —
      it just no longer insists on a full 2.5 s of dead time between pages the
      user is sitting and waiting for.
    */
    if (first.jobs.length > 0 && pages > 1) {
      const rest = await Promise.allSettled(
        Array.from({ length: pages - 1 }, (_, i) => i + 1).map(async (page) => ({
          page,
          result: await loadAndExtract(
            buildSearchUrl(region, query, filter, page, remoteOnly),
            extractor,
            { lane: 'interactive' as const, isComplete: hasCards }
          )
        }))
      )

      for (const outcome of rest) {
        if (outcome.status === 'fulfilled') collect(outcome.value.result, outcome.value.page)
        else if (!warning) warning = describe(outcome.reason)
      }

      // A deep page failing while page 1 worked is not worth alarming anyone about.
      if (jobs.length > 0) warning = null
    }
  } catch (err) {
    warning = describe(err)
  }

  const health = healthCount ? healthSum / healthCount : 0

  // Low yield with no other explanation almost always means Indeed changed markup.
  if (!warning && healthCount > 0 && health < 0.4) {
    warning =
      "Seekr read the page but recognised very little of it — Indeed has probably changed their layout. Job data may be incomplete."
  }

  return { jobs, warning, health }
}

// ---------------------------------------------------------------- detail

export interface JobDetail {
  description: string | null
  salaryText: string | null
  location: string | null
}

/**
 * Fetches one job's full description. Needed in two places: caching a listing at
 * apply time, and giving the work-mode classifier the whole body rather than a
 * snippet when it has to judge a "remote" claim.
 */
export async function fetchJobDetail(
  url: string,
  lane: Lane = 'interactive'
): Promise<JobDetail | null> {
  try {
    const result = (await loadAndExtract(url, buildDetailExtractor(), {
      lane,
      // A description page is done the moment the description element has text.
      isComplete: (r) => !!(r as unknown as { description?: string | null }).description
    })) as unknown as {
      challenged?: boolean
      description?: string | null
      salaryText?: string | null
      location?: string | null
    }
    if (result.challenged) throw new BotChallengeError()
    return {
      description: result.description ?? null,
      salaryText: result.salaryText ?? null,
      location: result.location ?? null
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- auth probe

/**
 * Checks whether the shared session is signed in. Cheap enough to call on launch
 * and after the login panel closes.
 */
export async function probeAuth(region: Region): Promise<{ loggedIn: boolean; email: string | null }> {
  try {
    const result = (await loadAndExtract(`https://${region.domain}/`, buildAuthExtractor(), {
      primary: true
    })) as unknown as { loggedIn: boolean; email: string | null }
    return { loggedIn: !!result.loggedIn, email: result.email ?? null }
  } catch {
    return { loggedIn: false, email: null }
  }
}

export function currentCooldownMs(): number {
  return cooldownRemaining()
}
