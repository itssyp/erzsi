import { serverTimestamp } from 'firebase/firestore'
import { normalizeCode, normalizeSearchText } from '../../lib/normalize'

export const EVENT_STATUSES = {
  draft: 'draft',
  active: 'active',
  closed: 'closed',
}

/**
 * @typedef {object} EventRecord
 * @property {string} name
 * @property {string} code
 * @property {string} normalizedName
 * @property {'draft' | 'active' | 'closed'} status
 * @property {string | null} startsOn
 * @property {string} createdBy
 * @property {string | null} updatedBy
 * @property {string | null} activatedBy
 * @property {unknown} createdAt
 * @property {unknown} updatedAt
 * @property {unknown | null} activatedAt
 * @property {unknown | null} closedAt
 */

/**
 * @typedef {object} RuntimeRecord
 * @property {string | null} activeEventId
 * @property {string | null} updatedBy
 * @property {unknown} updatedAt
 */

export function deriveEventCode(name, explicitCode) {
  const derivedCode = normalizeCode(explicitCode || name)

  return derivedCode || 'event'
}

export function buildEventRecord({ name, code, startsOn, createdBy, activateNow = false }) {
  return {
    name: name.trim(),
    code: deriveEventCode(name, code),
    normalizedName: normalizeSearchText(name),
    status: activateNow ? EVENT_STATUSES.active : EVENT_STATUSES.draft,
    startsOn: startsOn || null,
    createdBy,
    updatedBy: createdBy,
    activatedBy: activateNow ? createdBy : null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    activatedAt: activateNow ? serverTimestamp() : null,
    closedAt: null,
  }
}

export function buildEventActivationPatch({ actorUid }) {
  return {
    status: EVENT_STATUSES.active,
    updatedBy: actorUid,
    activatedBy: actorUid,
    updatedAt: serverTimestamp(),
    activatedAt: serverTimestamp(),
    closedAt: null,
  }
}

export function buildEventClosedPatch({ actorUid }) {
  return {
    status: EVENT_STATUSES.closed,
    updatedBy: actorUid,
    updatedAt: serverTimestamp(),
    closedAt: serverTimestamp(),
  }
}

export function buildRuntimeRecord({ activeEventId, actorUid }) {
  return {
    activeEventId,
    updatedBy: actorUid,
    updatedAt: serverTimestamp(),
  }
}

export function buildKitchenStatusPatch({ isClosed, actorUid }) {
  return {
    isKitchenClosed: isClosed,
    updatedBy: actorUid,
    updatedAt: serverTimestamp(),
  }
}

