/**
 * Auto-update, via electron-updater against GitHub Releases.
 *
 * Deliberately quiet: Seekr downloads a new version in the background and then
 * shows one small line in the UI. It never interrupts, never force-restarts, and
 * never blocks the app while checking — a job search shouldn't be paused by a
 * housekeeping task.
 *
 * The feed URL is not hard-coded here. electron-builder writes `app-update.yml`
 * into the packaged resources from the `publish:` block in electron-builder.yml,
 * and electron-updater reads that. One source of truth.
 */

import { app, BrowserWindow } from 'electron'
import type { UpdateStatus } from '../shared/types'

// electron-updater is CommonJS, and its default export is the module object.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import updaterPkg from 'electron-updater'
const { autoUpdater } = updaterPkg

/** Wait this long after launch before the first check. */
const FIRST_CHECK_DELAY_MS = 8000

/** How often to re-check while the app stays open (6 hours). */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let status: UpdateStatus = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  newVersion: null,
  progress: 0,
  message: '',
  manual: false
}

let getWindow: () => BrowserWindow | null = () => null
let wired = false

function publish(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch, currentVersion: app.getVersion() }
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('update:status', status)
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

/**
 * An unpacked build has no installer to replace, so electron-updater throws
 * ("dev-app-update.yml not found"). Detect it up front and report it honestly
 * rather than surfacing a confusing error.
 */
function supported(): boolean {
  return app.isPackaged
}

function wire(): void {
  if (wired) return
  wired = true

  // We want the download to happen quietly in the background, but the *install*
  // to be the user's choice — restarting on its own would lose whatever they
  // were reading.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false

  autoUpdater.on('checking-for-update', () => {
    publish({ phase: 'checking', message: 'Checking for updates…' })
  })

  autoUpdater.on('update-available', (info) => {
    publish({
      phase: 'downloading',
      newVersion: info.version,
      progress: 0,
      message: `Downloading version ${info.version}…`
    })
  })

  autoUpdater.on('update-not-available', () => {
    publish({ phase: 'none', newVersion: null, message: "You're on the latest version." })
  })

  autoUpdater.on('download-progress', (p) => {
    publish({ phase: 'downloading', progress: Math.round(p.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    publish({
      phase: 'ready',
      newVersion: info.version,
      progress: 100,
      message: `Version ${info.version} is ready to install.`
    })
  })

  autoUpdater.on('error', (err) => {
    // Never fatal. No network, a private repo, or no releases yet all land here,
    // and none of them should stop the user searching for jobs.
    console.error('[updater]', err)
    publish({
      phase: 'error',
      message: 'Could not check for updates right now.'
    })
  })
}

/** Called once from the main process after the window exists. */
export function initUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter

  if (!supported()) {
    publish({ phase: 'unsupported', message: 'Updates apply to the installed app only.' })
    return
  }

  wire()

  // Delayed so the check never competes with the first paint or the auth probe.
  setTimeout(() => void checkForUpdates(false), FIRST_CHECK_DELAY_MS)
  setInterval(() => void checkForUpdates(false), RECHECK_INTERVAL_MS)
}

/** `manual` is true when the user pressed the button in Settings. */
export async function checkForUpdates(manual: boolean): Promise<UpdateStatus> {
  if (!supported()) {
    publish({
      phase: 'unsupported',
      manual,
      message: 'This is a development build — install Seekr to get updates.'
    })
    return status
  }

  // Already downloaded: re-checking would only overwrite a useful state.
  if (status.phase === 'ready') {
    publish({ manual })
    return status
  }

  wire()
  publish({ manual })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.error('[updater] check failed:', err)
    publish({ phase: 'error', message: 'Could not check for updates right now.' })
  }
  return status
}

/** Quit and install the downloaded update. Only meaningful in the 'ready' phase. */
export function installUpdate(): boolean {
  if (status.phase !== 'ready') return false
  // setImmediate so the IPC reply reaches the renderer before we tear down.
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
  return true
}
