import assert from 'node:assert/strict'
import { waitForActiveServiceWorker } from '../src/features/user/waitForActiveServiceWorker.js'

function worker(state) {
  const item = new EventTarget()
  item.state = state
  return item
}

function registration(overrides = {}) {
  return Object.assign(new EventTarget(), { active: null, installing: null, waiting: null }, overrides)
}

const active = registration({ active: worker('activated') })
assert.equal(await waitForActiveServiceWorker(active, 20), active, 'already active worker is accepted')

const installingWorker = worker('installing')
const installing = registration({ installing: installingWorker })
const activation = waitForActiveServiceWorker(installing, 100)
installing.active = installingWorker
installing.installing = null
installingWorker.state = 'activated'
installingWorker.dispatchEvent(new Event('statechange'))
assert.equal(await activation, installing, 'waits for a newly installed worker to activate')

const pending = registration()
const update = waitForActiveServiceWorker(pending, 100)
const updatedWorker = worker('installing')
pending.installing = updatedWorker
pending.dispatchEvent(new Event('updatefound'))
pending.active = updatedWorker
pending.installing = null
updatedWorker.state = 'activated'
updatedWorker.dispatchEvent(new Event('statechange'))
assert.equal(await update, pending, 'observes a worker discovered after registration')

await assert.rejects(waitForActiveServiceWorker(registration(), 10), /Az értesítési szolgáltatás nem indult el/)

console.log('Food push service worker tests passed')
