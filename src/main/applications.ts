/**
 * Application tracking, and the listing snapshot that outlives the posting.
 *
 * Indeed returns 404 for deleted jobs, which is how people lose the description of
 * a role they are about to interview for. When the user applies, Seekr writes the
 * whole listing to a plain .txt file — no images, no assets, a couple of kilobytes —
 * so it is still readable months later.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Application, ApplicationStatus, Job } from '../shared/types'
import { createStore, dataPath, ensureDir } from './store'

interface ApplicationsFile {
  applications: Application[]
}

const store = createStore<ApplicationsFile>('applications.json', { applications: [] })

function cacheDir(): string {
  return ensureDir(dataPath('cached'))
}

export function listApplications(): Application[] {
  return [...store.get().applications].sort((a, b) => b.appliedAt - a.appliedAt)
}

export function hasApplied(jobId: string): boolean {
  return store.get().applications.some((a) => a.jobId === jobId)
}

// ---------------------------------------------------------------- snapshot

function formatDate(epoch: number | null): string {
  if (!epoch) return 'Unknown'
  return new Date(epoch).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
}

/**
 * A readable plain-text snapshot. Deliberately simple: this file needs to still make
 * sense in five years opened in Notepad.
 */
function renderListing(job: Job): string {
  const lines: string[] = []
  lines.push(job.title)
  lines.push('='.repeat(job.title.length))
  lines.push('')
  lines.push(`Company:   ${job.company}`)
  lines.push(`Location:  ${job.location}`)
  lines.push(`Work mode: ${job.workMode.mode}`)
  if (job.salary) lines.push(`Salary:    ${job.salary.raw}`)
  lines.push(`Published: ${formatDate(job.postedAt)}${job.postedAtApproximate ? ' (approximate)' : ''}`)
  lines.push(`Source:    ${job.url}`)
  lines.push(`Saved by Seekr on ${formatDate(Date.now())}`)
  lines.push('')
  lines.push('-'.repeat(60))
  lines.push('')
  lines.push(job.description?.trim() || job.snippet || '(No description was available when this was saved.)')
  lines.push('')
  return lines.join('\n')
}

export function cacheListing(job: Job): string {
  const filename = `${job.id}.txt`
  writeFileSync(join(cacheDir(), filename), renderListing(job), 'utf8')
  return filename
}

export function readCachedListing(filename: string): string | null {
  const path = join(cacheDir(), filename)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- records

/**
 * Records an application and snapshots the listing in one step. Idempotent — if the
 * user re-applies or the submit detector fires twice, we update rather than duplicate.
 */
export function recordApplication(job: Job, resumeId: string | null): Application {
  const existing = store.get().applications.find((a) => a.jobId === job.id)
  const cachedListing = cacheListing(job)

  if (existing) {
    const updated: Application = { ...existing, cachedListing, resumeId: resumeId ?? existing.resumeId }
    store.set({
      applications: store.get().applications.map((a) => (a.jobId === job.id ? updated : a))
    })
    return updated
  }

  const application: Application = {
    jobId: job.id,
    title: job.title,
    company: job.company,
    url: job.url,
    appliedAt: Date.now(),
    status: 'applied',
    notes: '',
    followUpAt: null,
    resumeId,
    cachedListing
  }

  store.set({ applications: [...store.get().applications, application] })
  return application
}

export function updateApplication(
  jobId: string,
  patch: Partial<Pick<Application, 'status' | 'notes' | 'followUpAt'>>
): Application[] {
  store.set({
    applications: store.get().applications.map((a) => (a.jobId === jobId ? { ...a, ...patch } : a))
  })
  return listApplications()
}

export function setStatus(jobId: string, status: ApplicationStatus): Application[] {
  return updateApplication(jobId, { status })
}

/** Convenience for the "Follow up in N days" buttons. */
export function setFollowUpInDays(jobId: string, days: number | null): Application[] {
  return updateApplication(jobId, {
    followUpAt: days === null ? null : Date.now() + days * 86_400_000
  })
}

export function deleteApplication(jobId: string): Application[] {
  const record = store.get().applications.find((a) => a.jobId === jobId)
  if (record?.cachedListing) {
    const path = join(cacheDir(), record.cachedListing)
    if (existsSync(path)) rmSync(path, { force: true })
  }
  store.set({ applications: store.get().applications.filter((a) => a.jobId !== jobId) })
  return listApplications()
}

/** Applications whose reminder has come due. Drives the dashboard's badge. */
export function dueFollowUps(now = Date.now()): Application[] {
  return listApplications().filter((a) => a.followUpAt !== null && a.followUpAt <= now)
}
