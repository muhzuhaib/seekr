/**
 * Salary insights.
 *
 * There is no free, permitted salary API — Indeed's is partner-only and Glassdoor
 * actively blocks automated access. Rather than bolt on a second fragile scraper,
 * Seekr compares a job against its *own* corpus: the median for the same normalised
 * title in the same region across every listing it has ingested.
 *
 * The honesty rule: below `salaryMinSample` comparable listings we say "not enough
 * data yet" rather than inventing a confident-sounding percentage from three rows.
 */

import type { Job, SalaryInsight } from '../shared/types'
import { all } from './corpus'
import { normaliseTitle } from './normalize'

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** The midpoint of a range is the fairest single number to compare against. */
function midpoint(job: Job): number | null {
  const s = job.salary
  if (!s || s.minYearly === null) return null
  return s.maxYearly !== null ? (s.minYearly + s.maxYearly) / 2 : s.minYearly
}

function label(percentDiff: number): string {
  const magnitude = Math.abs(Math.round(percentDiff))
  if (magnitude < 5) return 'About average'
  if (percentDiff > 0) return `${magnitude}% above average`
  return `${magnitude}% below average`
}

/**
 * Compares one job's pay against comparable listings.
 *
 * "Comparable" means: same region, same normalised title, has a salary, and isn't
 * the job itself. Currency mismatches are excluded rather than converted — Seekr has
 * no exchange-rate source, and a wrong conversion is worse than no comparison.
 */
export function insightFor(job: Job, minSample: number): SalaryInsight {
  const target = midpoint(job)
  const currency = job.salary?.currency ?? ''

  const empty: SalaryInsight = {
    percentDiff: null,
    median: null,
    sampleSize: 0,
    currency,
    label: 'Not enough data yet'
  }

  if (target === null) return empty

  const key = normaliseTitle(job.title)
  if (!key) return empty

  const peers: number[] = []
  for (const other of all()) {
    if (other.id === job.id) continue
    if (other.region !== job.region) continue
    if (other.salary?.currency !== currency) continue
    if (normaliseTitle(other.title) !== key) continue
    const value = midpoint(other)
    if (value !== null) peers.push(value)
  }

  if (peers.length < minSample) {
    return { ...empty, sampleSize: peers.length }
  }

  const med = median(peers)
  if (med <= 0) return { ...empty, sampleSize: peers.length }

  const percentDiff = ((target - med) / med) * 100

  return {
    percentDiff,
    median: med,
    sampleSize: peers.length,
    currency,
    label: label(percentDiff)
  }
}
