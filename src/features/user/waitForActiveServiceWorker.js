export function waitForActiveServiceWorker(registration, timeoutMs = 30000) {
  if (registration.active?.state === 'activated') return Promise.resolve(registration)

  return new Promise((resolve, reject) => {
    const observedWorkers = new Set()
    let timeoutId

    function cleanup() {
      clearTimeout(timeoutId)
      registration.removeEventListener('updatefound', check)
      observedWorkers.forEach((worker) => worker.removeEventListener('statechange', check))
    }

    function check() {
      if (registration.active?.state === 'activated') {
        cleanup()
        resolve(registration)
        return
      }

      for (const worker of [registration.installing, registration.waiting, registration.active]) {
        if (worker && !observedWorkers.has(worker)) {
          observedWorkers.add(worker)
          worker.addEventListener('statechange', check)
        }
      }
    }

    timeoutId = setTimeout(() => {
      cleanup()
      reject(new Error('Az értesítési szolgáltatás nem indult el. Frissítsd az oldalt, és próbáld újra.'))
    }, timeoutMs)
    registration.addEventListener('updatefound', check)
    check()
  })
}
