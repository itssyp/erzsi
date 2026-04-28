import {
  createUserWithEmailAndPassword,
  getIdTokenResult,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from 'firebase/auth'
import { doc, setDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, functions } from '../../lib/firebase'
import { getAccountPath } from '../../lib/firestorePaths'
import { ROLES } from '../../lib/roles'
import { buildAccountRecord } from './accountModels'

const bootstrapAdminSessionCallable = httpsCallable(functions, 'bootstrapAdminSession')
const createPrivilegedAccountCallable = httpsCallable(functions, 'createPrivilegedAccount')
const disablePrivilegedAccountCallable = httpsCallable(functions, 'disablePrivilegedAccount')
const setAccountRoleCallable = httpsCallable(functions, 'setAccountRole')
const linkAccountToPersonaCallable = httpsCallable(functions, 'linkAccountToPersona')

const ignorableBootstrapErrors = new Set([
  'functions/not-found',
  'functions/unavailable',
  'functions/internal',
])

export async function signInWithPassword({ email, password }) {
  return signInWithEmailAndPassword(auth, email.trim(), password)
}

export async function registerUser({ displayName, email, password, shibboleth }) {
  const credential = await createUserWithEmailAndPassword(auth, email.trim(), password)

  if (displayName?.trim()) {
    await updateProfile(credential.user, { displayName: displayName.trim() })
  }

  await setDoc(
    doc(db, getAccountPath(credential.user.uid)),
    buildAccountRecord(
      {
        ...credential.user,
        displayName: displayName?.trim() || credential.user.displayName,
      },
      ROLES.user,
      { shibboleth },
    ),
    { merge: true },
  )

  return credential
}

export async function signOutUser() {
  await signOut(auth)
}

export async function bootstrapPrivilegedSession() {
  try {
    const result = await bootstrapAdminSessionCallable()

    return result.data
  } catch (error) {
    if (ignorableBootstrapErrors.has(error.code)) {
      return null
    }

    throw error
  }
}

export async function getSessionClaims(user, forceRefresh = false) {
  const tokenResult = await getIdTokenResult(user, forceRefresh)

  return tokenResult.claims
}

export async function createPrivilegedAccount(payload) {
  const result = await createPrivilegedAccountCallable(payload)

  return result.data
}

export async function disablePrivilegedAccount(payload) {
  const result = await disablePrivilegedAccountCallable(payload)

  return result.data
}

export async function setAccountRole(payload) {
  const result = await setAccountRoleCallable(payload)

  return result.data
}

export async function linkAccountToPersona(payload) {
  const result = await linkAccountToPersonaCallable(payload)

  return result.data
}
