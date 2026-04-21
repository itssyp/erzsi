export const QR_CODE_LENGTH = 5
const MAX_QR_INPUT_LENGTH = 512

export function isFiveDigitQrCode(value) {
  return /^\d{5}$/.test(value)
}

export function buildQrCredentialLink(appBaseUrl, code) {
  const baseUrl = typeof appBaseUrl === 'string' ? appBaseUrl.trim() : ''

  if (!baseUrl || !isFiveDigitQrCode(code)) {
    return ''
  }

  try {
    return new URL(`/qr/${code}`, baseUrl).toString()
  } catch {
    return ''
  }
}

export function normalizeQrInput(rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : ''

  if (!value) {
    throw new Error('QR input is required.')
  }

  if (value.length > MAX_QR_INPUT_LENGTH) {
    throw new Error('QR input is too long.')
  }

  if (isFiveDigitQrCode(value)) {
    return value
  }

  try {
    const parsedUrl = new URL(value)
    const queryCandidate = parsedUrl.searchParams.get('code') || parsedUrl.searchParams.get('qr')

    if (queryCandidate && isFiveDigitQrCode(queryCandidate.trim())) {
      return queryCandidate.trim()
    }

    const pathMatch = parsedUrl.pathname.match(/\/qr\/(\d{5})\/?$/i)

    if (pathMatch?.[1]) {
      return pathMatch[1]
    }
  } catch {
    // Fall through to the validation error below.
  }

  throw new Error('QR input must be a 5-digit code or QR link.')
}
