import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import {
  ACCOUNTS_COLLECTION,
  getAccountPath,
} from '../../lib/firestorePaths'
import { ROLES } from '../../lib/roles'
import { buildAccountRecord } from './accountModels'
import { linkAccountToPersona as linkAccountToPersonaCallable } from './authService'

export async function ensureAccountDocument(user, preferredRole = ROLES.user) {
  const accountRef = doc(db, getAccountPath(user.uid))
  const accountSnapshot = await getDoc(accountRef)

  if (accountSnapshot.exists()) {
    return accountSnapshot.data()
  }

  if (preferredRole !== ROLES.user) {
    return null
  }

  const accountRecord = buildAccountRecord(user, ROLES.user)

  await setDoc(accountRef, accountRecord)

  return accountRecord
}

export function subscribeToAccount(uid, onNext, onError) {
  return onSnapshot(
    doc(db, getAccountPath(uid)),
    (snapshot) => {
      onNext(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null)
    },
    onError,
  )
}

export function subscribeToAccountsDirectory(onNext, onError) {
  return onSnapshot(
    query(collection(db, ACCOUNTS_COLLECTION), orderBy('createdAt', 'desc')),
    (snapshot) => {
      onNext(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    },
    onError,
  )
}

export async function linkRegisteredUserToPerson({
  eventId,
  personId,
  linkedAuthUid,
  linkedBy,
  displayName,
  team,
  attendeeType,
}) {
  await linkAccountToPersonaCallable({
    eventId,
    personId,
    linkedAuthUid: linkedAuthUid || null,
    linkedBy,
    displayName,
    team,
    attendeeType,
  })
}
