import { useEffect, useRef } from 'react'
import { ArrowLeft, Loader2, RotateCw, ShieldCheck, X } from 'lucide-react'
import type { PanelState } from '../../../shared/types'

/**
 * Seekr's frame around an Indeed page shown inside the app.
 *
 * The page itself is a native view laid over this component by the main process,
 * so the `.web-panel-slot` below is deliberately empty: it exists to be measured.
 * Whenever it moves or resizes, its rectangle is sent down and the native view is
 * laid into exactly that hole. Native views always paint above the DOM, which is
 * why nothing may be drawn on top of the slot — the chrome goes around it.
 */
export default function WebPanel({
  state,
  onClose
}: {
  state: PanelState
  onClose: () => void
}): JSX.Element {
  const slot = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = slot.current
    if (!el) return

    const report = (): void => {
      const r = el.getBoundingClientRect()
      void window.seekr.panel.bounds({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
    }

    report()
    // Window resizes, sidebar changes, DevTools opening — all move the hole.
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [])

  return (
    <div className="web-panel">
      <header className="web-panel-head">
        <button
          className="btn icon ghost"
          onClick={() => void window.seekr.panel.back()}
          disabled={!state.canGoBack}
          data-tip="Back"
        >
          <ArrowLeft size={16} />
        </button>
        <button
          className="btn icon ghost"
          onClick={() => void window.seekr.panel.reload()}
          data-tip="Reload this page"
        >
          <RotateCw size={15} />
        </button>

        <div className="web-panel-title">
          <strong>{state.kind === 'apply' ? 'Apply' : 'Listing'}</strong>
          <span>{state.title}</span>
        </div>

        {state.loading && <Loader2 size={14} className="spin" />}

        {/*
          Provenance, not an address bar. It matters that the user can see this is
          genuinely Indeed's own page — Seekr never fills the form or submits it.
        */}
        <span className="web-panel-host">
          <ShieldCheck size={12} />
          {state.host || 'loading…'}
        </span>

        <button className="btn icon ghost" onClick={onClose} data-tip="Close and return to Seekr">
          <X size={16} />
        </button>
      </header>

      {/* Measured, never painted into — the Indeed page is laid over this. */}
      <div className="web-panel-slot" ref={slot} />
    </div>
  )
}
