/**
 * User settings. One JSON file, merged over defaults on read so a settings file
 * written by an older version of Seekr never arrives missing keys.
 */

import { DEFAULT_SETTINGS, type Settings } from '../shared/types'
import { createStore } from './store'

const store = createStore<Partial<Settings>>('settings.json', {})

export function getSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...store.get() }
}

export function updateSettings(patch: Partial<Settings>): Settings {
  store.set({ ...store.get(), ...patch })
  return getSettings()
}

export function resetSettings(): Settings {
  store.set({})
  return getSettings()
}

/** Trims, drops blanks, and de-duplicates case-insensitively. Used by every list field. */
export function cleanList(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}
