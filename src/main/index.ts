/**
 * Electron entry point. Creates the one visible window, wires IPC, and makes sure
 * nothing is lost on quit.
 */

import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { regionByCode } from '../shared/types'
import { closePanel } from './embed'
import { destroyWorker, probeAuth } from './ingest'
import { registerIpc, setAuthState } from './ipc'
import { getSettings } from './settings'
import { flushAll } from './store'
import { initUpdater } from './updater'

let mainWindow: BrowserWindow | null = null

/** Backstop for revealing the window when no paint/load event arrives. */
const REVEAL_TIMEOUT_MS = 3000

/** Guards against the several reveal triggers fighting each other. */
let revealed = false

/**
 * Show the main window, once, from whichever trigger gets there first.
 *
 * This must never throw: it runs from event handlers and from a timer, and an
 * exception here is what turns "no window" into "no window and no explanation".
 */
function revealWindow(reason: string): void {
  if (revealed) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  revealed = true
  try {
    // Opens maximised: this is a dense list-and-detail app, and the extra width is
    // what makes the feed comfortable to read.
    mainWindow.maximize()
    mainWindow.show()
    mainWindow.focus()
    console.log(`[main] window revealed via ${reason}`)
  } catch (err) {
    console.error('[main] failed to reveal window:', err)
  }
}

/*
  Last line of defence. An uncaught error in the main process makes Electron show a
  raw "A JavaScript error occurred" dialog and leaves the app unusable — for a
  desktop tool that is far worse than carrying on degraded. Errors are still logged;
  they are not swallowed silently.
*/
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err)
  // If we blew up before the window was on screen, still put it on screen. An
  // error the user can see and close beats a process with no UI at all.
  revealWindow('uncaught-exception')
})

// Same reasoning for a rejected promise during start-up.
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason)
  revealWindow('unhandled-rejection')
})

// A second launch should focus the existing window, not start a rival copy holding
// the same JSON files open.
const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  // Another instance owns the app. It will focus itself (or restart itself, below).
  app.quit()
} else {
  app.on('second-instance', () => {
    // Must check isDestroyed, not just null. A closed window still leaves a live
    // reference here, and touching it throws "Object has been destroyed" out of an
    // event handler — which Electron shows as a fatal dialog.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      return
    }

    /*
      We hold the lock but have no window to show, so we are a leftover process and
      the user just clicked the icon expecting the app.

      Quitting alone isn't enough — their click would be swallowed and they'd have
      to click again. Restarting hands the lock to a fresh instance that (thanks to
      revealWindow's timeout backstop) is guaranteed to put something on screen.
    */
    console.log('[main] leftover instance woken with no window — restarting')
    app.relaunch()
    app.quit()
  })
}

function createWindow(): void {
  revealed = false
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b0d10',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#8b95a5', height: 44 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  /*
    Revealing the window is belt-and-braces on purpose.

    `ready-to-show` is the tidy signal (it avoids a white flash), but it is NOT
    guaranteed to fire. It didn't here: the window was created, the renderer loaded
    fine, and the app sat running with five processes and nothing on screen, because
    the one and only `show()` call hung off an event that never arrived.

    So four independent triggers now call the same idempotent reveal, and a timer
    guarantees it regardless. A brief flash is a trivial cost next to an app that
    silently refuses to appear.
  */
  mainWindow.once('ready-to-show', () => revealWindow('ready-to-show'))
  mainWindow.webContents.once('did-finish-load', () => revealWindow('did-finish-load'))
  mainWindow.webContents.once('did-fail-load', () => revealWindow('did-fail-load'))
  mainWindow.webContents.once('dom-ready', () => revealWindow('dom-ready'))
  setTimeout(() => revealWindow('timeout'), REVEAL_TIMEOUT_MS)

  /*
    Closing the main window must also tear down the offscreen fetcher.

    The fetcher is a real BrowserWindow that simply isn't shown. Leaving it open
    meant `window-all-closed` never fired, so the process stayed alive with no UI —
    and every later launch then hit the single-instance lock and woke that ghost
    instead of starting. Four of them had piled up on the user's machine.
  */
  mainWindow.on('closed', () => {
    mainWindow = null
    // The embedded Indeed panel lives inside this window, so it goes first —
    // and closing it is what settles anything waiting on it, like an apply flow.
    closePanel()
    destroyWorker()
  })

  // Our own UI must never navigate away or spawn windows; real links go to the OS.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // Without this guard a losing instance still builds a window during the moment
  // between requestSingleInstanceLock() and the quit actually taking effect.
  if (!gotLock) return

  registerIpc(() => mainWindow)
  createWindow()

  // Background update checking. Schedules its own delayed first check, so it
  // costs the launch nothing.
  initUpdater(() => mainWindow)

  /*
    Check the persisted session in the background — this is what makes a login from
    weeks ago still be a login today, with no prompt on launch.

    Deliberately delayed. This spins up the offscreen fetcher and loads a heavy
    Indeed page; doing that while the main window is still trying to paint starves
    it of the very first frame. The UI is fully usable logged-out, so nothing here
    is worth delaying the window for.
  */
  setTimeout(() => {
    const settings = getSettings()
    if (!settings.region) return
    probeAuth(regionByCode(settings.region))
      .then((result) => {
        setAuthState({ ...result, checkedAt: Date.now() })
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auth:changed', { ...result, checkedAt: Date.now() })
        }
      })
      .catch(() => undefined)
  }, REVEAL_TIMEOUT_MS + 500)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  flushAll()
  destroyWorker()
})
