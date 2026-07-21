/**
 * Display formatting. Kept apart from components so the wording of things like the
 * Date Reveal line is defined in exactly one place.
 */

import type { Job, Salary } from '../../../shared/types'

const DAY_MS = 86_400_000

export function daysSince(epoch: number | null, now = Date.now()): number | null {
  if (!epoch) return null
  return Math.floor((now - epoch) / DAY_MS)
}

function absoluteDate(epoch: number): string {
  return new Date(epoch).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
}

function relativePhrase(days: number): string {
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 14) return 'last week'
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  return `${Math.floor(days / 30)} months ago`
}

/**
 * The Date Reveal line: "Published on 16 Jul 2025 (4 days ago)".
 *
 * Indeed usually prints only "5 days ago", so when our timestamp came from a
 * relative string we say "about" rather than implying a precision we don't have.
 */
export function publishedLine(job: Job, now = Date.now()): string {
  if (!job.postedAt) return 'Publication date not shown by Indeed'
  const days = daysSince(job.postedAt, now) ?? 0
  const date = absoluteDate(job.postedAt)
  const prefix = job.postedAtApproximate ? 'Published about' : 'Published on'
  return `${prefix} ${date} (${relativePhrase(days)})`
}

/** Compact version for the card meta row. */
export function publishedShort(job: Job, now = Date.now()): string {
  if (!job.postedAt) return 'Date unknown'
  const days = daysSince(job.postedAt, now) ?? 0
  return `${absoluteDate(job.postedAt)} · ${relativePhrase(days)}`
}

export function isStale(job: Job, staleAfterDays: number, now = Date.now()): boolean {
  const days = daysSince(job.postedAt, now)
  return days !== null && days >= staleAfterDays
}

// ---------------------------------------------------------------- salary

const CURRENCY_PREFIX: Record<string, string> = {
  USD: '$',
  GBP: '£',
  EUR: '€',
  INR: '₹',
  PKR: 'Rs ',
  CAD: 'C$',
  AUD: 'A$',
  SGD: 'S$',
  AED: 'AED ',
  ZAR: 'R'
}

export function money(amount: number, currency: string): string {
  const symbol = CURRENCY_PREFIX[currency] ?? `${currency} `
  const rounded =
    amount >= 1_000_000
      ? `${(amount / 1_000_000).toFixed(1)}M`
      : amount >= 1000
        ? `${Math.round(amount / 1000)}k`
        : String(Math.round(amount))
  return `${symbol}${rounded}`
}

/**
 * Prefers Indeed's own wording — it carries nuance ("plus commission") that a
 * normalised range would throw away. Falls back to our yearly figures.
 */
export function salaryLabel(salary: Salary | null): string | null {
  if (!salary) return null
  if (salary.raw) return salary.raw
  if (salary.minYearly === null) return null
  const min = money(salary.minYearly, salary.currency)
  if (salary.maxYearly && salary.maxYearly !== salary.minYearly) {
    return `${min} – ${money(salary.maxYearly, salary.currency)} a year`
  }
  return `${min} a year`
}

export function workModeLabel(job: Job): string {
  switch (job.workMode.mode) {
    case 'remote':
      return 'Remote'
    case 'hybrid':
      return 'Hybrid'
    case 'onsite':
      return 'On-site'
    default:
      return 'Unspecified'
  }
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function shortDate(epoch: number): string {
  return new Date(epoch).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
}
