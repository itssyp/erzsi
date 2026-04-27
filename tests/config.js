// Shared configuration for all stress/load tests
// Uses a demo project so no Firebase credentials are required

export const PROJECT_ID = 'demo-erzsi-test'
export const FIRESTORE_HOST = '127.0.0.1'
export const FIRESTORE_PORT = 8080
export const FIRESTORE_EMULATOR_HOST = `${FIRESTORE_HOST}:${FIRESTORE_PORT}`

export const TEST_EVENT_ID = 'test-event-load-001'
export const STALE_BASKET_LOCK_MS = 45_000
