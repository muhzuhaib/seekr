/**
 * The contract between main and renderer. Both sides import from here so a change
 * to a shape is a compile error rather than a runtime surprise.
 */

// ---------------------------------------------------------------- jobs

export type WorkMode = 'remote' | 'onsite' | 'hybrid' | 'unknown'

/**
 * Why the classifier decided what it decided. Kept on the job so the UI can explain
 * itself ("shown as remote because: location is literally 'Remote'") instead of
 * asking the user to trust a black box.
 */
export interface WorkModeVerdict {
  mode: WorkMode
  /** 0..1 — how sure we are. Below `remoteConfidenceFloor` a job is not shown as remote. */
  confidence: number
  positives: string[]
  negatives: string[]
}

export interface Salary {
  /** Normalised to a yearly figure in `currency` so listings are comparable. */
  minYearly: number | null
  maxYearly: number | null
  currency: string
  /** The original string exactly as Indeed printed it, for display. */
  raw: string
  period: 'hour' | 'day' | 'week' | 'month' | 'year' | 'unknown'
  estimated: boolean
}

export interface Job {
  /** Indeed's job key (`jk` param). Stable, and our primary key. */
  id: string
  title: string
  company: string
  companyId: string | null
  location: string
  url: string

  /** Milliseconds since epoch. Null when Indeed gave us nothing parseable. */
  postedAt: number | null
  /** True when postedAt was derived from a relative string like "5 days ago". */
  postedAtApproximate: boolean

  salary: Salary | null
  workMode: WorkModeVerdict

  /** Snippet from the results page; `description` is filled in on detail fetch. */
  snippet: string
  description: string | null

  /** Signals feeding the "Top jobs" proxy score. */
  rank: number
  promoted: boolean
  urgentlyHiring: boolean
  applicantHint: number | null

  /** Indeed's own remote tag from the search card. Kept so re-classifying a job
   *  after its description arrives doesn't throw the original signals away. */
  remoteFlag: boolean
  /** Indeed's structured work model, e.g. `REMOTE_HYBRID`. Same reason. */
  remoteModel: string | null

  region: string
  /** The search this job most recently arrived from. `''` is the home feed. */
  query: string
  /**
   * Every search this job has arrived from, `''` included.
   *
   * A job seen in the home feed and again in a search belongs to both, and the
   * home feed must show only home-feed listings — otherwise clearing the search
   * box left the results of the last search sitting in the feed for ever.
   */
  queries: string[]
  /** When Seekr ingested it. Used for cache freshness and corpus eviction. */
  fetchedAt: number
}

/**
 * A bookmarked job. The full listing is kept, not a reference, so a saved job
 * survives corpus eviction and outlives the posting being taken down.
 */
export interface SavedJob extends Job {
  savedAt: number
}

export type FeedFilter = 'recent' | 'top' | 'paid'

/**
 * How far back a feed looks, in days. One number, used by the Indeed search URL,
 * the local feed filter, the freshness score and the UI copy — so "the last 30
 * days" can never mean three different things in three places.
 */
export const LOOKBACK_DAYS = 30

export interface FeedQuery {
  filter: FeedFilter
  region: string
  keywords: string[]
  workMode: WorkMode | 'any'
  requireSalary: boolean
  /** Applies the user's saved keyword list. Logged-in only. */
  useSavedKeywords: boolean
}

export interface FeedResult {
  jobs: Job[]
  /** Set when extraction yield collapsed, so the UI can say so honestly. */
  warning: string | null
  fetchedAt: number
  /** How many jobs the filters removed, so "no results" is explainable. */
  filteredOut: number
  /** Of those, how many did match the chosen work mode — lets the empty state
   *  name the filter actually responsible. */
  workModeMatches: number
}

// ---------------------------------------------------------------- salary insight

export interface SalaryInsight {
  /** Null when the corpus sample is too small to say anything honest. */
  percentDiff: number | null
  median: number | null
  sampleSize: number
  currency: string
  label: string
}

// ---------------------------------------------------------------- applications

export type ApplicationStatus = 'applied' | 'viewed' | 'interview' | 'rejected' | 'offer'

export interface Application {
  jobId: string
  title: string
  company: string
  url: string
  appliedAt: number
  status: ApplicationStatus
  notes: string
  /** Epoch ms for the follow-up reminder, null when none set. */
  followUpAt: number | null
  resumeId: string | null
  /** Filename under `cached/` holding the full listing snapshot. */
  cachedListing: string | null
}

// ---------------------------------------------------------------- resumes

export interface Resume {
  id: string
  /** User-facing label. Never sent to Indeed or an employer. */
  title: string
  filename: string
  sizeBytes: number
  addedAt: number
}

export const MAX_RESUMES = 10

/**
 * Outcome of an apply attempt. When Indeed hands off to a company's own site we
 * can't observe whether the user finished, so `askedExternal` tells the UI to ask
 * them — in the app's own dialog, not a native Windows box.
 */
export interface ApplyResult {
  record: Application | null
  askedExternal: boolean
}

// ---------------------------------------------------------------- settings

export type ThemeMode = 'light' | 'dark' | 'system'

export interface Settings {
  /** Null until the user picks a region on first launch. */
  region: string | null
  theme: ThemeMode
  fontFamily: string
  accent: string

  /** Jobs older than this many days are dimmed in the feed. */
  staleAfterDays: number
  /** Minimum classifier confidence before a job counts as genuinely remote. */
  remoteConfidenceFloor: number

  savedKeywords: string[]
  /** Lets the user park their keywords without deleting them. */
  keywordFilterEnabled: boolean
  blockedKeywords: string[]
  blockedCompanies: string[]

  /** Minimum corpus sample before a salary comparison is shown at all. */
  salaryMinSample: number
  corpusLimit: number

  /**
   * How wide the feed runs. 'standard' is the centred reading column, 'wide' uses
   * the full window, 'columns' is a two-up grid. A settled feature: switchable
   * from the feed toolbar and from Settings → Appearance.
   */
  layout: LayoutMode
}

/** See `Settings.layout`. */
export type LayoutMode = 'standard' | 'wide' | 'columns'

/** The three feed widths, described once and used by both places that offer them. */
export const LAYOUTS: { id: LayoutMode; label: string; hint: string }[] = [
  { id: 'standard', label: 'Standard', hint: 'A centred reading column' },
  { id: 'wide', label: 'Full width', hint: 'Cards stretch the whole window' },
  { id: 'columns', label: 'Two columns', hint: 'Cards in a two-up grid' }
]

export const DEFAULT_SETTINGS: Settings = {
  region: null,
  theme: 'system',
  fontFamily: 'Inter',
  accent: '#2563eb',
  staleAfterDays: 15,
  remoteConfidenceFloor: 0.6,
  savedKeywords: [],
  keywordFilterEnabled: false,
  blockedKeywords: [],
  blockedCompanies: [],
  salaryMinSample: 5,
  corpusLimit: 5000,
  layout: 'standard'
}

// ---------------------------------------------------------------- regions

export interface Region {
  code: string
  label: string
  domain: string
  currency: string
}

/** Indeed's country domains. The user picks one on first launch. */
export const REGIONS: Region[] = [
  { code: 'pk', label: 'Pakistan', domain: 'pk.indeed.com', currency: 'PKR' },
  { code: 'us', label: 'United States', domain: 'www.indeed.com', currency: 'USD' },
  { code: 'uk', label: 'United Kingdom', domain: 'uk.indeed.com', currency: 'GBP' },
  { code: 'ca', label: 'Canada', domain: 'ca.indeed.com', currency: 'CAD' },
  { code: 'au', label: 'Australia', domain: 'au.indeed.com', currency: 'AUD' },
  { code: 'ie', label: 'Ireland', domain: 'ie.indeed.com', currency: 'EUR' },
  { code: 'in', label: 'India', domain: 'in.indeed.com', currency: 'INR' },
  { code: 'de', label: 'Germany', domain: 'de.indeed.com', currency: 'EUR' },
  { code: 'fr', label: 'France', domain: 'fr.indeed.com', currency: 'EUR' },
  { code: 'nl', label: 'Netherlands', domain: 'nl.indeed.com', currency: 'EUR' },
  { code: 'es', label: 'Spain', domain: 'es.indeed.com', currency: 'EUR' },
  { code: 'ae', label: 'United Arab Emirates', domain: 'ae.indeed.com', currency: 'AED' },
  { code: 'sg', label: 'Singapore', domain: 'sg.indeed.com', currency: 'SGD' },
  { code: 'za', label: 'South Africa', domain: 'za.indeed.com', currency: 'ZAR' }
]

export function regionByCode(code: string | null): Region {
  return REGIONS.find((r) => r.code === code) ?? REGIONS[1]
}

// ---------------------------------------------------------------- auth / status

export interface AuthState {
  loggedIn: boolean
  email: string | null
  checkedAt: number
}

export interface IngestStatus {
  running: boolean
  /** 'idle' | 'fetching' | 'blocked' | 'error' — drives the status pill in the UI. */
  phase: 'idle' | 'fetching' | 'blocked' | 'error'
  message: string
  progress: number
  /** Set when Indeed rate-limited us, so the UI can show a cooldown. */
  cooldownUntil: number | null
}

// ------------------------------------------------------------------- updates

/**
 * Where the app is in the update cycle.
 *
 * 'unsupported' covers the dev build and any install that isn't packaged — there
 * is nothing to update in place there, and saying so is better than a silent
 * no-op when the user presses "Check for updates".
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'none'
  | 'error'
  | 'unsupported'

export interface UpdateStatus {
  phase: UpdatePhase
  /** The version currently running — also what the Settings panel displays. */
  currentVersion: string
  /** The version waiting to be installed, when there is one. */
  newVersion: string | null
  /** 0–100 while downloading. */
  progress: number
  /** Human-readable detail, shown as-is in the UI. */
  message: string
  /** True only for a check the user pressed the button for, so background
   *  checks never pop a "you're up to date" message at them. */
  manual: boolean
}
