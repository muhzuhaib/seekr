import { useEffect, useRef, useState } from 'react'

/**
 * One tooltip for the whole app.
 *
 * Native `title` tooltips are slow, unstyled, and render as an OS box that ignores
 * the theme entirely. This listens at the document level for anything carrying a
 * `data-tip` attribute, so components opt in with one prop and no wrapper.
 *
 * Placement: `data-tip-side="right"` for the icon rail, otherwise below the element,
 * flipping above when there isn't room.
 */

interface TipState {
  text: string
  x: number
  y: number
  side: 'top' | 'bottom' | 'right'
}

const OPEN_DELAY = 380
const GAP = 9

export default function Tooltip(): JSX.Element | null {
  const [tip, setTip] = useState<TipState | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    const cancel = (): void => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
      setTip(null)
    }

    const show = (el: HTMLElement): void => {
      const text = el.getAttribute('data-tip')
      if (!text) return

      const rect = el.getBoundingClientRect()
      const requested = el.getAttribute('data-tip-side')

      let side: TipState['side'] = requested === 'right' ? 'right' : 'bottom'
      // Flip above when the element sits near the bottom of the window.
      if (side === 'bottom' && rect.bottom + 56 > window.innerHeight) side = 'top'

      const x = side === 'right' ? rect.right + GAP : rect.left + rect.width / 2
      const y = side === 'right' ? rect.top + rect.height / 2 : side === 'bottom' ? rect.bottom + GAP : rect.top - GAP

      setTip({ text, x, y, side })
    }

    const onOver = (event: Event): void => {
      const target = (event.target as HTMLElement | null)?.closest?.('[data-tip]')
      if (!(target instanceof HTMLElement)) return
      cancel()
      timer.current = window.setTimeout(() => show(target), OPEN_DELAY)
    }

    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', cancel)
    document.addEventListener('focusin', onOver)
    document.addEventListener('focusout', cancel)
    // Any scroll, click or key press invalidates the anchor position.
    document.addEventListener('mousedown', cancel)
    document.addEventListener('keydown', cancel)
    window.addEventListener('scroll', cancel, true)

    return () => {
      cancel()
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', cancel)
      document.removeEventListener('focusin', onOver)
      document.removeEventListener('focusout', cancel)
      document.removeEventListener('mousedown', cancel)
      document.removeEventListener('keydown', cancel)
      window.removeEventListener('scroll', cancel, true)
    }
  }, [])

  if (!tip) return null

  return (
    <div className={`tooltip tooltip-${tip.side}`} style={{ left: tip.x, top: tip.y }} role="tooltip">
      {tip.text}
    </div>
  )
}
