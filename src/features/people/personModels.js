import { serverTimestamp } from 'firebase/firestore'
import { normalizeSearchText } from '../../lib/normalize'

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
}) {
  return {
    internalId,
    displayName: displayName.trim(),
    normalizedName: normalizeSearchText(displayName),
    team: team.trim(),
    attendeeType,
    linkedAuthUid: null,
    linkedAccountId: null,
    qrCodeId: null,
    assignedQrId: null,
    assignedQrLink: null,
    balance: 0,
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

export function buildPersonUpdatePatch({ displayName, team, attendeeType }) {
  return {
    displayName: displayName.trim(),
    normalizedName: normalizeSearchText(displayName),
    team: team.trim(),
    attendeeType,
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
