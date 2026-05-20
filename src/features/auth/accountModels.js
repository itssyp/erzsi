import { serverTimestamp } from 'firebase/firestore'
import { ROLES } from '../../lib/roles'
import { normalizeShibboleth } from '../../lib/normalize'

export const ACCOUNT_STATUSES = {
  active: 'active',
  disabled: 'disabled',
}

/**
 * @typedef {object} AccountRecord
 * @property {string} uid
 * @property {string} email
 * @property {string} displayName
 * @property {string} shibboleth
 * @property {string} normalizedShibboleth
 * @property {'user' | 'staff' | 'pos_staff' | 'topup_staff' | 'admin'} role
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
 * @property {string} shibboleth
 * @property {unknown} linkedAt
 * @property {unknown} updatedAt
 */

export function buildAccountRecord(user, role = ROLES.user, metadata = {}) {
  const displayName = user.displayName?.trim() || user.email?.split('@')[0] || 'Camp user'

  return {
    uid: user.uid,
    email: user.email || '',
    displayName,
    shibboleth: `${metadata.shibboleth ?? ''}`.trim(),
    normalizedShibboleth: normalizeShibboleth(metadata.shibboleth),
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
  shibboleth = '',
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
    shibboleth,
    normalizedShibboleth: normalizeShibboleth(shibboleth),
    linkedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
}

export function buildAccountEventLinkMetadataPatch({
  personId,
  displayName,
  team = '',
  attendeeType,
  shibboleth = '',
}) {
  return {
    personId,
    linkedPersonaId: personId,
    displayName,
    team,
    attendeeType,
    shibboleth,
    normalizedShibboleth: normalizeShibboleth(shibboleth),
    updatedAt: serverTimestamp(),
  }
}
