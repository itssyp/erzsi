import { serverTimestamp } from 'firebase/firestore'
import { normalizeSearchText, normalizeShibboleth } from '../../lib/normalize'

export const ATTENDEE_TYPES = {
  organizer: 'organizer',
  freshman: 'freshman',
}

export const PERSON_RECORD_STATUSES = {
  active: 'active',
  deleted: 'deleted',
}

/**
 * @typedef {object} PersonRecord
 * @property {string} internalId
 * @property {string} displayName
 * @property {string} normalizedName
 * @property {string} team
 * @property {'organizer' | 'freshman'} attendeeType
 * @property {string} shibboleth
 * @property {string} normalizedShibboleth
 * @property {string | null} linkedAuthUid
 * @property {string | null} linkedAccountId
 * @property {string | null} qrCodeId
 * @property {string | null} assignedQrId
 * @property {string | null} assignedQrLink
 * @property {number} balance
 * @property {'active' | 'deleted'} recordStatus
 * @property {unknown} createdAt
 * @property {unknown} updatedAt
 */

export function buildPersonRecord({
  internalId,
  displayName,
  team = '',
  attendeeType,
  shibboleth = '',
  balance = 0,
}) {
  return {
    internalId,
    displayName: displayName.trim(),
    normalizedName: normalizeSearchText(displayName),
    team: team.trim(),
    attendeeType,
    shibboleth: shibboleth.trim(),
    normalizedShibboleth: normalizeShibboleth(shibboleth),
    linkedAuthUid: null,
    linkedAccountId: null,
    qrCodeId: null,
    assignedQrId: null,
    assignedQrLink: null,
    balance,
    recordStatus: PERSON_RECORD_STATUSES.active,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
}

export function buildPersonLinkPatch({ linkedAuthUid }) {
  return {
    linkedAuthUid,
    linkedAccountId: linkedAuthUid || null,
    updatedAt: serverTimestamp(),
  }
}

export function buildPersonQrPatch({ qrCodeId, qrLink = null }) {
  return {
    qrCodeId: qrCodeId || null,
    assignedQrId: qrCodeId || null,
    assignedQrLink: qrLink || null,
    updatedAt: serverTimestamp(),
  }
}

export function buildPersonUpdatePatch({ displayName, team, attendeeType, shibboleth = '' }) {
  return {
    displayName: displayName.trim(),
    normalizedName: normalizeSearchText(displayName),
    team: team.trim(),
    attendeeType,
    shibboleth: shibboleth.trim(),
    normalizedShibboleth: normalizeShibboleth(shibboleth),
    updatedAt: serverTimestamp(),
  }
}

export function buildPersonDeletePatch({ actorUid }) {
  return {
    recordStatus: PERSON_RECORD_STATUSES.deleted,
    deletedAt: serverTimestamp(),
    deletedBy: actorUid,
    linkedAuthUid: null,
    linkedAccountId: null,
    qrCodeId: null,
    assignedQrId: null,
    assignedQrLink: null,
    updatedAt: serverTimestamp(),
  }
}

export function buildPersonRestorePatch() {
  return {
    recordStatus: PERSON_RECORD_STATUSES.active,
    deletedAt: null,
    deletedBy: null,
    updatedAt: serverTimestamp(),
  }
}

/**
 * Returns the preferred public identifier for a person.
 * Priority: QR ID > Shibboleth > Internal ID
 * @param {PersonRecord} person
 * @returns {string}
 */
export function getPersonDisplayId(person) {
  if (!person) return ''
  return person.assignedQrId || person.qrCodeId || person.shibboleth || person.internalId || ''
}
