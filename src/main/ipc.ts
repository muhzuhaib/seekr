/**
 * The single boundary between the UI and everything that touches disk or network.
 * Every channel is registered here so the surface area is easy to audit.
 */

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  Application,
  ApplicationStatus,
  ApplyResult,
  AuthState,
  FeedQuery,
  FeedResult,
  Job,
  Resume,
  SavedJob,
  Settings,
  UpdateStatus
} from '../shared/types'
import { regionByCode } from '../shared/types'
import * as applications from './applications'
import { buildFeed, getJob, merge, upsert } from './corpus'
import * as corpus from './corpus'
import {
  currentCooldownMs,
  fetchJobDetail,
  ingestFeed,
  probeAuth,
  resolveChallengeInteractively
} from './ingest'
import { clearSession, openApply, openLogin, openPage } from './panels'
import * as resumes from './resumes'
import * as saved from './saved'
import { insightFor } from './salary'
import { cleanList, getSettings, resetSettings, updateSettings } from './settings'
import { checkForUpdates, getUpdateStatus, installUpdate } from './updater'

let authState: AuthState = { loggedIn: false, email: null, checkedAt: 0 }

/** Anything requiring a signed-in Indeed account routes through this first. */
function requireAuth(): void {
  if (!authState.loggedIn) {
    throw new Error('Sign in to your Indeed account to use this.')
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerIpc(getMainWindow: () => BrowserWindow | null): void {
  // ------------------------------------------------------------ settings

  ipcMain.handle('settings:get', (): Settings => getSettings())

  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>): Settings => {
    // List fields are user-typed, so normalise them at the boundary rather than
    // trusting every caller to remember.
    const cleaned: Partial<Settings> = { ...patch }
    if (patch.savedKeywords) cleaned.savedKeywords = cleanList(patch.savedKeywords)
    if (patch.blockedKeywords) cleaned.blockedKeywords = cleanList(patch.blockedKeywords)
    if (patch.blockedCompanies) cleaned.blockedCompanies = cleanList(patch.blockedCompanies)
    return updateSettings(cleaned)
  })

  ipcMain.handle('settings:reset', (): Settings => resetSettings())

  // ------------------------------------------------------------ feed

  /** Instant: reads the local corpus only. */
  ipcMain.handle('feed:get', (_e, query: FeedQuery): FeedResult => {
    const settings = getSettings()
    const { jobs, filteredOut } = buildFeed(query, settings)
    return { jobs, warning: null, fetchedAt: Date.now(), filteredOut }
  })

  /**
   * Fetches live data, then returns the rebuilt feed. "Recent" is required by the
   * spec to always hit the network rather than serve cached rows.
   */
  ipcMain.handle('feed:refresh', async (_e, query: FeedQuery): Promise<FeedResult> => {
    const settings = getSettings()
    const region = regionByCode(query.region)

    broadcast('ingest:status', {
      running: true,
      phase: 'fetching',
      message: 'Fetching the latest listings from Indeed…',
      progress: 0,
      cooldownUntil: null
    })

    // With keyword filtering on we search Indeed for each keyword, which returns far
    // better matches than filtering a generic feed after the fact.
    const activeKeywords =
      query.useSavedKeywords && settings.keywordFilterEnabled
        ? settings.savedKeywords
        : query.keywords
    // Capped: each keyword is its own set of page loads, and every extra deep search
    // URL is another chance of tripping Indeed's bot check.
    const searches = activeKeywords.length > 0 ? activeKeywords.slice(0, 3) : ['']

    let warning: string | null = null

    try {
      for (const term of searches) {
        const outcome = await ingestFeed({
          region,
          query: term,
          filter: query.filter,
          onProgress: (done, total) => {
            broadcast('ingest:status', {
              running: true,
              phase: 'fetching',
              message: term ? `Searching “${term}”…` : 'Fetching listings…',
              progress: done / total,
              cooldownUntil: null
            })
          },
          onChallenge: () => {
            broadcast('ingest:status', {
              running: true,
              phase: 'blocked',
              message: 'Indeed needs you to confirm you’re human — see the window that opened',
              progress: 0,
              cooldownUntil: null
            })
          }
        })

        merge(outcome.jobs, settings.corpusLimit)
        if (outcome.warning && !warning) warning = outcome.warning
      }
    } catch (err) {
      warning = (err as Error).message
    }

    const cooldown = currentCooldownMs()
    broadcast('ingest:status', {
      running: false,
      phase: warning ? (cooldown > 0 ? 'blocked' : 'error') : 'idle',
      message: warning ?? 'Up to date',
      progress: 1,
      cooldownUntil: cooldown > 0 ? Date.now() + cooldown : null
    })

    const { jobs, filteredOut } = buildFeed(query, settings)
    return { jobs, warning, fetchedAt: Date.now(), filteredOut }
  })

  /** Pulls the full description on demand, and caches it back into the corpus. */
  ipcMain.handle('job:detail', async (_e, jobId: string): Promise<Job | null> => {
    const job = getJob(jobId)
    if (!job) return null
    if (job.description) return job

    const detail = await fetchJobDetail(job.url)
    if (!detail?.description) return job

    const enriched: Job = { ...job, description: detail.description }
    upsert(enriched)
    return enriched
  })

  ipcMain.handle('job:open', (_e, jobId: string) => {
    const win = getMainWindow()
    const job = getJob(jobId)
    if (win && job) openPage(win, job.url, job.title)
  })

  /**
   * Shows the fetcher's own window so the user can clear Indeed's verification
   * check. Seekr never solves these — but it must be solved in *this* window, the
   * one that was actually blocked, or the next request simply challenges again.
   */
  ipcMain.handle('ingest:verify', async () => resolveChallengeInteractively())

  // ------------------------------------------------------------ saved jobs

  // Deliberately no requireAuth: bookmarking is local, so it works signed out.
  ipcMain.handle('saved:list', (): SavedJob[] => saved.listSaved())
  ipcMain.handle('saved:ids', (): string[] => saved.savedIds())

  ipcMain.handle('saved:toggle', (_e, jobId: string) => {
    const job = getJob(jobId) ?? saved.listSaved().find((j) => j.id === jobId)
    if (!job) return { saved: false }
    const result = saved.toggle(job)
    broadcast('saved:changed', saved.listSaved())
    return result
  })

  ipcMain.handle('saved:remove', (_e, jobId: string): SavedJob[] => {
    const next = saved.unsave(jobId)
    broadcast('saved:changed', next)
    return next
  })

  // ------------------------------------------------------------ auth

  ipcMain.handle('auth:state', (): AuthState => authState)

  ipcMain.handle('auth:check', async (): Promise<AuthState> => {
    const settings = getSettings()
    const result = await probeAuth(regionByCode(settings.region))
    authState = { ...result, checkedAt: Date.now() }
    broadcast('auth:changed', authState)
    return authState
  })

  ipcMain.handle('auth:login', async (): Promise<AuthState> => {
    const win = getMainWindow()
    if (!win) throw new Error('No window available')
    const settings = getSettings()
    const result = await openLogin(win, regionByCode(settings.region))
    authState = { ...result, checkedAt: Date.now() }
    broadcast('auth:changed', authState)
    return authState
  })

  ipcMain.handle('auth:logout', async (): Promise<AuthState> => {
    await clearSession()
    authState = { loggedIn: false, email: null, checkedAt: Date.now() }
    broadcast('auth:changed', authState)
    return authState
  })

  // ------------------------------------------------------------ salary

  ipcMain.handle('salary:insight', (_e, jobId: string) => {
    const job = getJob(jobId)
    if (!job) return null
    return insightFor(job, getSettings().salaryMinSample)
  })

  /**
   * Batched form for the feed. One round trip for a screenful of cards instead of
   * one per card.
   */
  ipcMain.handle('salary:insights', (_e, jobIds: string[]) => {
    const minSample = getSettings().salaryMinSample
    const out: Record<string, ReturnType<typeof insightFor>> = {}
    for (const id of jobIds) {
      const job = getJob(id)
      if (job?.salary) out[id] = insightFor(job, minSample)
    }
    return out
  })

  // ------------------------------------------------------------ resumes

  ipcMain.handle('resumes:list', (): Resume[] => {
    requireAuth()
    return resumes.listResumes()
  })

  ipcMain.handle('resumes:add', async (_e, title: string): Promise<Resume[]> => {
    requireAuth()
    const win = getMainWindow()
    if (!win) throw new Error('No window available')

    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose a resume',
      properties: ['openFile'],
      filters: [{ name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'txt', 'rtf'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return resumes.listResumes()

    resumes.addResume(picked.filePaths[0], title)
    return resumes.listResumes()
  })

  ipcMain.handle('resumes:replace', async (_e, id: string): Promise<Resume[]> => {
    requireAuth()
    const win = getMainWindow()
    if (!win) throw new Error('No window available')

    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose a replacement file',
      properties: ['openFile'],
      filters: [{ name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'txt', 'rtf'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return resumes.listResumes()

    return resumes.replaceResume(id, picked.filePaths[0])
  })

  ipcMain.handle('resumes:rename', (_e, id: string, title: string): Resume[] => {
    requireAuth()
    return resumes.renameResume(id, title)
  })

  ipcMain.handle('resumes:delete', (_e, id: string): Resume[] => {
    requireAuth()
    return resumes.deleteResume(id)
  })

  ipcMain.handle('resumes:reveal', (_e, id: string) => {
    requireAuth()
    const path = resumes.resumePath(id)
    if (path) shell.showItemInFolder(path)
  })

  // ------------------------------------------------------------ applications

  ipcMain.handle('applications:list', (): Application[] => {
    requireAuth()
    return applications.listApplications()
  })

  /**
   * Opens Indeed's real apply flow. Seekr watches for the confirmation page so it can
   * log the application — it never fills or submits the form itself.
   */
  ipcMain.handle(
    'applications:apply',
    async (_e, jobId: string, resumeId: string | null): Promise<ApplyResult> => {
      requireAuth()
      const win = getMainWindow()
      const job = getJob(jobId)
      if (!win || !job) return { record: null, askedExternal: false }

      // Snapshot needs the full text, so make sure we have it before the panel opens.
      let full = job
      if (!full.description) {
        const detail = await fetchJobDetail(job.url)
        if (detail?.description) {
          full = { ...job, description: detail.description }
          upsert(full)
        }
      }

      const outcome = await openApply(win, full)

      /*
        An external handoff can't be observed, so we have to ask. The question is
        returned to the renderer rather than raised with dialog.showMessageBox,
        because that draws a grey Windows box that ignores the app's theme entirely.
      */
      if (!outcome.applied) {
        return { record: null, askedExternal: outcome.externalHandoff }
      }

      const record = applications.recordApplication(full, resumeId)
      broadcast('applications:changed', applications.listApplications())
      return { record, askedExternal: false }
    }
  )

  /** Manual entry, for anything Seekr couldn't detect. */
  ipcMain.handle('applications:track', (_e, jobId: string, resumeId: string | null) => {
    requireAuth()
    const job = getJob(jobId)
    if (!job) return null
    const record = applications.recordApplication(job, resumeId)
    broadcast('applications:changed', applications.listApplications())
    return record
  })

  ipcMain.handle(
    'applications:update',
    (_e, jobId: string, patch: Partial<Pick<Application, 'status' | 'notes' | 'followUpAt'>>) => {
      requireAuth()
      return applications.updateApplication(jobId, patch)
    }
  )

  ipcMain.handle('applications:setStatus', (_e, jobId: string, status: ApplicationStatus) => {
    requireAuth()
    return applications.setStatus(jobId, status)
  })

  ipcMain.handle('applications:followUp', (_e, jobId: string, days: number | null) => {
    requireAuth()
    return applications.setFollowUpInDays(jobId, days)
  })

  ipcMain.handle('applications:delete', (_e, jobId: string) => {
    requireAuth()
    return applications.deleteApplication(jobId)
  })

  /** The point of the whole cache: reading a listing Indeed has since deleted. */
  ipcMain.handle('applications:cached', (_e, filename: string): string | null => {
    requireAuth()
    return applications.readCachedListing(filename)
  })

  // ------------------------------------------------------------ misc

  ipcMain.handle('app:openExternal', (_e, url: string) => {
    // Only ever hand real web URLs to the OS.
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })

  // -------------------------------------------------------------- updates

  ipcMain.handle('update:status', (): UpdateStatus => getUpdateStatus())
  ipcMain.handle('update:check', (): Promise<UpdateStatus> => checkForUpdates(true))
  ipcMain.handle('update:install', (): boolean => installUpdate())

  ipcMain.handle('corpus:clear', () => {
    corpus.clearAll()
    return true
  })
}

export function setAuthState(next: AuthState): void {
  authState = next
}
