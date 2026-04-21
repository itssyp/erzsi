import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { EVENT_SUBCOLLECTIONS, getEventCollectionPath } from '../../lib/firestorePaths'

export function subscribeLedgerEntriesForEvent(eventId, onNext, onError, options = {}) {
  const constraints = [orderBy('createdAt', 'desc')]

  if (options.limitCount) {
    constraints.push(limit(options.limitCount))
  }

  return onSnapshot(
    query(
      collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.ledgerEntries)),
      ...constraints,
    ),
    (snapshot) => {
      onNext(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    },
    onError,
  )
}
