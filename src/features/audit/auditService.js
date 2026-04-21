import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { EVENT_SUBCOLLECTIONS, getEventCollectionPath } from '../../lib/firestorePaths'
import { buildAuditLogRecord } from './auditModels'

export function createAuditLogWrite({ eventId, ...payload }) {
  const auditLogRef = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.auditLogs)))

  return {
    ref: auditLogRef,
    data: buildAuditLogRecord(payload),
  }
}

export async function writeAuditLog({ eventId, ...payload }) {
  const { ref, data } = createAuditLogWrite({ eventId, ...payload })

  await setDoc(ref, data)
}

export function subscribeToAuditLogs(eventId, onNext, onError, options = {}) {
  const constraints = [orderBy('createdAt', 'desc')]

  if (options.limitCount) {
    constraints.push(limit(options.limitCount))
  }

  return onSnapshot(
    query(
      collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.auditLogs)),
      ...constraints,
    ),
    (snapshot) => {
      onNext(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    },
    onError,
  )
}
