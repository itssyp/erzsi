export const QR_CODE_LENGTH = 4
export const QR_PUBLIC_BASE_URL = 'https://kasszaserzsi.hu'
const MAX_QR_INPUT_LENGTH = 512

export function isQrCode(value) {
  return new RegExp(`^\\d{${QR_CODE_LENGTH}}$`).test(value)
}

export function buildQrCredentialLink(code) {
  if (!isQrCode(code)) {
    return ''
  }

  try {
    return new URL(`/qr/${code}`, QR_PUBLIC_BASE_URL).toString()
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

  if (isQrCode(value)) {
    return value
  }

  const embeddedQrPathMatch = value.match(new RegExp(`/qr/(\\d{${QR_CODE_LENGTH}})(?:[/?#\\s]|$)`, 'i'))

  if (embeddedQrPathMatch?.[1]) {
    return embeddedQrPathMatch[1]
  }

  try {
    const parsedUrl = new URL(value)
    const queryCandidate = parsedUrl.searchParams.get('code') || parsedUrl.searchParams.get('qr')

    if (queryCandidate && isQrCode(queryCandidate.trim())) {
      return queryCandidate.trim()
    }

    const pathMatch = parsedUrl.pathname.match(new RegExp(`/qr/(\\d{${QR_CODE_LENGTH}})/?$`, 'i'))

    if (pathMatch?.[1]) {
      return pathMatch[1]
    }
  } catch {
    // Fall through to the validation error below.
  }

  throw new Error(`QR input must be a ${QR_CODE_LENGTH}-digit code or QR link.`)
}
