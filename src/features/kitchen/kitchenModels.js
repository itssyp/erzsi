export const WORKLOAD_LEVELS = [
  { label: 'SZABAD',    min: 0,  max: 0,  barClass: 'kds-workload-clear',    fill: 0   },
  { label: 'ALACSONY',      min: 1,  max: 5,  barClass: 'kds-workload-low',      fill: 25  },
  { label: 'KÖZEPES',   min: 6,  max: 12, barClass: 'kds-workload-medium',   fill: 50  },
  { label: 'MAGAS',     min: 13, max: 20, barClass: 'kds-workload-high',     fill: 75  },
  { label: 'KRITIKUS', min: 21, max: Infinity, barClass: 'kds-workload-critical', fill: 100 },
]

export function getWorkloadLevel(activeItems) {
  return WORKLOAD_LEVELS.find((l) => activeItems >= l.min && activeItems <= l.max) ?? WORKLOAD_LEVELS[0]
}

/**
 * Estimate how many minutes until the kitchen clears the current queue.
 * Model: kitchen processes ITEMS_PER_MINUTE food items in parallel.
 * Items already in "preparing" are credited as half-done.
 */
const ITEMS_PER_MINUTE = 0.25

export function estimateWaitMinutes(newItems, preparingItems) {
  if (newItems + preparingItems === 0) return 0
  // Preparing items are already in progress — treat as half remaining time
  const effectiveItems = newItems + preparingItems * 0.5
  return Math.max(1, Math.round(effectiveItems / ITEMS_PER_MINUTE))
}

export function formatWaitTime(minutes) {
  if (minutes === 0) return 'Készen áll'
  if (minutes === 1) return '~1 perc'
  return `~${minutes} perc`
}
