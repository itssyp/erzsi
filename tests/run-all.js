/**
 * run-all.js
 * Runs unit tests first (no Firebase), then starts the emulator and runs emulator tests.
 *
 * Usage:  node run-all.js      (from the tests/ directory)
 */

import { execFileSync, spawn } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

console.log('\n╔══════════════════════════════════════════════════╗')
console.log('║     ERZSI 2.0 — FULL TEST SUITE                 ║')
console.log('╚══════════════════════════════════════════════════╝\n')

const start = Date.now()

// Phase 1: Unit tests (no Firebase required)
console.log('━━━ PHASE 1: Unit Tests (no Firebase) ━━━\n')
try {
  await import('./01-unit-tests.js')
} catch (e) {
  console.error('Unit tests failed with unexpected error:', e.message)
}

// Phase 2: Emulator-based tests
console.log('\n━━━ PHASE 2: Emulator Tests ━━━\n')
const emulatorScript = resolve(__dirname, 'run-emulator-tests.js')

// Run as a subprocess so emulator cleanup is clean
const proc = spawn('node', [emulatorScript], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: false,
})

await new Promise((resolve) => proc.once('exit', resolve))

const elapsed = ((Date.now() - start) / 1000).toFixed(1)
console.log(`\n✓  All test phases complete in ${elapsed}s`)
console.log('\nNext steps:')
console.log('  • Deploy and re-run against staging with real user load (k6 / artillery)')
console.log('  • Check RESULTS.md for the full findings report')
