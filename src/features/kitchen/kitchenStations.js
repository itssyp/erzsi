// ───────────────────────────────────────────────────────────────────────────────
// Kitchen station classification — shared between the POS (uses the trigger
// regexes to decide which customizer to launch) and the kitchen queue (uses
// it to split orders into per-station tickets, render station badges, and
// filter the board).
//
// Adding a new station means: append to KITCHEN_STATIONS, add a label + colour
// + STATION_PATTERN entry. Anywhere that wants to filter (e.g. the kitchen pill
// row) reads FILTERABLE_STATIONS so "other" never gets a chip but still tracks
// independently in the data.
// ───────────────────────────────────────────────────────────────────────────────

import { isFoodCategory } from '../products/productModels'
import { FOOD_ORDER_STATUSES } from '../orders/orderModels'

export const KITCHEN_STATIONS = Object.freeze({
  burger: 'burger',
  gyros:  'gyros',
  pizza:  'pizza',
  other:  'other',
})

/** Order in which station chips render on the filter bar. "other" omitted. */
export const FILTERABLE_STATIONS = Object.freeze([
  KITCHEN_STATIONS.burger,
  KITCHEN_STATIONS.gyros,
  KITCHEN_STATIONS.pizza,
])

export const KITCHEN_STATION_LABELS = Object.freeze({
  [KITCHEN_STATIONS.burger]: 'Burger',
  [KITCHEN_STATIONS.gyros]:  'Gyros',
  [KITCHEN_STATIONS.pizza]:  'Pizza',
  [KITCHEN_STATIONS.other]:  'Egyéb',
})

export const KITCHEN_STATION_COLORS = Object.freeze({
  [KITCHEN_STATIONS.burger]: '#dc2626',  // red
  [KITCHEN_STATIONS.gyros]:  '#d97706',  // amber
  [KITCHEN_STATIONS.pizza]:  '#16a34a',  // green — basil / Italian cuisine
  [KITCHEN_STATIONS.other]:  '#64748b',  // slate
})

// Trigger regexes — also imported by StaffPosPanel to decide which customizer
// (burger/gyros/pizza builder, or fun-mode catch game) to launch.
export const BURGER_TRIGGER_PATTERN = /\b(?:ham)?burger\b/i
export const GYROS_TRIGGER_PATTERN  = /\bgyros\b/i
export const PIZZA_TRIGGER_PATTERN  = /\bpizza\b/i

const STATION_PATTERNS = [
  { kind: KITCHEN_STATIONS.burger, re: BURGER_TRIGGER_PATTERN },
  { kind: KITCHEN_STATIONS.gyros,  re: GYROS_TRIGGER_PATTERN },
  { kind: KITCHEN_STATIONS.pizza,  re: PIZZA_TRIGGER_PATTERN },
]

/**
 * Classify a single line into a kitchen station.
 *
 * Returns one of KITCHEN_STATIONS values for any food line, or `null` for
 * non-food lines (drinks, DRS deposit, returns, etc.). The caller is responsible
 * for the order's overall food-ness — this only looks at line.category.
 *
 * Matching uses productName first, then modifierTemplateId as a fallback
 * (some legacy products may have generic names but a station-shaped template).
 */
export function classifyKitchenStation(line) {
  if (!line || !isFoodCategory(line.category)) return null
  const haystack = `${line.productName || ''} ${line.modifierTemplateId || ''}`
  for (const { kind, re } of STATION_PATTERNS) {
    if (re.test(haystack)) return kind
  }
  return KITCHEN_STATIONS.other
}

/** Return the set of stations touched by an order's food lines. */
export function getOrderStations(order) {
  const stations = new Set()
  for (const line of order?.lines || []) {
    const s = classifyKitchenStation(line)
    if (s) stations.add(s)
  }
  return stations
}

/**
 * Split an order into per-station "tickets" the kitchen UI renders.
 *
 * Each returned ticket has:
 *   - id:               `${orderId}::${station}` — stable React key
 *   - order:            the raw order doc (so the ticket can read customer info)
 *   - station:          one of KITCHEN_STATIONS values
 *   - lines:            food lines belonging to this station only
 *   - status:           per-station status from order.foodStatusByStation, OR
 *                       (lazy fallback) order.foodStatus when the order pre-dates
 *                       the split feature and has no per-station map yet
 *   - statusUpdatedAt:  per-station timestamp, with same lazy fallback
 *   - totalCount:       total tickets this order was split into — for the
 *                       "1/3 of order" header hint in Phase 5
 *   - index:            this ticket's position (0-based) among the order's
 *                       split tickets, for the same hint
 *
 * Tickets are returned in a stable order: burger → gyros → pizza → other.
 * Non-food orders return an empty array.
 */
export function splitOrderByStation(order) {
  if (!order?.lines?.length) return []
  const linesByStation = new Map()
  for (const line of order.lines) {
    const station = classifyKitchenStation(line)
    if (!station) continue
    if (!linesByStation.has(station)) linesByStation.set(station, [])
    linesByStation.get(station).push(line)
  }
  if (!linesByStation.size) return []

  // Stable ordering so tickets don't shuffle around in the board.
  const ordered = [
    KITCHEN_STATIONS.burger,
    KITCHEN_STATIONS.gyros,
    KITCHEN_STATIONS.pizza,
    KITCHEN_STATIONS.other,
  ].filter((s) => linesByStation.has(s))

  const byStation = order.foodStatusByStation || null
  const byStationTs = order.foodStatusUpdatedAtByStation || null

  return ordered.map((station, index) => ({
    id: `${order.id}::${station}`,
    order,
    station,
    lines: linesByStation.get(station),
    // Per-station status if present, else fall back to the order-level field
    // (handles orders created before the split feature shipped).
    status: byStation?.[station] || order.foodStatus || FOOD_ORDER_STATUSES.new,
    statusUpdatedAt: byStationTs?.[station] || order.foodStatusUpdatedAt || null,
    totalCount: ordered.length,
    index,
  }))
}

/**
 * Compute the derived overall foodStatus from a per-station map.
 *
 * - delivered iff every present station is delivered
 * - otherwise the LEAST-advanced status across stations
 *
 * Used by updateFoodOrderStatus to keep the legacy single field in sync, so
 * useKitchenWorkload (which reads foodStatus) keeps working unchanged.
 */
export function deriveOverallFoodStatus(byStation) {
  const values = Object.values(byStation || {}).filter(Boolean)
  if (!values.length) return null
  const order = [
    FOOD_ORDER_STATUSES.new,
    FOOD_ORDER_STATUSES.preparing,
    FOOD_ORDER_STATUSES.ready,
    FOOD_ORDER_STATUSES.delivered,
  ]
  const indexOf = (s) => {
    const i = order.indexOf(s)
    return i === -1 ? 0 : i
  }
  if (values.every((v) => v === FOOD_ORDER_STATUSES.delivered)) {
    return FOOD_ORDER_STATUSES.delivered
  }
  // Min (least-advanced) across stations.
  let minIdx = Infinity
  for (const v of values) {
    const i = indexOf(v)
    if (i < minIdx) minIdx = i
  }
  return order[minIdx] || FOOD_ORDER_STATUSES.new
}
