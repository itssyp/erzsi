import { useEffect, useRef } from 'react'
import QrScanner from 'qr-scanner'

export function useQrScanner({ active, onDetected, onError }) {
  const videoRef = useRef(null)
  const detectedHandlerRef = useRef(onDetected)
  const errorHandlerRef = useRef(onError)

  detectedHandlerRef.current = onDetected
  errorHandlerRef.current = onError

  const scannerSupported = typeof window !== 'undefined'
    && typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)

  useEffect(() => {
    const videoElement = videoRef.current

    if (!active || !scannerSupported || !videoElement) {
      return () => {}
    }

    let disposed = false

    const scanner = new QrScanner(
      videoElement,
      (result) => {
        if (disposed) {
          return
        }

        const rawValue = typeof result === 'string' ? result : result?.data

        if (rawValue) {
          detectedHandlerRef.current?.(rawValue)
        }
      },
      {
        preferredCamera: 'environment',
        highlightScanRegion: false,
        highlightCodeOutline: false,
        returnDetailedScanResult: true,
      },
    )

    scanner.start().catch((error) => {
      if (!disposed) {
        errorHandlerRef.current?.(error)
      }
    })

    return () => {
      disposed = true
      scanner.stop()
      scanner.destroy()
    }
  }, [active, scannerSupported])

  return {
    videoRef,
    scannerSupported,
  }
}
