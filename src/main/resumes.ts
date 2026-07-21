/**
 * Resume slots. Up to ten files copied into userData/resumes/ with user-chosen
 * titles. The title is Seekr's own label and never leaves the machine — employers
 * only ever see the file itself, under its original name.
 */

import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { MAX_RESUMES, type Resume } from '../shared/types'
import { createStore, dataPath, ensureDir } from './store'

interface ResumeFile {
  resumes: Resume[]
}

const store = createStore<ResumeFile>('resumes/index.json', { resumes: [] })

function dir(): string {
  return ensureDir(dataPath('resumes'))
}

export function listResumes(): Resume[] {
  return store.get().resumes
}

export function resumePath(id: string): string | null {
  const resume = listResumes().find((r) => r.id === id)
  if (!resume) return null
  const path = join(dir(), resume.filename)
  return existsSync(path) ? path : null
}

export class ResumeLimitError extends Error {
  constructor() {
    super(`You can save up to ${MAX_RESUMES} resumes. Delete one to add another.`)
    this.name = 'ResumeLimitError'
  }
}

/**
 * Copies a file into Seekr's own storage so the resume survives the user moving or
 * deleting the original.
 */
export function addResume(sourcePath: string, title: string): Resume {
  const current = listResumes()
  if (current.length >= MAX_RESUMES) throw new ResumeLimitError()
  if (!existsSync(sourcePath)) throw new Error('That file no longer exists.')

  const id = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  // Keep the original extension — Indeed's uploader validates on it.
  const filename = `${id}${extname(sourcePath) || '.pdf'}`
  copyFileSync(sourcePath, join(dir(), filename))

  const resume: Resume = {
    id,
    title: title.trim() || basename(sourcePath),
    filename,
    sizeBytes: statSync(sourcePath).size,
    addedAt: Date.now()
  }

  store.set({ resumes: [...current, resume] })
  return resume
}

export function renameResume(id: string, title: string): Resume[] {
  store.set({
    resumes: listResumes().map((r) => (r.id === id ? { ...r, title: title.trim() || r.title } : r))
  })
  return listResumes()
}

/** Swaps the file behind an existing slot, keeping its id and title. */
export function replaceResume(id: string, sourcePath: string): Resume[] {
  const resume = listResumes().find((r) => r.id === id)
  if (!resume) throw new Error('That resume no longer exists.')
  if (!existsSync(sourcePath)) throw new Error('That file no longer exists.')

  const filename = `${id}${extname(sourcePath) || '.pdf'}`
  const old = join(dir(), resume.filename)
  if (existsSync(old) && resume.filename !== filename) rmSync(old, { force: true })
  copyFileSync(sourcePath, join(dir(), filename))

  store.set({
    resumes: listResumes().map((r) =>
      r.id === id ? { ...r, filename, sizeBytes: statSync(sourcePath).size, addedAt: Date.now() } : r
    )
  })
  return listResumes()
}

export function deleteResume(id: string): Resume[] {
  const resume = listResumes().find((r) => r.id === id)
  if (resume) {
    const path = join(dir(), resume.filename)
    if (existsSync(path)) rmSync(path, { force: true })
  }
  store.set({ resumes: listResumes().filter((r) => r.id !== id) })
  return listResumes()
}
