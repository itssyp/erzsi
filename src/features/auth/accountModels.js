import { serverTimestamp } from 'firebase/firestore'
import { ROLES } from '../../lib/roles'

export const ACCOUNT_STATUSES = {
  active: 'active',
  disabled: 'disabled',
}

/**
 * @typedef {object} AccountRecord
 * @property {string} uid
 * @property {string} email
 * @property {string} displayName
 * @property {'user' | 'staff' | 'admin'} role
 * @property {'active' | 'disabled'} status
 * @property {unknown} createdAt
 * @property {unknown} updatedAt
 */

/**
 * @typedef {object} AccountEventLinkRecord
 * @property {string} eventId
 * @property {string} personId
 * @property {string} linkedPersonaId
 * @property {string} linkedAuthUid
 * @property {string} linkedBy
 * @property {string} displayName
 * @property {string} team
 * @property {'organizer' | 'freshman'} attendeeType
 * @property {unknown} linkedAt
 * @property {unknown} updatedAt
 */

export function buildAccountRecord(user, role = ROLES.user) {
  const displayName = user.displayName?.trim() || user.email?.split('@')[0] || 'Camp user'

  return {
    uid: user.uid,
    email: user.email || '',
    displayName,
    role,
    status: ACCOUNT_STATUSES.active,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
}

export function buildAccountEventLinkRecord({
  eventId,
  personId,
  linkedAuthUid,
  linkedBy,
  displayName,
  team = '',
  attendeeType,
}) {
  return {
    eventId,
    personId,
    linkedPersonaId: personId,
    linkedAuthUid,
    linkedBy,
    displayName,
    team,
    attendeeType,
    linkedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
}

export function buildAccountEventLinkMetadataPatch({
  personId,
  displayName,
  team = '',
  attendeeType,
}) {
  return {
    personId,
    linkedPersonaId: personId,
    displayName,
    team,
    attendeeType,
    updatedAt: serverTimestamp(),
  }
}
