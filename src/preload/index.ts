/**
 * The renderer's only door to the main process. Context isolation is on, so the UI
 * gets exactly these functions and nothing else — no Node, no `ipcRenderer`.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  Application,
  ApplicationStatus,
  ApplyResult,
  AuthState,
  FeedQuery,
  FeedResult,
  IngestStatus,
  Job,
  PanelState,
  Resume,
  SalaryInsight,
  SavedJob,
  Settings,
  UpdateStatus
} from '../shared/types'

const api = {
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke('settings:update', patch),
    reset: (): Promise<Settings> => ipcRenderer.invoke('settings:reset')
  },

  feed: {
    get: (query: FeedQuery): Promise<FeedResult> => ipcRenderer.invoke('feed:get', query),
    refresh: (query: FeedQuery): Promise<FeedResult> => ipcRenderer.invoke('feed:refresh', query)
  },

  job: {
    detail: (id: string): Promise<Job | null> => ipcRenderer.invoke('job:detail', id),
    /** Warm-up on hover, so the description is usually here before the click is. */
    prefetch: (id: string): Promise<void> => ipcRenderer.invoke('job:prefetch', id),
    open: (id: string): Promise<void> => ipcRenderer.invoke('job:open', id),
    /** For listings we only hold a URL for — an application's saved link. */
    openUrl: (url: string, title: string): Promise<void> =>
      ipcRenderer.invoke('job:openUrl', url, title)
  },

  auth: {
    state: (): Promise<AuthState> => ipcRenderer.invoke('auth:state'),
    check: (): Promise<AuthState> => ipcRenderer.invoke('auth:check'),
    login: (): Promise<AuthState> => ipcRenderer.invoke('auth:login'),
    logout: (): Promise<AuthState> => ipcRenderer.invoke('auth:logout')
  },

  salary: {
    insight: (jobId: string): Promise<SalaryInsight | null> =>
      ipcRenderer.invoke('salary:insight', jobId),
    insights: (jobIds: string[]): Promise<Record<string, SalaryInsight>> =>
      ipcRenderer.invoke('salary:insights', jobIds)
  },

  resumes: {
    list: (): Promise<Resume[]> => ipcRenderer.invoke('resumes:list'),
    add: (title: string): Promise<Resume[]> => ipcRenderer.invoke('resumes:add', title),
    replace: (id: string): Promise<Resume[]> => ipcRenderer.invoke('resumes:replace', id),
    rename: (id: string, title: string): Promise<Resume[]> =>
      ipcRenderer.invoke('resumes:rename', id, title),
    remove: (id: string): Promise<Resume[]> => ipcRenderer.invoke('resumes:delete', id),
    reveal: (id: string): Promise<void> => ipcRenderer.invoke('resumes:reveal', id)
  },

  /** Bookmarks. Local-only, so these work signed out. */
  saved: {
    list: (): Promise<SavedJob[]> => ipcRenderer.invoke('saved:list'),
    ids: (): Promise<string[]> => ipcRenderer.invoke('saved:ids'),
    toggle: (jobId: string): Promise<{ saved: boolean }> =>
      ipcRenderer.invoke('saved:toggle', jobId),
    remove: (jobId: string): Promise<SavedJob[]> => ipcRenderer.invoke('saved:remove', jobId)
  },

  applications: {
    list: (): Promise<Application[]> => ipcRenderer.invoke('applications:list'),
    apply: (jobId: string, resumeId: string | null): Promise<ApplyResult> =>
      ipcRenderer.invoke('applications:apply', jobId, resumeId),
    track: (jobId: string, resumeId: string | null): Promise<Application | null> =>
      ipcRenderer.invoke('applications:track', jobId, resumeId),
    update: (
      jobId: string,
      patch: Partial<Pick<Application, 'status' | 'notes' | 'followUpAt'>>
    ): Promise<Application[]> => ipcRenderer.invoke('applications:update', jobId, patch),
    setStatus: (jobId: string, status: ApplicationStatus): Promise<Application[]> =>
      ipcRenderer.invoke('applications:setStatus', jobId, status),
    followUp: (jobId: string, days: number | null): Promise<Application[]> =>
      ipcRenderer.invoke('applications:followUp', jobId, days),
    remove: (jobId: string): Promise<Application[]> =>
      ipcRenderer.invoke('applications:delete', jobId),
    cached: (filename: string): Promise<string | null> =>
      ipcRenderer.invoke('applications:cached', filename)
  },

  /** Auto-update. `install` quits and relaunches into the new version. */
  update: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:check'),
    install: (): Promise<boolean> => ipcRenderer.invoke('update:install')
  },

  /**
   * The embedded Indeed panel (applying, and viewing a listing). The renderer
   * draws the chrome and reports the rectangle the page should fill.
   */
  panel: {
    bounds: (rect: { x: number; y: number; width: number; height: number }): Promise<void> =>
      ipcRenderer.invoke('panel:bounds', rect),
    close: (): Promise<void> => ipcRenderer.invoke('panel:close'),
    back: (): Promise<void> => ipcRenderer.invoke('panel:back'),
    reload: (): Promise<void> => ipcRenderer.invoke('panel:reload')
  },

  /** Indeed's verification check, framed by Seekr while it is up. */
  challenge: {
    cancel: (): Promise<void> => ipcRenderer.invoke('challenge:cancel')
  },

  onChallengeState: (fn: (active: boolean) => void): (() => void) => {
    const handler = (_e: unknown, active: boolean) => fn(active)
    ipcRenderer.on('challenge:state', handler)
    return () => ipcRenderer.removeListener('challenge:state', handler)
  },

  onPanelState: (fn: (state: PanelState) => void): (() => void) => {
    const handler = (_e: unknown, state: PanelState) => fn(state)
    ipcRenderer.on('panel:state', handler)
    return () => ipcRenderer.removeListener('panel:state', handler)
  },

  /** Opens Indeed in a visible window so the user can clear a verification check. */
  verify: (filter: string): Promise<boolean> => ipcRenderer.invoke('ingest:verify', filter),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
  clearCorpus: (): Promise<boolean> => ipcRenderer.invoke('corpus:clear'),

  // --- events. Each returns its own unsubscribe so React effects can clean up.
  onIngestStatus: (fn: (status: IngestStatus) => void): (() => void) => {
    const handler = (_e: unknown, status: IngestStatus) => fn(status)
    ipcRenderer.on('ingest:status', handler)
    return () => ipcRenderer.removeListener('ingest:status', handler)
  },
  onAuthChanged: (fn: (state: AuthState) => void): (() => void) => {
    const handler = (_e: unknown, state: AuthState) => fn(state)
    ipcRenderer.on('auth:changed', handler)
    return () => ipcRenderer.removeListener('auth:changed', handler)
  },
  onApplicationsChanged: (fn: (apps: Application[]) => void): (() => void) => {
    const handler = (_e: unknown, apps: Application[]) => fn(apps)
    ipcRenderer.on('applications:changed', handler)
    return () => ipcRenderer.removeListener('applications:changed', handler)
  },
  onSavedChanged: (fn: (jobs: SavedJob[]) => void): (() => void) => {
    const handler = (_e: unknown, jobs: SavedJob[]) => fn(jobs)
    ipcRenderer.on('saved:changed', handler)
    return () => ipcRenderer.removeListener('saved:changed', handler)
  },
  /**
   * Fired when the corpus changed underneath the UI — currently when the remote
   * check re-decides some listings — so the feed can re-read itself without the
   * user pressing anything.
   */
  onCorpusChanged: (fn: () => void): (() => void) => {
    const handler = (): void => fn()
    ipcRenderer.on('corpus:changed', handler)
    return () => ipcRenderer.removeListener('corpus:changed', handler)
  },
  onUpdateStatus: (fn: (status: UpdateStatus) => void): (() => void) => {
    const handler = (_e: unknown, status: UpdateStatus) => fn(status)
    ipcRenderer.on('update:status', handler)
    return () => ipcRenderer.removeListener('update:status', handler)
  }
}

export type SeekrApi = typeof api

contextBridge.exposeInMainWorld('seekr', api)
