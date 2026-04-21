import { serverTimestamp } from 'firebase/firestore'

export const QR_CREDENTIAL_STATUSES = {
  unassigned: 'unassigned',
  assigned: 'assigned',
  revoked: 'revoked',
}

/**
 * @typedef {object} QrCredentialRecord
 * @property {string} qrId
 * @property {string} code
 * @property {string} link
 * @property {'unassigned' | 'assigned' | 'revoked'} status
 * @property {string | null} assignedPersonaId
 * @property {string | null} assignedAccountId
 * @property {string | null} assignedBy
 * @property {unknown} createdAt
 * @property {unknown | null} assignedAt
 * @property {unknown | null} revokedAt
 * @property {unknown} updatedAt
 */

export function normalizeQrCredentialRecord(id, data) {
  const assignedPersonaId = data.assignedPersonaId || data.personId || null
  const assignedAccountId = data.assignedAccountId || data.linkedAuthUid || null
  const status = data.status || (assignedPersonaId ? QR_CREDENTIAL_STATUSES.assigned : QR_CREDENTIAL_STATUSES.unassigned)

  return {
    id,
    qrId: data.qrId || id,
    code: data.code || id,
    link: data.link || '',
    status,
    assignedPersonaId,
    assignedAccountId,
    assignedBy: data.assignedBy || null,
    createdAt: data.createdAt || null,
    assignedAt: data.assignedAt || null,
    revokedAt: data.revokedAt || null,
    updatedAt: data.updatedAt || null,
  }
}

export function buildQrCredentialCreateRecord({ code, link, actorUid }) {
  return {
    qrId: code,
    code,
    link,
    status: QR_CREDENTIAL_STATUSES.unassigned,
    assignedPersonaId: null,
    personId: null,
    assignedAccountId: null,
    linkedAuthUid: null,
    createdBy: actorUid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    assignedAt: null,
    revokedAt: null,
    revokedBy: null,
  }
}
