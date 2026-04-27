// Shared test helpers: assertions, timing, result reporting

let passCount = 0
let failCount = 0
const failures = []

export function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passCount++
  } else {
    console.error(`  ✗ ${label}`)
    failCount++
    failures.push(label)
  }
}

export function assertEqual(actual, expected, label) {
  if (actual === expected) {
    console.log(`  ✓ ${label} (got ${JSON.stringify(actual)})`)
    passCount++
  } else {
    console.error(`  ✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    failCount++
    failures.push(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

export function assertThrows(fn, expectedMsg, label) {
  try {
    fn()
    console.error(`  ✗ ${label} — expected throw but did not throw`)
    failCount++
    failures.push(`${label} — expected throw but did not throw`)
  } catch (e) {
    if (expectedMsg && !e.message.includes(expectedMsg)) {
      console.error(`  ✗ ${label} — wrong error: ${e.message}`)
      failCount++
      failures.push(`${label} — wrong error: ${e.message}`)
    } else {
      console.log(`  ✓ ${label} (threw: ${e.message})`)
      passCount++
    }
  }
}

export function section(name) {
  console.log(`\n── ${name} ──`)
}

export function printSummary(label = '') {
  console.log(`\n${'═'.repeat(60)}`)
  if (label) console.log(label)
  console.log(`PASSED: ${passCount}   FAILED: ${failCount}`)
  if (failures.length) {
    console.log('\nFailed assertions:')
    failures.forEach((f) => console.log(`  • ${f}`))
  }
  console.log('═'.repeat(60))
  return { passCount, failCount, failures }
}

export function resetCounts() {
  passCount = 0
  failCount = 0
  failures.length = 0
}

export async function time(label, fn) {
  const start = performance.now()
  const result = await fn()
  const ms = (performance.now() - start).toFixed(1)
  console.log(`  ⏱  ${label}: ${ms}ms`)
  return { result, ms: parseFloat(ms) }
}

export function stats(values) {
  if (!values.length) return { min: 0, max: 0, p50: 0, p95: 0, p99: 0, mean: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: parseFloat(mean.toFixed(1)),
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
  }
}

export function printStats(label, latencies) {
  const s = stats(latencies)
  console.log(
    `  📊 ${label}: min=${s.min}ms p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms max=${s.max}ms mean=${s.mean}ms`,
  )
  return s
}
