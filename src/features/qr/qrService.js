import { collection, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../../lib/firebase'
import { EVENT_SUBCOLLECTIONS, getEventCollectionPath } from '../../lib/firestorePaths'
import { normalizeQrCredentialRecord, QR_CREDENTIAL_STATUSES } from './qrModels'
import { QR_PUBLIC_BASE_URL, normalizeQrInput } from './qrLinks'

const generateQrCredentialsCallable = httpsCallable(functions, 'generateQrCredentials')
const importQrCredentialsCallable = httpsCallable(functions, 'importQrCredentials')
const deleteQrCredentialCallable = httpsCallable(functions, 'deleteQrCredential')
const assignQrCredentialToPersonaCallable = httpsCallable(functions, 'assignQrCredentialToPersona')
const revokeQrCredentialFromPersonaCallable = httpsCallable(functions, 'revokeQrCredentialFromPersona')
const resolveAssignedQrCredentialCallable = httpsCallable(functions, 'resolveAssignedQrCredential')
const selfAssignQrCredentialCallable = httpsCallable(functions, 'selfAssignQrCredential')

export { QR_CREDENTIAL_STATUSES }

export function subscribeToQrCredentials(eventId, onNext, onError) {
  return onSnapshot(
    collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.qrAssignments)),
    (snapshot) => {
      const items = snapshot.docs.map((item) => normalizeQrCredentialRecord(item.id, item.data()))
      items.sort((a, b) => {
        const aTime = a.createdAt?.toMillis?.() || a.updatedAt?.toMillis?.() || 0
        const bTime = b.createdAt?.toMillis?.() || b.updatedAt?.toMillis?.() || 0
        return bTime - aTime
      })
      onNext(items)
    },
    onError,
  )
}

export async function generateQrCredentials({ eventId, count }) {
  const result = await generateQrCredentialsCallable({
    eventId,
    count,
    appBaseUrl: QR_PUBLIC_BASE_URL,
  })

  return result.data
}

export async function importQrCredentials({ eventId, codes }) {
  const result = await importQrCredentialsCallable({
    eventId,
    codes,
  })

  return result.data
}

export async function deleteQrCredential({ eventId, qrInput }) {
  const normalizedQr = normalizeQrInput(qrInput)
  const result = await deleteQrCredentialCallable({
    eventId,
    qrInput: normalizedQr,
  })

  return result.data
}

export async function assignQrToPerson({
  eventId,
  personId,
  qrInput,
}) {
  const normalizedQr = normalizeQrInput(qrInput)
  const result = await assignQrCredentialToPersonaCallable({
    eventId,
    personId,
    qrInput: normalizedQr,
    appBaseUrl: QR_PUBLIC_BASE_URL,
  })

  return result.data
}

export async function revokeQrForPerson({ eventId, personId }) {
  const result = await revokeQrCredentialFromPersonaCallable({
    eventId,
    personId,
  })

  return result.data
}

export async function selfAssignQrCredential({ eventId, qrInput }) {
  const normalizedQr = normalizeQrInput(qrInput)
  const result = await selfAssignQrCredentialCallable({
    eventId,
    qrInput: normalizedQr,
    appBaseUrl: QR_PUBLIC_BASE_URL,
  })

  return result.data
}

export async function resolveAssignedQrToPerson({ eventId, qrInput }) {
  const normalizedQr = normalizeQrInput(qrInput)
  const result = await resolveAssignedQrCredentialCallable({
    eventId,
    qrInput: normalizedQr,
  })

  return result.data
}
