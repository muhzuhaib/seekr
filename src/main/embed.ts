/**
 * Indeed, shown *inside* Seekr.
 *
 * Applying and viewing a listing used to open a separate 980×820 window carrying
 * Indeed's full header, nav, cookie bars and footer — which is exactly what "it
 * throws me out of my app" means. Both now render as a `WebContentsView` layered
 * into the main window, framed by Seekr's own header, with Indeed's site chrome
 * hidden so only the thing you came for is left.
 *
 * What has deliberately NOT changed:
 *   - it is still Indeed's real page, in the user's real session;
 *   - Seekr never fills the form and never presses submit;
 *   - no bot check is ever solved or bypassed here.
 *
 * The renderer owns the layout: it draws the panel chrome, measures the hole left
 * for the page, and sends that rectangle down. Native views always paint above the
 * DOM, so the two must agree on the geometry or the page would cover the chrome.
 */

import { BrowserWindow, WebContentsView } from 'electron'
import type { PanelKind, PanelState } from '../shared/types'
import { PARTITION } from './ingest'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

let view: WebContentsView | null = null
let host: BrowserWindow | null = null
let lastRect: Rect | null = null
let onState: ((state: PanelState) => void) | null = null
/** Whoever opened the panel and is waiting for it to shut. Fired once. */
let closeHandler: (() => void) | null = null
let current: { kind: PanelKind; title: string } = { kind: 'view', title: '' }

export function setStateListener(fn: (state: PanelState) => void): void {
  onState = fn
}

function emit(): void {
  if (!view || !onState) return
  const wc = view.webContents
  let hostname = ''
  try {
    hostname = new URL(wc.getURL()).hostname.replace(/^www\./, '')
  } catch {
    hostname = ''
  }
  onState({
    open: true,
    kind: current.kind,
    title: current.title,
    host: hostname,
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack()
  })
}

/**
 * Indeed's own furniture, hidden so the panel shows the job or the form and
 * nothing else.
 *
 * Only ever *hides* chrome — never touches the form, its buttons or its layout,
 * because a stylesheet that accidentally hides a required field would be a
 * genuinely harmful bug. `smartapply` (the apply flow itself) is left almost
 * completely alone for that reason: there, only cookie banners go.
 */
const HIDE_SITE_CHROME = `
  /* Verified against live markup 2026-07-22: the global nav is #m-gnav-header /
     #gnav-main-container and the footer is #m-gnav-footer / #gnav-footer-container.
     The older #gnav / #footer ids are kept in case Indeed rolls back. */
  #m-gnav-header, #gnav-main-container, #gnav, .gnav-header-wrapper,
  [data-gnav-element-name="Header"],
  #m-gnav-footer, #gnav-footer-container, #footer, footer#footer, .jobsearch-Footer,
  #onetrust-banner-sdk, #onetrust-consent-sdk, .icl-CookiePolicy,
  [data-testid="cookie-banner"], #CookieBanner,
  #jobsearch-JapanesePrivacyPolicy, .jobsearch-JobCountryLanguageSelector,
  [data-testid="app-download-banner"] {
    display: none !important;
  }
  body { padding-top: 0 !important; }
`

const HIDE_BANNERS_ONLY = `
  #onetrust-banner-sdk, #onetrust-consent-sdk, [data-testid="cookie-banner"], #CookieBanner {
    display: none !important;
  }
`

function styleFor(url: string): string {
  // The apply flow is a form the user must complete; touch as little as possible.
  return /smartapply\.indeed\.com/i.test(url) ? HIDE_BANNERS_ONLY : HIDE_SITE_CHROME
}

function applyStyle(): void {
  if (!view) return
  const wc = view.webContents
  const url = wc.getURL()
  // Only ever restyle Indeed's own pages. An external company site is somebody
  // else's layout and we have no business guessing at it.
  if (!/indeed\.[a-z.]+$/i.test(safeHost(url))) return
  void wc.insertCSS(styleFor(url)).catch(() => undefined)
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Creates the view if needed and lays it out where the renderer asked for it. */
export function openPanel(
  parent: BrowserWindow,
  options: {
    url: string
    title: string
    kind: PanelKind
    /**
     * Called exactly once when the panel goes away, for any reason.
     *
     * Deliberately a callback rather than a `destroyed` listener on the
     * WebContents: the apply flow waits on this to record the application, and if
     * the event ever failed to fire that promise would hang forever and the
     * application would silently never be logged.
     */
    onClosed?: () => void
  }
): WebContentsView {
  closePanel()

  host = parent
  current = { kind: options.kind, title: options.title }
  closeHandler = options.onClosed ?? null

  view = new WebContentsView({
    webPreferences: {
      // Same jar as the fetcher and the login panel — that is what makes one
      // sign-in cover applying too.
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  const wc = view.webContents

  // Popups (Google sign-in, some employer sites) stay in the same session, or the
  // cookies they set land somewhere Seekr can't see.
  wc.setWindowOpenHandler(({ url }) => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      parent: host ?? undefined,
      width: 640,
      height: 760,
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true }
    }
  }))

  wc.on('dom-ready', applyStyle)
  wc.on('did-finish-load', () => {
    applyStyle()
    emit()
  })
  wc.on('did-start-loading', emit)
  wc.on('did-stop-loading', emit)
  wc.on('did-navigate', emit)
  wc.on('did-navigate-in-page', emit)

  parent.contentView.addChildView(view)
  if (lastRect) view.setBounds(lastRect)
  void wc.loadURL(options.url)

  return view
}

/** The renderer measured the hole it left for the page. */
export function setPanelBounds(rect: Rect): void {
  lastRect = rect
  if (view) view.setBounds(rect)
}

export function panelWebContents(): Electron.WebContents | null {
  return view?.webContents ?? null
}

export function goBack(): void {
  const wc = view?.webContents
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
}

export function reloadPanel(): void {
  view?.webContents.reload()
}

export function closePanel(): void {
  if (!view) return
  const dying = view
  const notify = closeHandler
  view = null
  closeHandler = null

  try {
    host?.contentView.removeChildView(dying)
    dying.webContents.close()
  } catch {
    // Window already gone — nothing to detach from.
  }

  onState?.({ open: false, kind: current.kind, title: '', host: '', loading: false, canGoBack: false })
  // After the state broadcast, so the UI is already back before anything the
  // caller does next (recording an application, asking a question) happens.
  notify?.()
}

export function isPanelOpen(): boolean {
  return view !== null
}
