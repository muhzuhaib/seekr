import { useEffect } from 'react'

/**
 * The app's own confirm dialog.
 *
 * Replaces Electron's `dialog.showMessageBox`, which draws a grey Windows box that
 * ignores the theme, the font and the accent colour.
 */
export default function Confirm({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel
}: {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onConfirm, onCancel])

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
        </div>
        <div className="modal-body">
          <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
            {message}
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
