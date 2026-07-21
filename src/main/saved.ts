/**
 * Saved jobs.
 *
 * The whole job is stored, not just its id. The corpus evicts oldest-first to stay
 * small, and a listing the user deliberately bookmarked must not vanish because
 * they browsed a lot afterwards — nor when Indeed takes the posting down.
 *
 * Local-only, so this works signed out. There is nothing to sync and nothing about
 * bookmarking that needs an Indeed account.
 */

import type { Job, SavedJob } from '../shared/types'
import { createStore } from './store'

interface SavedFile {
  jobs: SavedJob[]
}

const store = createStore<SavedFile>('saved.json', { jobs: [] })

/** Newest save first — the order the user thinks in. */
export function listSaved(): SavedJob[] {
  return [...store.get().jobs].sort((a, b) => b.savedAt - a.savedAt)
}

export function savedIds(): string[] {
  return store.get().jobs.map((j) => j.id)
}

export function isSaved(jobId: string): boolean {
  return store.get().jobs.some((j) => j.id === jobId)
}

export function save(job: Job): SavedJob[] {
  if (isSaved(job.id)) return listSaved()
  const entry: SavedJob = { ...job, savedAt: Date.now() }
  store.set({ jobs: [...store.get().jobs, entry] })
  return listSaved()
}

export function unsave(jobId: string): SavedJob[] {
  store.set({ jobs: store.get().jobs.filter((j) => j.id !== jobId) })
  return listSaved()
}

/** Returns the new state so the button can update without a second round trip. */
export function toggle(job: Job): { saved: boolean } {
  if (isSaved(job.id)) {
    unsave(job.id)
    return { saved: false }
  }
  save(job)
  return { saved: true }
}

/**
 * Refreshes a saved copy from newer corpus data — e.g. once the full description
 * has been fetched — without touching when it was saved.
 */
export function refresh(job: Job): void {
  const existing = store.get().jobs.find((j) => j.id === job.id)
  if (!existing) return
  store.set({
    jobs: store.get().jobs.map((j) =>
      j.id === job.id ? { ...job, savedAt: existing.savedAt } : j
    )
  })
}

export function clearAll(): void {
  store.set({ jobs: [] })
}
