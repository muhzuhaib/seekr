/**
 * Persistence. Everything lives as plain JSON under userData and is held in memory
 * while the app runs, so reads from the UI are synchronous and instant. Writes are
 * debounced — the feed ingests in bursts and we don't want a disk write per job.
 *
 * Deliberately no native database: it would mean node-gyp and Visual Studio Build
 * Tools on the user's machine, and the corpus is only a few megabytes.
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const root = () => app.getPath('userData')

export function dataPath(...parts: string[]): string {
  return join(root(), ...parts)
}

export function ensureDir(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
  return path
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    // A corrupt file must not brick the app — fall back and let the next write heal it.
    return fallback
  }
}

/** Write via a temp file + rename so a crash mid-write can't truncate real data. */
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value), 'utf8')
  renameSync(tmp, file)
}

/**
 * A single JSON-backed value, loaded once and written back on a debounce.
 */
export class JsonStore<T> {
  private value: T
  private timer: NodeJS.Timeout | null = null
  private readonly file: string

  constructor(filename: string, fallback: T) {
    ensureDir(root())
    this.file = dataPath(filename)
    this.value = readJson<T>(this.file, fallback)
  }

  get(): T {
    return this.value
  }

  set(next: T): void {
    this.value = next
    this.scheduleFlush()
  }

  update(fn: (current: T) => T): T {
    this.value = fn(this.value)
    this.scheduleFlush()
    return this.value
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 400)
  }

  /** Force an immediate write. Called on app quit so nothing is lost. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      writeJsonAtomic(this.file, this.value)
    } catch (err) {
      console.error(`[store] failed to write ${this.file}`, err)
    }
  }
}

const registry: JsonStore<unknown>[] = []

export function createStore<T>(filename: string, fallback: T): JsonStore<T> {
  const store = new JsonStore<T>(filename, fallback)
  registry.push(store as JsonStore<unknown>)
  return store
}

/** Flush every registered store. Wired to `before-quit`. */
export function flushAll(): void {
  for (const store of registry) store.flush()
}
