// ───────────────────────────────────────────────────────────────────────────────
// Event analytics helpers — pure functions for the Statisztika tab.
//
// All time bucketing happens in Europe/Budapest, NOT UTC: a late-running event
// that crosses midnight should bucket post-midnight orders into the day the
// event started, not "tomorrow."
//
// Repohár (reusable cup) sells are normal product lines with no dedicated
// lineType — they're matched by productName against REPOHAR_NAME_PATTERN.
// Repohár returns and DRS-bottle deposits / returns have explicit lineTypes.
// ───────────────────────────────────────────────────────────────────────────────

import { normalizeProductCategory } from '../products/productModels'

export const BUDAPEST_TZ = 'Europe/Budapest'

// Single source of truth — kept aligned with RepoharTrackerPanel.
export const REPOHAR_NAME_PATTERN = /repoh[áa]r/i

const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUDAPEST_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const HOUR_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUDAPEST_TZ,
  hour: '2-digit',
  hour12: false,
})

const HUMAN_DATE_FORMATTER = new Intl.DateTimeFormat('hu-HU', {
  timeZone: BUDAPEST_TZ,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
})

function timestampToMs(value) {
  if (!value) return null
  if (typeof value.toMillis === 'function') return value.toMillis()
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  return null
}

/** ISO date string (YYYY-MM-DD) in Europe/Budapest, or null. */
export function bucketDate(timestamp) {
  const ms = timestampToMs(timestamp)
  if (ms === null) return null
  return DATE_FORMATTER.format(new Date(ms))
}

/** 0–23 hour in Europe/Budapest, or null. */
export function bucketHour(timestamp) {
  const ms = timestampToMs(timestamp)
  if (ms === null) return null
  const h = HOUR_FORMATTER.format(new Date(ms))
  return Number(h)
}

/** "2026. május 17., szo" — for the day picker / chart axis. */
export function formatDayLabel(isoDate) {
  if (!isoDate) return ''
  // Parse as local Europe/Budapest noon to avoid TZ drift on the formatter.
  const [year, month, day] = isoDate.split('-').map(Number)
  if (!year || !month || !day) return isoDate
  const d = new Date(Date.UTC(year, month - 1, day, 12))
  return HUMAN_DATE_FORMATTER.format(d)
}

// ── Line classification ──────────────────────────────────────────────────────

function classifyLine(line) {
  if (!line) return null
  if (line.lineType === 'drs') return 'drsDeposit'
  if (line.lineType === 'drsReturn') return 'drsReturn'
  if (line.lineType === 'reusableCupReturn') return 'reusableCupReturn'
  if (line.lineType === 'product' && REPOHAR_NAME_PATTERN.test(line.productName || '')) {
    return 'reusableCupSell'
  }
  if (line.lineType === 'product') return 'product'
  return null
}

function effectiveQuantity(line) {
  return Math.max(0, (line.quantity || 0) - (line.refundedQuantity || 0))
}

function effectiveRevenue(line) {
  // Each refunded unit removes one unitTotal slice of the lineTotal.
  const refunded = line.refundedQuantity || 0
  if (!refunded) return line.lineTotal || 0
  return (line.lineTotal || 0) - (line.unitTotal || 0) * refunded
}

// ── Bucket factory ───────────────────────────────────────────────────────────

function createBucket(date = null) {
  return {
    date,

    // Money
    revenueGross: 0,         // sum of all order.totalAmount (can include negatives)
    refundsTotal: 0,         // sum of order.refundedTotal
    creditReturnsTotal: 0,   // |sum of negative line totals on return lines|
    topupsTotal: 0,          // from ledgerEntries type=topup
    avgOrderValue: 0,        // derived at finalize time

    // Volume
    orderCount: 0,
    itemCount: 0,            // sum of qty on product lines, refunds applied
    uniqueCustomers: new Set(),

    // Breakdowns (keyed by id / name)
    revenueByCategory: new Map(),
    itemsByCategory: new Map(),
    productStats: new Map(), // productId → { name, category, qty, revenue, refundedQty }
    spendByCustomer: new Map(), // personId → { name, displayId, team, attendeeType, count, total }
    ordersByStaff: new Map(),   // staffUid → { name, count, revenue }

    // Time-of-day arrays (24 slots, always full length)
    ordersByHour: new Array(24).fill(0),
    revenueByHour: new Array(24).fill(0),

    // Specials
    drsBottlesSold: 0,
    drsBottlesReturned: 0,
    reusableCupsSold: 0,
    reusableCupsReturned: 0,
  }
}

function ensureBucket(byDate, date) {
  let bucket = byDate.get(date)
  if (!bucket) {
    bucket = createBucket(date)
    byDate.set(date, bucket)
  }
  return bucket
}

// ── Public: compute aggregate + daily ────────────────────────────────────────

/**
 * @param {{ orders: any[], ledgerEntries: any[], people: any[] }} input
 * @returns {{ aggregate, daily, byDate, eventDays }}
 */
export function buildStatistics({ orders, ledgerEntries, people }) {
  const aggregate = createBucket(null)
  const byDate = new Map()
  const peopleById = new Map(people.map((p) => [p.id, p]))

  for (const order of orders) {
    const date = bucketDate(order.createdAt)
    const hour = bucketHour(order.createdAt)
    const dayBucket = date ? ensureBucket(byDate, date) : null
    const buckets = dayBucket ? [aggregate, dayBucket] : [aggregate]

    const orderTotal = order.totalAmount || 0
    const refunded = order.refundedTotal || 0

    for (const b of buckets) {
      b.orderCount += 1
      b.revenueGross += orderTotal
      b.refundsTotal += refunded
      if (order.personId) b.uniqueCustomers.add(order.personId)

      if (hour !== null) {
        b.ordersByHour[hour] += 1
        b.revenueByHour[hour] += orderTotal
      }

      // Per-customer spend
      if (order.personId) {
        const person = peopleById.get(order.personId)
        const row = b.spendByCustomer.get(order.personId) || {
          personId: order.personId,
          name: order.personDisplayName || person?.displayName || 'Ismeretlen',
          displayId: order.personDisplayId || order.personInternalId || person?.internalId || '',
          team: person?.team || '',
          attendeeType: person?.attendeeType || '',
          count: 0,
          total: 0,
        }
        row.count += 1
        row.total += orderTotal
        b.spendByCustomer.set(order.personId, row)
      }

      // Per-staff
      if (order.createdByUid) {
        const row = b.ordersByStaff.get(order.createdByUid) || {
          uid: order.createdByUid,
          name: order.createdByName || 'Ismeretlen',
          count: 0,
          revenue: 0,
        }
        row.count += 1
        row.revenue += orderTotal
        b.ordersByStaff.set(order.createdByUid, row)
      }
    }

    // Walk lines once per order, fan-out to both buckets.
    for (const line of order.lines || []) {
      const kind = classifyLine(line)
      if (!kind) continue

      const qty = effectiveQuantity(line)
      const revenue = effectiveRevenue(line)
      const category = normalizeProductCategory(line.category) || 'Egyéb'

      for (const b of buckets) {
        if (kind === 'product' || kind === 'reusableCupSell') {
          b.itemCount += qty

          b.revenueByCategory.set(category, (b.revenueByCategory.get(category) || 0) + revenue)
          b.itemsByCategory.set(category, (b.itemsByCategory.get(category) || 0) + qty)

          const productKey = line.productId || `${category}:${line.productName}`
          const productRow = b.productStats.get(productKey) || {
            key: productKey,
            productId: line.productId || null,
            name: line.productName || 'Ismeretlen termék',
            category,
            qty: 0,
            revenue: 0,
            refundedQty: 0,
          }
          productRow.qty += qty
          productRow.revenue += revenue
          productRow.refundedQty += line.refundedQuantity || 0
          b.productStats.set(productKey, productRow)
        }

        if (kind === 'drsDeposit') {
          b.drsBottlesSold += qty
        }
        if (kind === 'drsReturn') {
          b.drsBottlesReturned += qty
          b.creditReturnsTotal += Math.abs(revenue)
        }
        if (kind === 'reusableCupSell') {
          b.reusableCupsSold += qty
        }
        if (kind === 'reusableCupReturn') {
          b.reusableCupsReturned += qty
          b.creditReturnsTotal += Math.abs(revenue)
        }
      }
    }
  }

  // Top-ups from ledger
  for (const entry of ledgerEntries) {
    if (entry.type !== 'topup' && entry.type !== 'TOPUP') continue
    const date = bucketDate(entry.createdAt)
    const dayBucket = date ? ensureBucket(byDate, date) : null
    const amount = entry.amount || 0
    aggregate.topupsTotal += amount
    if (dayBucket) dayBucket.topupsTotal += amount
  }

  // Derived: average order value (positive cash flow only)
  function finishBucket(b) {
    b.avgOrderValue = b.orderCount > 0 ? Math.round(b.revenueGross / b.orderCount) : 0
  }
  finishBucket(aggregate)
  for (const b of byDate.values()) finishBucket(b)

  const daily = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
  const eventDays = daily.map((b) => b.date)

  return { aggregate, daily, byDate, eventDays }
}

// ── Display helpers ──────────────────────────────────────────────────────────

export function bucketRevenueNet(bucket) {
  if (!bucket) return 0
  return bucket.revenueGross - bucket.refundsTotal
}

export function emptyBucket() {
  return createBucket(null)
}

// ── Category colour palette (shared with the catalog colour chips) ──────────

const CATEGORY_COLORS = {
  'Sör':       '#d97706',
  'Bor':       '#7c3aed',
  'Hosszúital':'#ea580c',
  'Üditő':     '#059669',
  'Nasi':      '#db2777',
  'Kaja':      '#dc2626',
  'Egyéb':     '#64748b',
}
const FALLBACK_PALETTE = [
  '#0ea5e9', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4',
  '#f43f5e', '#84cc16', '#eab308', '#ec4899', '#14b8a6',
]

export function colorForCategory(category, fallbackIndex = 0) {
  if (CATEGORY_COLORS[category]) return CATEGORY_COLORS[category]
  return FALLBACK_PALETTE[fallbackIndex % FALLBACK_PALETTE.length]
}

/** Convert a Map (or object) of category→value into a sorted recharts dataset. */
export function categoryDataset(input) {
  const entries = input instanceof Map
    ? Array.from(input.entries())
    : Object.entries(input || {})
  return entries
    .filter(([, v]) => v !== 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value], i) => ({
      name,
      value,
      fill: colorForCategory(name, i),
    }))
}

/** Convert a Map of any-key → row into a sorted recharts dataset by a field. */
export function topRows(map, valueField, limit = 10) {
  return Array.from(map.values())
    .filter((r) => r[valueField] > 0)
    .sort((a, b) => b[valueField] - a[valueField])
    .slice(0, limit)
}

// ── CSV export ──────────────────────────────────────────────────────────────

function csvField(value) {
  if (value === null || value === undefined) return ''
  const s = typeof value === 'string' ? value : String(value)
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/** Build a CSV string from a header row + array of row arrays. */
export function toCsv(rows) {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n')
}

/** Trigger a browser download with UTF-8 BOM so Excel opens it correctly. */
export function downloadCsv(filename, csvText) {
  const BOM = '﻿' // UTF-8 BOM for Excel friendliness
  const blob = new Blob([BOM + csvText], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Defer revoke to next tick so Firefox finishes the navigation.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Per-day summary rows (one row per day). */
export function buildDailyCsv(daily) {
  const rows = [[
    'Dátum', 'Bevétel', 'Visszatérítés', 'Nettó',
    'Rendelések', 'Tételek', 'Egyedi vendégek', 'Átlag kosár',
    'DRS eladva', 'DRS vissza', 'Repohár eladva', 'Repohár vissza',
    'Feltöltés',
  ]]
  for (const b of daily) {
    rows.push([
      b.date,
      b.revenueGross,
      b.refundsTotal,
      b.revenueGross - b.refundsTotal,
      b.orderCount,
      b.itemCount,
      b.uniqueCustomers.size,
      b.avgOrderValue,
      b.drsBottlesSold,
      b.drsBottlesReturned,
      b.reusableCupsSold,
      b.reusableCupsReturned,
      b.topupsTotal,
    ])
  }
  return toCsv(rows)
}

/** Per-product rows (one row per product, event-wide). */
export function buildProductCsv(productStats) {
  const rows = [[
    'Termék',
    'Kategória',
    'Eladott darab (bruttó)',
    'Visszatérített darab',
    'Nettó darab',
    'Nettó bevétel (HUF)',
  ]]
  const sorted = Array.from(productStats.values())
    .sort((a, b) => b.revenue - a.revenue)
  for (const p of sorted) {
    // productStats.qty is ALREADY net of refunds (see buildStatistics), so the
    // gross sold count is qty + refundedQty.
    const grossSold = p.qty + (p.refundedQty || 0)
    rows.push([p.name, p.category, grossSold, p.refundedQty, p.qty, p.revenue])
  }
  return toCsv(rows)
}

/** Per-customer rows (one row per customer, event-wide). */
export function buildCustomerCsv(spendByCustomer) {
  const rows = [[
    'Név', 'Display ID', 'Csapat', 'Típus', 'Rendelés', 'Átlag kosár', 'Összesen',
  ]]
  const sorted = Array.from(spendByCustomer.values())
    .sort((a, b) => b.total - a.total)
  for (const c of sorted) {
    const avg = c.count > 0 ? Math.round(c.total / c.count) : 0
    rows.push([c.name, c.displayId, c.team, c.attendeeType, c.count, avg, c.total])
  }
  return toCsv(rows)
}
