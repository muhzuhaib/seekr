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

// Kept deliberately low. Every extra deep search URL is another chance of tripping
// Indeed's bot check, and two pages already fill the feed.
const PAGES_PER_FEED = 2
const RESULTS_PER_PAGE = 15
const LOOKBACK_DAYS = 10

let worker: BrowserWindow | null = null

export function indeedSession(): Electron.Session {
  return session.fromPartition(PARTITION)
}

/**
 * The offscreen window used for reading. Created lazily and kept alive between
 * fetches — spinning up Chromium per request would be both slow and rude.
 */
function getWorker(): BrowserWindow {
  if (worker && !worker.isDestroyed()) return worker

  worker = new BrowserWindow({
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

  worker.on('closed', () => {
    worker = null
  })

  return worker
}

export function destroyWorker(): void {
  if (worker && !worker.isDestroyed()) worker.destroy()
  worker = null
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

export function buildSearchUrl(
  region: Region,
  query: string,
  filter: FeedFilter,
  page: number
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
  // popularity figure nor a salary sort.
  if (filter === 'recent') {
    params.set('sort', 'date')
    params.set('fromage', String(LOOKBACK_DAYS))
  } else if (filter === 'top') {
    params.set('sort', 'relevance')
    params.set('fromage', String(LOOKBACK_DAYS))
  } else {
    params.set('sort', 'relevance')
    params.set('fromage', '30')
  }

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

async function loadAndExtract(
  url: string,
  extractor: string,
  /** 'interactive' when the user is watching a spinner for this exact page. */
  lane: Lane = 'background'
): Promise<ExtractionResult> {
  return schedule(async () => {
    const win = getWorker()
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

      // Give client-rendered cards a beat to mount before reading the DOM.
      await new Promise((r) => setTimeout(r, 600))

      const result = (await withTimeout(
        wc.executeJavaScript(extractor, true),
        EXTRACT_TIMEOUT_MS,
        'extraction timed out'
      )) as ExtractionResult

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
    }
  }, lane)
}

export interface IngestOptions {
  region: Region
  /** Search terms. Empty string means "whatever Indeed shows for this region". */
  query: string
  filter: FeedFilter
  pages?: number
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
  const { region, query, filter, pages = PAGES_PER_FEED, onProgress } = options
  const extractor = buildSearchExtractor()

  const jobs: Job[] = []
  const seen = new Set<string>()
  let warning: string | null = null
  let healthSum = 0
  let healthCount = 0

  /** Set once the user has already been asked this run — never nag twice. */
  let promptedForChallenge = false

  for (let page = 0; page < pages; page++) {
    const url = buildSearchUrl(region, query, filter, page)

    try {
      let result: ExtractionResult
      try {
        result = await loadAndExtract(url, extractor)
      } catch (err) {
        // A challenge is recoverable: show the window, let the user clear it, and
        // retry this same page once. Anything else propagates.
        if (!(err instanceof BotChallengeError) || promptedForChallenge) throw err
        promptedForChallenge = true

        options.onChallenge?.()
        const cleared = await resolveChallengeInteractively()
        if (!cleared) throw err

        // The check is passed, so the back-off it earned no longer applies.
        reward()
        result = await loadAndExtract(url, extractor)
      }
      healthSum += result.health
      healthCount++

      for (const raw of result.jobs) {
        if (seen.has(raw.id)) continue
        seen.add(raw.id)
        // Rank is per-page; make it global so the "top jobs" score is comparable.
        raw.rank += page * RESULTS_PER_PAGE
        jobs.push(normaliseJob(raw, region.code, region.currency, query))
      }

      onProgress?.(page + 1, pages)

      // No results on an early page means there is nothing more to walk.
      if (result.jobs.length === 0) break
    } catch (err) {
      if (err instanceof BotChallengeError) {
        warning =
          "Indeed's verification check wasn't completed, so no new listings could be loaded. Press Refresh to try again — the check opens in a window, and once you pass it Seekr carries on from where it stopped."
        break
      }
      if (err instanceof RateLimitedError) {
        const mins = Math.ceil(err.waitMs / 60_000)
        warning = `Indeed asked Seekr to slow down. Pausing for about ${mins} minute${mins === 1 ? '' : 's'}.`
        break
      }
      warning = `Could not load results: ${(err as Error).message}`
      break
    }
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
    const result = (await loadAndExtract(url, buildDetailExtractor(), lane)) as unknown as {
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
    const result = (await loadAndExtract(
      `https://${region.domain}/`,
      buildAuthExtractor()
    )) as unknown as { loggedIn: boolean; email: string | null }
    return { loggedIn: !!result.loggedIn, email: result.email ?? null }
  } catch {
    return { loggedIn: false, email: null }
  }
}

export function currentCooldownMs(): number {
  return cooldownRemaining()
}
