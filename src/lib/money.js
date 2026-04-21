const hufFormatter = new Intl.NumberFormat('hu-HU')

export function parseHufInteger(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null
  }

  const normalized = String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/,/g, '')

  if (!normalized || !/^-?\d+$/.test(normalized)) {
    return null
  }

  return Number.parseInt(normalized, 10)
}

export function formatHuf(value) {
  if (!Number.isInteger(value)) {
    return '-'
  }

  return `${hufFormatter.format(value)} HUF`
}
