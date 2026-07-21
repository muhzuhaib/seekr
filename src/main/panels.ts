/**
 * The moments Seekr shows real Indeed instead of its own UI.
 *
 * **Signing in** keeps its own window: it is the one place a real password is
 * typed, and it should look unmistakably like Indeed's own page rather than
 * something Seekr drew.
 *
 * **Applying** and **viewing a listing** used to open a window too, which is what
 * made the app feel like a launcher for Indeed. They now render inside the main
 * window — see `embed.ts`.
 *
 * Either way: Seekr never types the user's password and never presses submit on an
 * application. These panels exist so the user does those things themselves, in
 * Indeed's genuine flow, without leaving the app.
 */

import { BrowserWindow } from 'electron'
import type { Job, Region } from '../shared/types'
import { closePanel, openPanel, panelWebContents } from './embed'
import { PARTITION, probeAuth } from './ingest'

/**
 * These panels must present exactly the same browser identity as the fetcher, since
 * they share one cookie jar — see the note in `ingest.ts`. That means overriding the
 * User-Agent nowhere at all.
 */
function createPanel(parent: BrowserWindow, title: string): BrowserWindow {
  const panel = new BrowserWindow({
    parent,
    modal: false,
    width: 980,
    height: 820,
    title,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  panel.setMenuBarVisibility(false)

  // Google's sign-in opens popups. Keep them inside the same session, or the
  // resulting cookies land somewhere Seekr can't see.
  panel.webContents.setWindowOpenHandler(({ url }) => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      parent: panel,
      width: 640,
      height: 760,
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true }
    }
  }))

  return panel
}

// ---------------------------------------------------------------- login

/**
 * Opens Indeed's own login page. Email/password, email code, and "Continue with
 * Google" all work because this is a genuine Chromium on a real Chrome user agent.
 *
 * Resolves once the window closes, reporting whether the session ended up signed in.
 */
export function openLogin(
  parent: BrowserWindow,
  region: Region
): Promise<{ loggedIn: boolean; email: string | null }> {
  return new Promise((resolve) => {
    const panel = createPanel(parent, 'Sign in to Indeed')
    let settled = false

    const finish = async () => {
      if (settled) return
      settled = true
      // Ask the shared session directly rather than trusting the panel's last URL.
      resolve(await probeAuth(region))
    }

    // Indeed bounces to the homepage or a "success" route once sign-in completes.
    panel.webContents.on('did-navigate', (_event, url) => {
      const done =
        /\/(m\/)?(jobs|myjobs)\b/.test(url) ||
        /account\/(login|verify)\/?$/.test(url) === false && /indeed\.[a-z.]+\/?$/.test(url)
      if (done && !settled) {
        // Give Indeed a moment to set its cookies before we probe.
        setTimeout(() => {
          if (!panel.isDestroyed()) panel.close()
        }, 1200)
      }
    })

    panel.on('closed', finish)
    panel.loadURL(`https://${region.domain}/account/login`)
  })
}

/** Clears the shared session so "Sign out" genuinely signs out. */
export async function clearSession(): Promise<void> {
  const { session } = await import('electron')
  const s = session.fromPartition(PARTITION)
  await s.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'websql'] })
}

// ---------------------------------------------------------------- apply

/**
 * URLs Indeed lands on after a completed application. Used to detect success so the
 * dashboard can log it automatically — the user still pressed the button.
 */
const APPLIED_PATTERNS = [
  /smartapply\.indeed\.com\/.*\/(post-apply|confirmation|success)/i,
  /\/applied\b/i,
  /applicationSubmitted/i,
  /post-apply/i
]

export interface ApplyOutcome {
  applied: boolean
  /** True when Indeed handed off to an external company site, where we can't observe the outcome. */
  externalHandoff: boolean
}

/**
 * Presses Indeed's own "Apply now" button once the listing has loaded, so the
 * panel opens on the form rather than on the job advert the user has already read
 * in Seekr.
 *
 * This is a navigation, not an application: it is the same click the user came to
 * make, it submits nothing, and if the button isn't there (an "apply on company
 * site" listing, or a layout we don't recognise) it quietly does nothing and
 * leaves them on the page.
 */
const CLICK_APPLY = `(function () {
  var sel = [
    '#indeedApplyButton',
    '[data-testid="indeed-apply-button"] button',
    'button#indeedApplyButton',
    '.jobsearch-IndeedApplyButton-newDesign',
    '#applyButtonLinkContainer button',
    '#viewJobButtonLinkContainer button'
  ];
  for (var i = 0; i < sel.length; i++) {
    var el = document.querySelector(sel[i]);
    if (el) { el.click(); return true; }
  }
  return false;
})()`

/**
 * Opens the real Indeed apply flow for a job, inside the main window. Resolves
 * when the user closes the panel, reporting whether we saw a completed
 * application.
 */
export function openApply(parent: BrowserWindow, job: Job): Promise<ApplyOutcome> {
  return new Promise((resolve) => {
    let applied = false
    let externalHandoff = false
    let advanced = false
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      resolve({ applied, externalHandoff })
    }

    openPanel(parent, { url: job.url, title: job.title, kind: 'apply', onClosed: finish })
    const wc = panelWebContents()
    if (!wc) return finish()

    const inspect = (url: string): void => {
      if (APPLIED_PATTERNS.some((p) => p.test(url))) applied = true
      // "Apply on company site" leaves Indeed entirely; we can't confirm anything there.
      if (!/indeed\.[a-z.]+/i.test(url)) externalHandoff = true
    }

    wc.on('did-navigate', (_e, url) => inspect(url))
    wc.on('did-navigate-in-page', (_e, url) => inspect(url))

    // Jump to the form, once, on the first page only.
    wc.once('did-finish-load', () => {
      if (advanced) return
      advanced = true
      void wc.executeJavaScript(CLICK_APPLY, true).catch(() => undefined)
    })

    // Belt and braces: if the view is torn down some other way, still settle.
    wc.once('destroyed', finish)
  })
}

/**
 * Opens a job's Indeed page read-only inside the main window — used by
 * "View on Indeed".
 */
export function openPage(parent: BrowserWindow, url: string, title = 'Indeed'): void {
  openPanel(parent, { url, title, kind: 'view' })
}

/** Used when the app closes, or when the user leaves the panel. */
export { closePanel }
