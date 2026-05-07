import { useCallback, useEffect, useRef, useState } from 'react'
import { useQrScanner } from './useQrScanner'
import { selfAssignQrCredential } from './qrService'
import { normalizeQrInput } from './qrLinks'

const STEPS = {
  scan: 'scan',
  success: 'success',
}

function SuccessCheckmark() {
  return (
    <svg
      className="qr-assign-checkmark"
      viewBox="0 0 52 52"
      fill="none"
      aria-hidden="true"
    >
      <circle className="qr-assign-checkmark-circle" cx="26" cy="26" r="23" />
      <path className="qr-assign-checkmark-path" d="M14 26l9 9 15-17" />
    </svg>
  )
}

export function QrSelfAssignOverlay({ eventId, onClose }) {
  const [step, setStep] = useState(STEPS.scan)
  const [mode, setMode] = useState('camera') // 'camera' | 'manual'
  const [manualCode, setManualCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [scanActive, setScanActive] = useState(true)
  const detectedRef = useRef(false)

  const handleDetected = useCallback(async (rawValue) => {
    if (detectedRef.current || pending) return
    detectedRef.current = true
    setScanActive(false)

    let normalized
    try {
      normalized = normalizeQrInput(rawValue)
    } catch {
      setError('Nem ismerhető fel a QR-kód. Próbáld manuálisan.')
      detectedRef.current = false
      setScanActive(true)
      return
    }

    await doAssign(normalized)
  }, [pending]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleScanError = useCallback((err) => {
    // Ignore routine "no QR found" errors from the scanner
    if (err?.message?.toLowerCase().includes('no qr code found')) return
    setError('A kamera nem elérhető. Próbáld manuálisan.')
    setMode('manual')
  }, [])

  const { videoRef, scannerSupported } = useQrScanner({
    active: mode === 'camera' && scanActive && step === STEPS.scan,
    onDetected: handleDetected,
    onError: handleScanError,
  })

  // If camera not supported, drop to manual automatically
  useEffect(() => {
    if (!scannerSupported) setMode('manual')
  }, [scannerSupported])

  async function doAssign(code) {
    setPending(true)
    setError('')
    try {
      await selfAssignQrCredential({ eventId, qrInput: code })
      setStep(STEPS.success)
    } catch (err) {
      setError(err?.message || 'Nem sikerült hozzárendelni a QR-kódot.')
      detectedRef.current = false
      setScanActive(true)
    } finally {
      setPending(false)
    }
  }

  async function handleManualSubmit(e) {
    e.preventDefault()
    if (!manualCode.trim() || pending) return
    let normalized
    try {
      normalized = normalizeQrInput(manualCode.trim())
    } catch (err) {
      setError(err?.message || 'Érvénytelen kód.')
      return
    }
    await doAssign(normalized)
  }

  // Auto-close after success animation
  useEffect(() => {
    if (step !== STEPS.success) return
    const timer = setTimeout(onClose, 2000)
    return () => clearTimeout(timer)
  }, [step, onClose])

  return (
    <div className="qr-assign-overlay" role="dialog" aria-modal="true" aria-label="QR-kód hozzárendelése">
      <div className="qr-assign-sheet">
        {step === STEPS.success ? (
          <div className="qr-assign-success">
            <SuccessCheckmark />
            <p className="qr-assign-success-label">QR-kód hozzárendelve!</p>
          </div>
        ) : (
          <>
            <div className="qr-assign-header">
              <h2 className="qr-assign-title">QR-kód igénylése</h2>
              <button
                type="button"
                className="qr-assign-close"
                onClick={onClose}
                aria-label="Bezárás"
              >
                ✕
              </button>
            </div>

            <div className="qr-assign-mode-tabs">
              <button
                type="button"
                className={`qr-assign-mode-tab${mode === 'camera' ? ' active' : ''}`}
                onClick={() => { setMode('camera'); setError(''); setScanActive(true); detectedRef.current = false }}
                disabled={!scannerSupported}
              >
                📷 Kamera
              </button>
              <button
                type="button"
                className={`qr-assign-mode-tab${mode === 'manual' ? ' active' : ''}`}
                onClick={() => { setMode('manual'); setError(''); setScanActive(false) }}
              >
                ⌨ Kód megadása
              </button>
            </div>

            {mode === 'camera' && (
              <div className="qr-assign-camera-wrap">
                <video
                  ref={videoRef}
                  className="qr-assign-video"
                  playsInline
                  muted
                />
                <div className="qr-assign-viewfinder" aria-hidden="true" />
                {pending && (
                  <div className="qr-assign-camera-overlay">
                    <span className="qr-assign-scanning-label">Feldolgozás…</span>
                  </div>
                )}
                {!pending && (
                  <p className="qr-assign-hint">Tartsd a QR-kódot a keret elé</p>
                )}
              </div>
            )}

            {mode === 'manual' && (
              <form className="qr-assign-manual-form" onSubmit={handleManualSubmit}>
                <label htmlFor="qrManualCode" className="qr-assign-manual-label">
                  5 jegyű kód
                </label>
                <div className="qr-assign-manual-row">
                  <input
                    id="qrManualCode"
                    className="qr-assign-manual-input"
                    type="text"
                    inputMode="numeric"
                    pattern="\d{5}"
                    maxLength={5}
                    value={manualCode}
                    onChange={(e) => setManualCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
                    placeholder="00000"
                    autoFocus
                    disabled={pending}
                  />
                  <button
                    type="submit"
                    className="primary-button qr-assign-manual-submit"
                    disabled={pending || manualCode.length !== 5}
                  >
                    {pending ? 'Hozzárendelés…' : 'Hozzárendelés'}
                  </button>
                </div>
              </form>
            )}

            {error ? (
              <div className="qr-assign-error">{error}</div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
