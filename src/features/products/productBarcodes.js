const NUMERIC_BARCODE_PATTERN = /^\d+$/
const RESERVED_PERSON_QR_CODE_LENGTH = 4

export function normalizeProductBarcode(value) {
  const normalized = String(value ?? '').trim()

  if (!normalized) {
    throw new Error('A vonalkod nem lehet ures.')
  }

  if (!NUMERIC_BARCODE_PATTERN.test(normalized)) {
    throw new Error('A vonalkod csak szamokat tartalmazhat.')
  }

  if (normalized.length === RESERVED_PERSON_QR_CODE_LENGTH) {
    throw new Error('A 4 jegyu kodok a persona QR kodoknak vannak fenntartva.')
  }

  return normalized
}

export function tryNormalizeProductBarcode(value) {
  try {
    return normalizeProductBarcode(value)
  } catch {
    return ''
  }
}

export function sanitizeProductBarcodes(values = []) {
  const seen = new Set()
  const normalizedBarcodes = []

  values.forEach((value) => {
    const barcode = normalizeProductBarcode(value)
    if (seen.has(barcode)) {
      throw new Error(`Duplikalt vonalkod: ${barcode}.`)
    }
    seen.add(barcode)
    normalizedBarcodes.push(barcode)
  })

  return normalizedBarcodes
}

export function parseBarcodeList(value) {
  return String(value ?? '')
    .split(/[\s,;|]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}
