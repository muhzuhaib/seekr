/**
 * Turns the messy strings Indeed prints into structured, comparable data.
 *
 * Three jobs live here:
 *   1. salary parsing   — "$25 - $30 an hour" → a yearly range we can sort by
 *   2. date resolution  — "Posted 5 days ago"  → an actual timestamp
 *   3. work-mode        — deciding whether "remote" in a listing is real
 */

import type { Job, Salary, WorkMode, WorkModeVerdict } from '../shared/types'
import type { RawJob } from './extract'

// ---------------------------------------------------------------- salary

const HOURS_PER_YEAR = 2080 // 40h × 52w
const DAYS_PER_YEAR = 260
const WEEKS_PER_YEAR = 52
const MONTHS_PER_YEAR = 12

const PERIOD_PATTERNS: [RegExp, Salary['period']][] = [
  [/\b(an?|per|\/)\s*(hour|hr)\b|\bhourly\b/i, 'hour'],
  [/\b(a|per|\/)\s*day\b|\bdaily\b|\bper diem\b/i, 'day'],
  [/\b(a|per|\/)\s*week\b|\bweekly\b/i, 'week'],
  [/\b(a|per|\/)\s*month\b|\bmonthly\b|\bp\.?m\.?\b/i, 'month'],
  [/\b(a|per|\/)\s*(year|annum)\b|\byearly\b|\bannually\b|\bp\.?a\.?\b/i, 'year']
]

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '₹': 'INR',
  '₨': 'PKR',
  'Rs': 'PKR',
  'PKR': 'PKR',
  'AED': 'AED',
  'د.إ': 'AED',
  'R': 'ZAR',
  'C$': 'CAD',
  'A$': 'AUD',
  'S$': 'SGD'
}

/**
 * The point past which an "an hour" figure is certainly a mislabelled yearly
 * salary, per currency. Roughly "ten times the highest real hourly rate anyone
 * advertises", so it never touches a genuine consultant day-rate.
 */
const HOURLY_CEILING: Record<string, number> = {
  USD: 2000,
  GBP: 2000,
  EUR: 2000,
  CAD: 2500,
  AUD: 2500,
  SGD: 2500,
  AED: 8000,
  ZAR: 40_000,
  INR: 200_000,
  PKR: 600_000,
  DEFAULT: 2000
}

function toYearly(amount: number, period: Salary['period']): number {
  switch (period) {
    case 'hour':
      return amount * HOURS_PER_YEAR
    case 'day':
      return amount * DAYS_PER_YEAR
    case 'week':
      return amount * WEEKS_PER_YEAR
    case 'month':
      return amount * MONTHS_PER_YEAR
    default:
      return amount
  }
}

/**
 * Indeed writes salaries a dozen ways. We pull every number out, work out the unit,
 * and normalise to yearly so "£18 an hour" and "£38,000 a year" can be compared.
 *
 * Returns null when the text carries no actual figure — which is exactly what the
 * "hide jobs without salary" toggle keys off.
 */
export function parseSalary(raw: string | null, fallbackCurrency: string): Salary | null {
  if (!raw) return null
  const text = raw.trim()
  if (!text) return null

  // Indeed labels its own guesses. Worth keeping, but flagged.
  const estimated = /estimated|est\./i.test(text)

  let period: Salary['period'] = 'unknown'
  for (const [pattern, value] of PERIOD_PATTERNS) {
    if (pattern.test(text)) {
      period = value
      break
    }
  }

  let currency = fallbackCurrency
  let sawCurrency = false
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    /*
      Letter-based symbols ("R", "Rs", "AED") only count when a number follows.
      Plain `includes` meant the R in "Read what people are saying" registered as
      South African rand, which was half of why a company's review blurb parsed as
      a salary at all.
    */
    const found = /^[A-Za-z]/.test(symbol)
      ? new RegExp(`\\b${symbol}\\s*\\.?\\s*\\d`, 'i').test(text)
      : text.includes(symbol)
    if (found) {
      currency = code
      sawCurrency = true
      break
    }
  }

  /*
    A string is only a salary if it says so.

    The detail page's salary block sometimes falls back to a company card —
    "David Lloyd Clubs1,175 reviews…" — and the bare number in it used to parse as
    £305,500, which then sat proudly at the top of Highest paid. Requiring either a
    currency or a stated period throws that class of thing out, and Indeed always
    prints at least one of the two on a real figure.
  */
  if (!sawCurrency && period === 'unknown') return null
  // No word boundaries: the source text runs words together ("1,175 reviewsRead").
  if (/review|rating|applicant/i.test(text)) return null

  // Grab numbers, tolerating thousands separators and "45k" shorthand.
  const numbers: number[] = []
  const re = /(\d[\d,.\s]*)\s*([kK])?/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const cleaned = match[1].replace(/[,\s]/g, '')
    if (!cleaned || cleaned === '.') continue
    let value = Number.parseFloat(cleaned)
    if (!Number.isFinite(value)) continue
    if (match[2]) value *= 1000
    numbers.push(value)
  }

  if (numbers.length === 0) return null

  // When the unit is unstated, infer it from magnitude: nobody earns 25/year and
  // nobody earns 60,000/hour.
  if (period === 'unknown') {
    const probe = numbers[0]
    if (probe < 200) period = 'hour'
    else if (probe < 2000) period = 'day'
    else if (probe < 30000) period = 'month'
    else period = 'year'
  }

  /*
    Sanity, in that same spirit: some listings *state* a unit that cannot be right
    — "£31,000 - £35,000 an hour" is a yearly salary with the wrong box ticked, and
    left alone it multiplies to £72m and owns the top of Highest paid for ever.

    The ceiling has to be per-currency, or the fix breaks the currencies it was
    never about: PKR 5,000 an hour is an ordinary rate, £5,000 an hour is not.
  */
  const ceiling = HOURLY_CEILING[currency] ?? HOURLY_CEILING.DEFAULT
  if (period === 'hour' && numbers[0] >= ceiling) period = 'year'
  else if (period === 'day' && numbers[0] >= ceiling * 10) period = 'year'

  const yearly = numbers.map((n) => Math.round(toYearly(n, period))).sort((a, b) => a - b)

  // "£0" is not pay. Treat it as no salary rather than sorting it below everything.
  if ((yearly[yearly.length - 1] ?? 0) <= 0) return null

  return {
    minYearly: yearly[0] ?? null,
    maxYearly: yearly.length > 1 ? yearly[yearly.length - 1] : (yearly[0] ?? null),
    currency,
    raw: text,
    period,
    estimated
  }
}

// ---------------------------------------------------------------- dates

const DAY_MS = 86_400_000

/**
 * Indeed almost never prints a real date — it prints "Posted 3 days ago", "Today",
 * "Just posted", or "30+ days ago". We resolve those against now, and flag the
 * result as approximate so the UI can say "about 3 days ago" honestly.
 *
 * This is what powers the Date Reveal feature.
 */
export function resolvePostedAt(
  relative: string | null,
  absoluteEpoch: number | null,
  now = Date.now()
): { postedAt: number | null; approximate: boolean } {
  // If extraction found a real timestamp in the page's embedded JSON, always prefer it.
  if (absoluteEpoch && Number.isFinite(absoluteEpoch) && absoluteEpoch > 0) {
    return { postedAt: absoluteEpoch, approximate: false }
  }

  if (!relative) return { postedAt: null, approximate: true }
  const text = relative.toLowerCase()

  if (/just posted|today|hours? ago|minutes? ago|moments? ago/.test(text)) {
    return { postedAt: now, approximate: true }
  }

  const days = text.match(/(\d+)\+?\s*days?\s*ago/)
  if (days) return { postedAt: now - Number(days[1]) * DAY_MS, approximate: true }

  const weeks = text.match(/(\d+)\+?\s*weeks?\s*ago/)
  if (weeks) return { postedAt: now - Number(weeks[1]) * 7 * DAY_MS, approximate: true }

  const months = text.match(/(\d+)\+?\s*months?\s*ago/)
  if (months) return { postedAt: now - Number(months[1]) * 30 * DAY_MS, approximate: true }

  return { postedAt: null, approximate: true }
}

// ---------------------------------------------------------------- work mode

/**
 * Positive signals. Phrasing that a genuinely remote employer uses and a
 * location-bound one generally does not.
 */
const REMOTE_POSITIVE: [RegExp, number, string][] = [
  [/\b(100%|fully|entirely|completely)\s*remote\b/i, 0.55, 'says fully remote'],
  [/\bwork from anywhere\b/i, 0.5, 'work from anywhere'],
  [/\bremote[-\s]?first\b/i, 0.45, 'remote-first company'],
  [/\banywhere in the (world|country|us|uk)\b/i, 0.45, 'no geographic tie'],
  [/\bwork(ing)?\s+remotely\b/i, 0.4, 'says the work is done remotely'],
  [/\bremote\s+(job|role|position|opportunity|work|working)\b/i, 0.35, 'describes itself as remote work'],
  [/\bno office\b|\bdistributed team\b/i, 0.3, 'distributed team'],
  [/\btelecommut(e|ing)\b/i, 0.25, 'mentions telecommuting'],
  [/\bwork from home\b|\bwfh\b/i, 0.2, 'mentions work from home']
]

/**
 * Indeed puts a structured **Work Location** line at the foot of most descriptions
 * — "Work Location: Remote", "Work Location: In person", "Work Location: Hybrid
 * remote in Lahore". It is a form field the employer filled in, not marketing
 * prose, which makes it the single most trustworthy signal in the body text.
 *
 * We were ignoring it completely, so a listing whose only remote evidence was
 * this line ("Experienced Upwork Bidder (Remote – Pakistan)") was being scored as
 * on-site. Now it is read first and settles the question.
 */
const WORK_LOCATION_FIELD = /\b(?:work|job)\s*location\s*[:\-–—]\s*([^\n\r]{0,60})/i

/**
 * "(Remote)" or "(Remote – Pakistan)" in a job *title* is deliberate labelling by
 * the employer. A country or region in the brackets is still remote — only a
 * specific city would contradict it, and that is caught by the negatives below.
 */
const TITLE_REMOTE = /\(\s*remote\b[^)]*\)|\bremote\b\s*[–—-]\s*\w|^\s*remote\b/i

/**
 * Negative signals — the clickbait detectors. A listing that spams "remote" but
 * carries any of these is very likely an onsite or hybrid role fishing for clicks.
 */
const REMOTE_NEGATIVE: [RegExp, number, string][] = [
  [/\bhybrid\b/i, 0.75, 'says hybrid'],
  [/\b\d+\s*days?\s*(a|per)\s*week\s*(in|at)\s*(the\s*)?office\b/i, 0.8, 'requires office days'],
  [/\bin[-\s]?office\b|\bon[-\s]?site\b|\bonsite\b/i, 0.7, 'mentions on-site work'],
  [/\bmust (be able to )?(reside|live|be based|commute)\b/i, 0.7, 'requires living nearby'],
  [/\bwithin commuting distance\b|\bcommutable\b/i, 0.7, 'requires commuting'],
  [/\brelocat(e|ion)\b/i, 0.5, 'mentions relocation'],
  [/\bremote\s*\(?\s*(hybrid|partial|occasional)\b/i, 0.7, 'only partly remote'],
  [/\boccasional(ly)? (travel|visits?) to (the )?office\b/i, 0.4, 'office visits expected'],
  [/\blocal candidates only\b/i, 0.8, 'local candidates only']
]

/** "Remote in Austin, TX" is an onsite job wearing a hat. */
const LOCATION_REMOTE = /^\s*remote\s*$/i
const LOCATION_HYBRID = /\bhybrid\b/i
/** A concrete place: "Lahore, Punjab", "London EC2", "New York, NY 10001". */
const LOCATION_CONCRETE = /[A-Za-z]{2,}\s*,\s*[A-Za-z]{2,}|\b\d{5}\b|\b[A-Z]{1,2}\d{1,2}[A-Z]?\b/

/**
 * Scores a listing rather than keyword-matching it, because "remote" appears in a
 * huge number of postings that are nothing of the sort. The verdict carries its
 * reasons so the UI can explain any individual decision to the user.
 */
export function classifyWorkMode(
  title: string,
  location: string,
  body: string,
  indeedRemoteFlag: boolean,
  /** Indeed's structured verdict, e.g. `REMOTE_HYBRID`. Authoritative when present. */
  remoteModel: string | null = null
): WorkModeVerdict {
  const text = `${title}\n${location}\n${body}`
  const positives: string[] = []
  const negatives: string[] = []

  /*
    THE most trustworthy signal there is: the structured line Indeed appends to the
    bottom of a description — "Job Location: Remote", "Work Location: In person",
    "Work Location: Hybrid remote in Lahore". The employer filled that field in on a
    form; everything else in the body is marketing prose. It is checked before even
    Indeed's own work model, because it comes from the job page itself rather than
    from the search index, and it is the difference between a genuinely remote job
    being shown and being silently filtered away.
  */
  const workLocation = body.match(WORK_LOCATION_FIELD)?.[1]?.trim()
  if (workLocation) {
    if (/hybrid/i.test(workLocation)) {
      return {
        mode: 'hybrid',
        confidence: 0.95,
        positives: ['the listing states a hybrid work location'],
        negatives: []
      }
    }
    if (/\bin[-\s]?person\b|\bon[-\s]?site\b|\bonsite\b/i.test(workLocation)) {
      return {
        mode: 'onsite',
        confidence: 0.95,
        positives: [],
        negatives: ['the listing states the work location is in person']
      }
    }
    // "Remote", "Remote in Pakistan", "Fully remote" — but not "Remote in Lahore,
    // Punjab", which the concrete-place test below would rightly distrust.
    if (/\bremote\b/i.test(workLocation) && !LOCATION_CONCRETE.test(workLocation)) {
      return {
        mode: 'remote',
        confidence: 1,
        positives: [`the listing states “Job Location: ${workLocation}”`],
        negatives: []
      }
    }
    // A bare place name — "Job Location: Lahore" — is the employer saying on-site.
    if (LOCATION_CONCRETE.test(workLocation) || /^[A-Za-z .'-]{3,}$/.test(workLocation)) {
      return {
        mode: 'onsite',
        confidence: 0.9,
        positives: [],
        negatives: [`the listing gives a physical job location (${workLocation})`]
      }
    }
  }

  /*
    Indeed publishes an explicit work model on most listings. It comes from
    structured employer input rather than marketing prose, so when it exists it
    settles the question and the text heuristics below are only a fallback.
  */
  if (remoteModel) {
    const model = remoteModel.toUpperCase()
    if (model.includes('HYBRID')) {
      return {
        mode: 'hybrid',
        confidence: 0.95,
        positives: ['Indeed lists this as hybrid work'],
        negatives: []
      }
    }
    // "Temporarily remote" is a pandemic-era holdover that means an onsite job.
    if (model.includes('TEMPORAR')) {
      return {
        mode: 'onsite',
        confidence: 0.9,
        positives: [],
        negatives: ['only temporarily remote']
      }
    }
    if (model.includes('REMOTE')) {
      return {
        mode: 'remote',
        confidence: 0.95,
        positives: ['Indeed lists this as a remote role'],
        negatives: []
      }
    }
  }

  let score = 0

  // A title the employer explicitly labelled "(Remote)" is a strong claim; it can
  // still be undercut by the negatives, which is exactly what we want.
  if (TITLE_REMOTE.test(title)) {
    // Weighted to clear the default threshold *on its own*: an employer who wrote
    // "(Remote)" into the title and named no location has made a plain claim, and
    // nothing contradicts it. Any concrete location or office requirement carries a
    // penalty of at least this much, so the clickbait cases still fall through.
    score += 0.6
    positives.push('title says the role is remote')
  }

  // Indeed's own remote tag is a decent signal but not proof — it is set by the
  // employer, which is precisely where the clickbait originates.
  if (indeedRemoteFlag) {
    score += 0.35
    positives.push("tagged remote by Indeed")
  }

  if (LOCATION_REMOTE.test(location)) {
    score += 0.5
    positives.push("location is exactly 'Remote'")
  }

  for (const [pattern, weight, reason] of REMOTE_POSITIVE) {
    if (pattern.test(text)) {
      score += weight
      positives.push(reason)
    }
  }

  let penalty = 0
  for (const [pattern, weight, reason] of REMOTE_NEGATIVE) {
    if (pattern.test(text)) {
      penalty = Math.max(penalty, weight)
      negatives.push(reason)
    }
  }

  // A named city in the location field, with no explicit "remote" alongside it, is
  // the single most reliable tell that a "remote" listing is really onsite.
  const concreteLocation =
    LOCATION_CONCRETE.test(location) && !/remote/i.test(location)
  if (concreteLocation) {
    penalty = Math.max(penalty, 0.6)
    negatives.push('location names a specific place')
  }

  // Hybrid is its own answer, not a weak remote. Check it before deciding remote.
  const hybridSignal = LOCATION_HYBRID.test(location) || /\bhybrid\b/i.test(text)
  if (hybridSignal) {
    return {
      mode: 'hybrid',
      confidence: LOCATION_HYBRID.test(location) ? 0.9 : 0.7,
      positives: ['explicitly described as hybrid'],
      negatives
    }
  }

  const confidence = clamp01(score - penalty)
  const mentionsRemote = /\bremote\b|\bwork from home\b/i.test(text) || indeedRemoteFlag

  let mode: WorkMode
  if (confidence >= 0.6) mode = 'remote'
  else if (mentionsRemote && confidence > 0) mode = 'onsite' // claimed remote, didn't hold up
  else if (location.trim()) mode = 'onsite'
  else mode = 'unknown'

  return { mode, confidence, positives, negatives }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

// ---------------------------------------------------------------- title grouping

/** Seniority markers and level numbers — not part of what the role *is*. */
const TITLE_SENIORITY =
  /\b(senior|snr|sr|junior|jnr|jr|lead|principal|staff|entry[-\s]?level|intern(ship)?|graduate|trainee|i{1,3}|iv|v|\d+)\b/gi

/** Work arrangement is filtered on separately, so it must not split the median. */
const TITLE_WORKMODE = /\b(remote|hybrid|onsite|on[-\s]?site|wfh|work from home|full[-\s]?time|part[-\s]?time|contract|permanent)\b/gi

/**
 * Collapses "Senior Software Engineer II (Remote)" and "Software Engineer" onto the
 * same key, so salary medians pool a large enough sample to mean something.
 *
 * Punctuation is stripped last, after the word-boundary passes, so abbreviations
 * like "Jr." don't leave a stray full stop behind.
 */
export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(TITLE_SENIORITY, ' ')
    .replace(TITLE_WORKMODE, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------- assembly

/** Raw extraction output → the Job shape the rest of the app works with. */
export function normaliseJob(
  raw: RawJob,
  region: string,
  currency: string,
  query: string,
  now = Date.now(),
  /**
   * True when this came back from a search that asked Indeed for remote roles
   * specifically. Indeed's own refinement is structured data, so it counts as a
   * work model — and, like any work model, a "Job Location:" line on the real job
   * page still overrides it once we fetch the description.
   */
  fromRemoteSearch = false
): Job {
  const { postedAt, approximate } = resolvePostedAt(raw.postedRelative, raw.postedEpoch, now)
  const body = `${raw.snippet ?? ''}\n${raw.description ?? ''}`
  const remoteModel = raw.remoteModel ?? (fromRemoteSearch ? 'REMOTE' : null)

  return {
    id: raw.id,
    title: raw.title,
    company: raw.company,
    companyId: raw.companyId,
    location: raw.location,
    url: raw.url,
    postedAt,
    postedAtApproximate: approximate,
    salary: parseSalary(raw.salaryText, currency),
    workMode: classifyWorkMode(raw.title, raw.location, body, raw.remoteFlag, remoteModel),
    snippet: raw.snippet ?? '',
    description: raw.description ?? null,
    rank: raw.rank,
    promoted: raw.promoted,
    urgentlyHiring: raw.urgentlyHiring,
    applicantHint: raw.applicantHint,
    remoteFlag: raw.remoteFlag,
    remoteModel,
    region,
    query,
    queries: [query],
    fetchedAt: now
  }
}
