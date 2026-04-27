/**
 * run-emulator-tests.js
 * Starts the Firebase Firestore emulator, then runs each test file in its own
 * Node.js subprocess (to avoid shared SDK state between tests).
 *
 * Usage:  node run-emulator-tests.js      (from the tests/ directory)
 */

import { spawn } from 'child_process'
import { createConnection } from 'net'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

const EMULATOR_PORT = 8080
const EMULATOR_HOST = '127.0.0.1'

function pollPort(port, host, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs

    function attempt() {
      if (Date.now() > deadline) {
        return reject(new Error(`Emulator port ${port} not ready within ${timeoutMs / 1000}s`))
      }
      const socket = createConnection({ port, host })
      socket.once('connect', () => { socket.destroy(); resolve() })
      socket.once('error', () => setTimeout(attempt, 800))
    }

    attempt()
  })
}

function runNode(scriptPath) {
  return new Promise((resolve) => {
    const proc = spawn('node', [scriptPath], {
      cwd: __dirname,
      stdio: 'inherit',
      shell: false,
    })
    proc.once('exit', (code) => resolve(code ?? 0))
  })
}

async function startEmulator() {
  console.log('\n▶  Starting Firebase Firestore emulator...')

  const proc = spawn(
    'firebase',
    ['emulators:start', '--only', 'firestore', '--project', 'demo-erzsi-test'],
    { cwd: PROJECT_ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  proc.stdout.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach((l) => console.log(`  [emulator] ${l}`))
  })
  proc.stderr.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach((l) => process.stderr.write(`  [emulator:err] ${l}\n`))
  })

  await pollPort(EMULATOR_PORT, EMULATOR_HOST)
  console.log(`✓  Emulator ready on ${EMULATOR_HOST}:${EMULATOR_PORT}\n`)
  await new Promise((r) => setTimeout(r, 1500))
  return proc
}

let emulatorProc = null
let overallExitCode = 0

try {
  emulatorProc = await startEmulator()

  const tests = [
    { label: '02-emulator-tests.js — Concurrency & Correctness', file: '02-emulator-tests.js' },
    { label: '03-security-rules.js — Security Rules', file: '03-security-rules.js' },
  ]

  for (const { label, file } of tests) {
    console.log(`\n${'═'.repeat(52)}`)
    console.log(`   ${label}`)
    console.log('═'.repeat(52))
    const code = await runNode(resolve(__dirname, file))
    if (code !== 0) {
      console.error(`  ✗ ${file} exited with code ${code}`)
      overallExitCode = 1
    }
  }

} catch (err) {
  console.error('\n✗  Emulator startup failed:', err.message)
  overallExitCode = 1
} finally {
  if (emulatorProc) {
    console.log('\n▶  Stopping emulator...')
    emulatorProc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 1000))
    console.log('✓  Emulator stopped.')
  }
  process.exit(overallExitCode)
}
