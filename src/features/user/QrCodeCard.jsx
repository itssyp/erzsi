import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { normalizeQrInput } from '../qr/qrLinks'

export function QrCodeCard({ value, label }) {
  const [svgMarkup, setSvgMarkup] = useState('')
  const displayValue = value?.includes('/qr/')
    ? value.split('/qr/').pop()?.replace(/\/+$/, '') || value
    : value
  let qrPayload = ''

  try {
    qrPayload = normalizeQrInput(value)
  } catch {
    // Preserve rendering for any unexpected legacy value instead of hiding it.
    qrPayload = value || ''
  }

  useEffect(() => {
    let cancelled = false

    if (!qrPayload) {
      setSvgMarkup('')
      return () => {}
    }

    QRCode.toString(qrPayload, {
      type: 'svg',
      width: 256,
      margin: 1,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    }).then((markup) => {
      if (!cancelled) {
        setSvgMarkup(markup)
      }
    }).catch(() => {
      if (!cancelled) {
        setSvgMarkup('')
      }
    })

    return () => {
      cancelled = true
    }
  }, [qrPayload])

  return (
    <section className="panel qr-panel">
      <h3 className="card-title">{label}</h3>
      {value ? (
        <>
          <div className="qr-frame" dangerouslySetInnerHTML={{ __html: svgMarkup }} />
          <p className="helper-text qr-caption">{displayValue}</p>
        </>
      ) : (
        <p className="helper-text">QR code is not assigned yet.</p>
      )}
    </section>
  )
}
