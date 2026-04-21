import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { getAccountEventLinkPath, getEventScopedPath, EVENT_SUBCOLLECTIONS } from '../../lib/firestorePaths'

export function subscribeToActiveEventLink(uid, eventId, onNext, onError) {
  return onSnapshot(
    doc(db, getAccountEventLinkPath(uid, eventId)),
    (snapshot) => {
      onNext(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null)
    },
    onError,
  )
}

export function subscribeToLinkedPerson(eventId, personId, onNext, onError) {
  return onSnapshot(
    doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.people, personId)),
    (snapshot) => {
      onNext(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null)
    },
    onError,
  )
}
