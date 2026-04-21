import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

export function QrCodeCard({ value, label }) {
  const [svgMarkup, setSvgMarkup] = useState('')
  const displayValue = value?.includes('/qr/')
    ? value.split('/qr/').pop()?.replace(/\/+$/, '') || value
    : value

  useEffect(() => {
    let cancelled = false

    if (!value) {
      setSvgMarkup('')
      return () => {}
    }

    QRCode.toString(value, {
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
  }, [value])

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
