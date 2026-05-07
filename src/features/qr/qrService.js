import { collection, onSnapshot, orderBy, query } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../../lib/firebase'
import { EVENT_SUBCOLLECTIONS, getEventCollectionPath } from '../../lib/firestorePaths'
import { normalizeQrCredentialRecord, QR_CREDENTIAL_STATUSES } from './qrModels'
import { normalizeQrInput } from './qrLinks'

const generateQrCredentialsCallable = httpsCallable(functions, 'generateQrCredentials')
const assignQrCredentialToPersonaCallable = httpsCallable(functions, 'assignQrCredentialToPersona')
const revokeQrCredentialFromPersonaCallable = httpsCallable(functions, 'revokeQrCredentialFromPersona')
const resolveAssignedQrCredentialCallable = httpsCallable(functions, 'resolveAssignedQrCredential')
const selfAssignQrCredentialCallable = httpsCallable(functions, 'selfAssignQrCredential')

export { QR_CREDENTIAL_STATUSES }

export function subscribeToQrCredentials(eventId, onNext, onError) {
  return onSnapshot(
    query(
      collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.qrAssignments)),
      orderBy('createdAt', 'desc'),
    ),
    (snapshot) => {
      onNext(snapshot.docs.map((item) => normalizeQrCredentialRecord(item.id, item.data())))
    },
    onError,
  )
}

export async function generateQrCredentials({ eventId, count, appBaseUrl }) {
  const result = await generateQrCredentialsCallable({
    eventId,
    count,
    appBaseUrl,
  })

  return result.data
}

export async function assignQrToPerson({
  eventId,
  personId,
  qrInput,
  appBaseUrl,
}) {
  const normalizedQr = normalizeQrInput(qrInput)
  const result = await assignQrCredentialToPersonaCallable({
    eventId,
    personId,
    qrInput: normalizedQr,
    appBaseUrl,
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
    appBaseUrl: window.location.origin,
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
