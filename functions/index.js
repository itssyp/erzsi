import { randomInt } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { setGlobalOptions } from 'firebase-functions/v2'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { defineString } from 'firebase-functions/params'

initializeApp()
setGlobalOptions({ region: 'europe-west1', maxInstances: 10, cors: true })

const adminAuth = getAuth()
const db = getFirestore()
const bootstrapAdminEmails = defineString('BOOTSTRAP_ADMIN_EMAILS')

const QR_CODE_MIN = 10000
const QR_CODE_MAX_EXCLUSIVE = 100000
const MAX_QR_GENERATION_BATCH = 250
const MAX_QR_INPUT_LENGTH = 512

const QR_STATUSES = {
  unassigned: 'unassigned',
  assigned: 'assigned',
  revoked: 'revoked',
}

const AUDIT_TYPES = {
  accountLink: 'accountLink',
  qrAssignment: 'qrAssignment',
  qrGeneration: 'qrGeneration',
  qrRevocation: 'qrRevocation',
  qrReset: 'qrReset',
}

function normalizeRole(role) {
  return role === 'admin' || role === 'staff' || role === 'user' ? role : 'user'
}

function parseEmailAllowlist() {
  return (bootstrapAdminEmails.value() || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
}

function ensureAuthenticated(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication is required.')
  }

  return request.auth
}

function ensureAdmin(request) {
  const authContext = ensureAuthenticated(request)

  if (authContext.token.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin privileges are required.')
  }

  return authContext
}

function ensureStaffLike(request) {
  const authContext = ensureAuthenticated(request)
  const role = authContext.token.role

  if (role !== 'admin' && role !== 'staff') {
    throw new HttpsError('permission-denied', 'Staff or admin privileges are required.')
  }

  return authContext
}

function normalizeEventId(rawValue) {
  const eventId = typeof rawValue === 'string' ? rawValue.trim() : ''

  if (!eventId) {
    throw new HttpsError('invalid-argument', 'eventId is required.')
  }

  return eventId
}

function normalizePersonId(rawValue) {
  const personId = typeof rawValue === 'string' ? rawValue.trim() : ''

  if (!personId) {
    throw new HttpsError('invalid-argument', 'personId is required.')
  }

  return personId
}

function sanitizeAppBaseUrl(rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : ''

  if (!value) {
    throw new HttpsError('invalid-argument', 'appBaseUrl is required.')
  }

  let parsedUrl

  try {
    parsedUrl = new URL(value)
  } catch {
    throw new HttpsError('invalid-argument', 'appBaseUrl must be a valid absolute URL.')
  }

  if (!/^https?:$/.test(parsedUrl.protocol)) {
    throw new HttpsError('invalid-argument', 'appBaseUrl must use http or https.')
  }

  return parsedUrl.origin
}

function buildQrCredentialLink(appBaseUrl, code) {
  return `${appBaseUrl}/qr/${code}`
}

function coerceCount(rawValue) {
  const count = Number.parseInt(`${rawValue ?? '1'}`, 10)

  if (!Number.isInteger(count) || count <= 0 || count > MAX_QR_GENERATION_BATCH) {
    throw new HttpsError(
      'invalid-argument',
      `count must be an integer between 1 and ${MAX_QR_GENERATION_BATCH}.`,
    )
  }

  return count
}

function normalizeScannedQrCode(rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : ''

  if (!value) {
    throw new HttpsError('invalid-argument', 'QR input is required.')
  }

  if (value.length > MAX_QR_INPUT_LENGTH) {
    throw new HttpsError('invalid-argument', 'QR input is too long.')
  }

  if (/^\d{5}$/.test(value)) {
    return value
  }

  try {
    const parsedUrl = new URL(value)
    const queryCandidate = parsedUrl.searchParams.get('code') || parsedUrl.searchParams.get('qr')

    if (queryCandidate && /^\d{5}$/.test(queryCandidate.trim())) {
      return queryCandidate.trim()
    }

    const pathMatch = parsedUrl.pathname.match(/\/qr\/(\d{5})\/?$/i)

    if (pathMatch?.[1]) {
      return pathMatch[1]
    }
  } catch {
    // Fall through to the generic validation error below.
  }

  throw new HttpsError('invalid-argument', 'QR input must be a 5-digit code or a supported QR link.')
}

function getAccountRef(uid) {
  return db.doc(`accounts/${uid}`)
}

function getEventPath(eventId) {
  return `events/${eventId}`
}

function getEventDocRef(eventId) {
  return db.doc(getEventPath(eventId))
}

function getPersonRef(eventId, personId) {
  return db.doc(`${getEventPath(eventId)}/people/${personId}`)
}

function getQrCredentialRef(eventId, qrCode) {
  return db.doc(`${getEventPath(eventId)}/qrAssignments/${qrCode}`)
}

function createAuditLogRef(eventId) {
  return db.collection(`${getEventPath(eventId)}/auditLogs`).doc()
}

function buildAuditLogRecord({
  type,
  actorUid,
  summary,
  targetType,
  targetId = null,
  personId = null,
  details = {},
}) {
  return {
    type,
    actorUid,
    summary,
    targetType,
    targetId,
    personId,
    details,
    createdAt: FieldValue.serverTimestamp(),
  }
}

function deriveAssignedPersonaId(record) {
  return record.assignedPersonaId || record.personId || null
}

function deriveAssignedAccountId(record) {
  return record.assignedAccountId || record.linkedAuthUid || null
}

function normalizeQrCredentialSnapshot(snapshot) {
  if (!snapshot.exists) {
    return null
  }

  const data = snapshot.data()
  const assignedPersonaId = deriveAssignedPersonaId(data)
  const assignedAccountId = deriveAssignedAccountId(data)
  const status = data.status || (assignedPersonaId ? QR_STATUSES.assigned : QR_STATUSES.unassigned)

  return {
    id: snapshot.id,
    code: data.code || snapshot.id,
    link: data.link || null,
    status,
    assignedPersonaId,
    assignedAccountId,
    createdAt: data.createdAt || null,
    assignedAt: data.assignedAt || null,
    revokedAt: data.revokedAt || null,
  }
}

function buildQrCredentialCreateRecord({ code, link, actorUid }) {
  return {
    qrId: code,
    code,
    link,
    status: QR_STATUSES.unassigned,
    assignedPersonaId: null,
    personId: null,
    assignedAccountId: null,
    linkedAuthUid: null,
    createdBy: actorUid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    assignedAt: null,
    revokedAt: null,
    revokedBy: null,
  }
}

function buildAssignedQrCredentialPatch({
  code,
  link,
  personId,
  linkedAccountId,
  actorUid,
  assignedAt,
}) {
  return {
    qrId: code,
    code,
    link,
    status: QR_STATUSES.assigned,
    assignedPersonaId: personId,
    personId,
    assignedAccountId: linkedAccountId || null,
    linkedAuthUid: linkedAccountId || null,
    assignedBy: actorUid,
    assignedAt: assignedAt || FieldValue.serverTimestamp(),
    revokedAt: null,
    revokedBy: null,
    updatedAt: FieldValue.serverTimestamp(),
  }
}

function buildRevokedQrCredentialPatch({ actorUid }) {
  return {
    status: QR_STATUSES.revoked,
    revokedAt: FieldValue.serverTimestamp(),
    revokedBy: actorUid,
    updatedAt: FieldValue.serverTimestamp(),
  }
}

function buildPersonQrAssignmentPatch({ qrCode, qrLink }) {
  return {
    assignedQrId: qrCode,
    qrCodeId: qrCode,
    assignedQrLink: qrLink,
    updatedAt: FieldValue.serverTimestamp(),
  }
}

function buildPersonQrClearPatch() {
  return {
    assignedQrId: null,
    qrCodeId: null,
    assignedQrLink: null,
    updatedAt: FieldValue.serverTimestamp(),
  }
}

function buildPersonLinkPatch({ linkedAuthUid }) {
  return {
    linkedAuthUid: linkedAuthUid || null,
    linkedAccountId: linkedAuthUid || null,
    updatedAt: FieldValue.serverTimestamp(),
  }
}

async function upsertAccountDocument({
  uid,
  email,
  displayName,
  role,
  status = 'active',
  createdBy = null,
}) {
  const accountRef = getAccountRef(uid)
  const snapshot = await accountRef.get()
  const existingData = snapshot.exists ? snapshot.data() : null

  await accountRef.set(
    {
      uid,
      email: email || '',
      displayName: displayName || email || 'Camp account',
      role,
      status,
      createdBy,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: existingData?.createdAt || FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
}

export const bootstrapAdminSession = onCall(async (request) => {
  const authContext = ensureAuthenticated(request)
  const email = authContext.token.email?.trim().toLowerCase()

  if (!email) {
    return { role: normalizeRole(authContext.token.role), elevated: false }
  }

  const allowlist = parseEmailAllowlist()

  if (!allowlist.includes(email)) {
    return { role: normalizeRole(authContext.token.role), elevated: false }
  }

  const userRecord = await adminAuth.getUser(authContext.uid)

  await adminAuth.setCustomUserClaims(authContext.uid, {
    ...(userRecord.customClaims || {}),
    role: 'admin',
  })

  await upsertAccountDocument({
    uid: authContext.uid,
    email: userRecord.email,
    displayName: userRecord.displayName,
    role: 'admin',
  })

  return { role: 'admin', elevated: true }
})

export const createPrivilegedAccount = onCall(async (request) => {
  const authContext = ensureAdmin(request)
  const email = request.data?.email?.trim().toLowerCase()
  const password = request.data?.password
  const displayName = request.data?.displayName?.trim() || null
  const role = normalizeRole(request.data?.role)

  if (!email || !password) {
    throw new HttpsError('invalid-argument', 'Email and password are required.')
  }

  if (role === 'user') {
    throw new HttpsError('invalid-argument', 'Use this function only for staff or admin accounts.')
  }

  const userRecord = await adminAuth.createUser({
    email,
    password,
    displayName,
    disabled: false,
  })

  await adminAuth.setCustomUserClaims(userRecord.uid, { role })
  await upsertAccountDocument({
    uid: userRecord.uid,
    email: userRecord.email,
    displayName: userRecord.displayName,
    role,
    createdBy: authContext.uid,
  })

  return {
    uid: userRecord.uid,
    role,
    email: userRecord.email,
  }
})

export const setAccountRole = onCall(async (request) => {
  const authContext = ensureAdmin(request)
  const targetUid = request.data?.uid
  const role = normalizeRole(request.data?.role)

  if (!targetUid) {
    throw new HttpsError('invalid-argument', 'uid is required.')
  }

  const userRecord = await adminAuth.getUser(targetUid)

  await adminAuth.setCustomUserClaims(targetUid, {
    ...(userRecord.customClaims || {}),
    role,
  })

  await upsertAccountDocument({
    uid: userRecord.uid,
    email: userRecord.email,
    displayName: userRecord.displayName,
    role,
    createdBy: authContext.uid,
  })

  return {
    uid: targetUid,
    role,
  }
})

export const disablePrivilegedAccount = onCall(async (request) => {
  const authContext = ensureAdmin(request)
  const targetUid = request.data?.uid

  if (!targetUid) {
    throw new HttpsError('invalid-argument', 'uid is required.')
  }

  if (targetUid === authContext.uid) {
    throw new HttpsError('failed-precondition', 'Admins cannot disable their own account from this function.')
  }

  await adminAuth.updateUser(targetUid, { disabled: true })
  await getAccountRef(targetUid).set(
    {
      status: 'disabled',
      disabledBy: authContext.uid,
      disabledAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )

  return {
    uid: targetUid,
    disabled: true,
  }
})

export const generateQrCredentials = onCall(async (request) => {
  const authContext = ensureAdmin(request)
  const eventId = normalizeEventId(request.data?.eventId)
  const count = coerceCount(request.data?.count)
  const appBaseUrl = sanitizeAppBaseUrl(request.data?.appBaseUrl)

  const eventSnapshot = await getEventDocRef(eventId).get()

  if (!eventSnapshot.exists) {
    throw new HttpsError('not-found', 'Event was not found.')
  }

  const createdCredentials = []
  const reservedCodes = new Set()

  while (createdCredentials.length < count) {
    let created = false

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = `${randomInt(QR_CODE_MIN, QR_CODE_MAX_EXCLUSIVE)}`

      if (reservedCodes.has(code)) {
        continue
      }

      const credentialRef = getQrCredentialRef(eventId, code)
      const link = buildQrCredentialLink(appBaseUrl, code)

      try {
        await credentialRef.create(
          buildQrCredentialCreateRecord({
            code,
            link,
            actorUid: authContext.uid,
          }),
        )

        reservedCodes.add(code)
        createdCredentials.push({ id: code, code, link, status: QR_STATUSES.unassigned })
        created = true
        break
      } catch (error) {
        if (error?.code === 6 || `${error?.message || ''}`.toLowerCase().includes('already exists')) {
          continue
        }

        throw error
      }
    }

    if (!created) {
      throw new HttpsError(
        'resource-exhausted',
        'Unable to reserve enough unique 5-digit QR codes. Retry the batch or revoke unused credentials.',
      )
    }
  }

  const auditLogRef = createAuditLogRef(eventId)

  await auditLogRef.set(
    buildAuditLogRecord({
      type: AUDIT_TYPES.qrGeneration,
      actorUid: authContext.uid,
      summary: `Generated ${createdCredentials.length} QR credential${createdCredentials.length === 1 ? '' : 's'}`,
      targetType: 'qrCredentialBatch',
      details: {
        count: createdCredentials.length,
        codes: createdCredentials.map((item) => item.code),
      },
    }),
  )

  return {
    count: createdCredentials.length,
    credentials: createdCredentials,
  }
})

export const assignQrCredentialToPersona = onCall(async (request) => {
  const authContext = ensureAdmin(request)
  const eventId = normalizeEventId(request.data?.eventId)
  const personId = normalizePersonId(request.data?.personId)
  const qrCode = normalizeScannedQrCode(request.data?.qrInput)
  const appBaseUrl = typeof request.data?.appBaseUrl === 'string' && request.data.appBaseUrl.trim()
    ? sanitizeAppBaseUrl(request.data.appBaseUrl)
    : null

  await db.runTransaction(async (transaction) => {
    const personRef = getPersonRef(eventId, personId)
    const credentialRef = getQrCredentialRef(eventId, qrCode)
    const auditLogRef = createAuditLogRef(eventId)

    const [personSnapshot, credentialSnapshot] = await Promise.all([
      transaction.get(personRef),
      transaction.get(credentialRef),
    ])

    if (!personSnapshot.exists) {
      throw new HttpsError('not-found', 'Persona was not found.')
    }

    if (!credentialSnapshot.exists) {
      throw new HttpsError('not-found', 'QR credential was not found.')
    }

    const person = personSnapshot.data()
    const credential = normalizeQrCredentialSnapshot(credentialSnapshot)

    if (person.recordStatus === 'deleted') {
      throw new HttpsError('failed-precondition', 'Deleted personas cannot receive QR credentials.')
    }

    if (credential.status === QR_STATUSES.revoked) {
      throw new HttpsError('failed-precondition', 'This QR credential has already been revoked.')
    }

    if (credential.status === QR_STATUSES.assigned && credential.assignedPersonaId !== personId) {
      throw new HttpsError('failed-precondition', 'This QR credential is already assigned to another persona.')
    }

    const currentQrCode = person.assignedQrId || person.qrCodeId || null

    if (currentQrCode && currentQrCode !== qrCode) {
      const previousCredentialRef = getQrCredentialRef(eventId, currentQrCode)
      const previousCredentialSnapshot = await transaction.get(previousCredentialRef)

      if (previousCredentialSnapshot.exists) {
        transaction.set(
          previousCredentialRef,
          buildRevokedQrCredentialPatch({ actorUid: authContext.uid }),
          { merge: true },
        )
      }
    }

    const nextLink = credential.link || (appBaseUrl ? buildQrCredentialLink(appBaseUrl, qrCode) : '')

    if (!nextLink) {
      throw new HttpsError('failed-precondition', 'QR credential link could not be determined for this assignment.')
    }
    const linkedAccountId = person.linkedAccountId || person.linkedAuthUid || null

    transaction.set(
      credentialRef,
      buildAssignedQrCredentialPatch({
        code: qrCode,
        link: nextLink,
        personId,
        linkedAccountId,
        actorUid: authContext.uid,
        assignedAt: credential.assignedAt,
      }),
      { merge: true },
    )
    transaction.set(personRef, buildPersonQrAssignmentPatch({ qrCode, qrLink: nextLink }), { merge: true })
    transaction.set(
      auditLogRef,
      buildAuditLogRecord({
        type: AUDIT_TYPES.qrAssignment,
        actorUid: authContext.uid,
        summary: `Assigned QR ${qrCode} to persona ${person.displayName || personId}`,
        targetType: 'person',
        targetId: personId,
        personId,
        details: {
          qrCode,
          replacedQrCode: currentQrCode && currentQrCode !== qrCode ? currentQrCode : null,
        },
      }),
    )
  })

  const credentialSnapshot = await getQrCredentialRef(eventId, qrCode).get()

  return {
    credential: normalizeQrCredentialSnapshot(credentialSnapshot),
    personId,
  }
})

export const revokeQrCredentialFromPersona = onCall(async (request) => {
  const authContext = ensureAdmin(request)
  const eventId = normalizeEventId(request.data?.eventId)
  const personId = normalizePersonId(request.data?.personId)

  await db.runTransaction(async (transaction) => {
    const personRef = getPersonRef(eventId, personId)
    const auditLogRef = createAuditLogRef(eventId)
    const personSnapshot = await transaction.get(personRef)

    if (!personSnapshot.exists) {
      throw new HttpsError('not-found', 'Persona was not found.')
    }

    const person = personSnapshot.data()
    const currentQrCode = person.assignedQrId || person.qrCodeId || null

    if (!currentQrCode) {
      return
    }

    const credentialRef = getQrCredentialRef(eventId, currentQrCode)
    const credentialSnapshot = await transaction.get(credentialRef)

    if (credentialSnapshot.exists) {
      transaction.set(
        credentialRef,
        buildRevokedQrCredentialPatch({ actorUid: authContext.uid }),
        { merge: true },
      )
    }

    transaction.set(personRef, buildPersonQrClearPatch(), { merge: true })
    transaction.set(
      auditLogRef,
      buildAuditLogRecord({
        type: AUDIT_TYPES.qrRevocation,
        actorUid: authContext.uid,
        summary: `Revoked QR ${currentQrCode} from persona ${person.displayName || personId}`,
        targetType: 'person',
        targetId: personId,
        personId,
        details: {
          previousQrCode: currentQrCode,
        },
      }),
    )
  })

  return {
    revoked: true,
    personId,
  }
})

export const resolveAssignedQrCredential = onCall(async (request) => {
  ensureStaffLike(request)

  const eventId = normalizeEventId(request.data?.eventId)
  const qrCode = normalizeScannedQrCode(request.data?.qrInput)
  const credentialSnapshot = await getQrCredentialRef(eventId, qrCode).get()
  const credential = normalizeQrCredentialSnapshot(credentialSnapshot)

  if (!credential) {
    throw new HttpsError('not-found', 'QR credential was not found in the active event.')
  }

  if (credential.status === QR_STATUSES.revoked) {
    throw new HttpsError('failed-precondition', 'This QR credential has been revoked.')
  }

  if (credential.status !== QR_STATUSES.assigned || !credential.assignedPersonaId) {
    throw new HttpsError('failed-precondition', 'This QR credential is not assigned to a persona yet.')
  }

  const personSnapshot = await getPersonRef(eventId, credential.assignedPersonaId).get()

  if (!personSnapshot.exists) {
    throw new HttpsError('not-found', 'The persona linked to this QR credential was not found.')
  }

  const person = { id: personSnapshot.id, ...personSnapshot.data() }

  if (person.recordStatus === 'deleted') {
    throw new HttpsError('failed-precondition', 'Deleted personas cannot be resolved from QR.')
  }

  return {
    credential,
    person,
  }
})

export const linkAccountToPersona = onCall(async (request) => {
  const authContext = ensureAdmin(request)
  const eventId = normalizeEventId(request.data?.eventId)
  const personId = normalizePersonId(request.data?.personId)
  const linkedAuthUid = typeof request.data?.linkedAuthUid === 'string' && request.data.linkedAuthUid.trim()
    ? request.data.linkedAuthUid.trim()
    : null

  const personRef = getPersonRef(eventId, personId)
  const targetEventLinkRef = linkedAuthUid
    ? db.doc(`accounts/${linkedAuthUid}/eventLinks/${eventId}`)
    : null

  await db.runTransaction(async (transaction) => {
    const personSnapshot = await transaction.get(personRef)

    if (!personSnapshot.exists) {
      throw new HttpsError('not-found', 'Persona was not found.')
    }

    const person = personSnapshot.data()

    if (person.linkedAuthUid && person.linkedAuthUid !== linkedAuthUid) {
      transaction.delete(db.doc(`accounts/${person.linkedAuthUid}/eventLinks/${eventId}`))
    }

    if (linkedAuthUid && targetEventLinkRef) {
      const existingLinkSnapshot = await transaction.get(targetEventLinkRef)

      if (existingLinkSnapshot.exists && existingLinkSnapshot.data().personId !== personId) {
        transaction.set(
          getPersonRef(eventId, existingLinkSnapshot.data().personId),
          buildPersonLinkPatch({ linkedAuthUid: null }),
          { merge: true },
        )
      }

      transaction.set(
        targetEventLinkRef,
        {
          eventId,
          personId,
          linkedPersonaId: personId,
          linkedAuthUid,
          linkedBy: authContext.uid,
          displayName: person.displayName || '',
          team: person.team || '',
          attendeeType: person.attendeeType || null,
          linkedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
      )
    }

    if (!linkedAuthUid && person.linkedAuthUid) {
      transaction.delete(db.doc(`accounts/${person.linkedAuthUid}/eventLinks/${eventId}`))
    }

    transaction.set(personRef, buildPersonLinkPatch({ linkedAuthUid }), { merge: true })

    if (person.assignedQrId || person.qrCodeId) {
      const qrCode = person.assignedQrId || person.qrCodeId
      transaction.set(
        getQrCredentialRef(eventId, qrCode),
        {
          assignedAccountId: linkedAuthUid || null,
          linkedAuthUid: linkedAuthUid || null,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
    }

    transaction.set(
      createAuditLogRef(eventId),
      buildAuditLogRecord({
        type: AUDIT_TYPES.accountLink,
        actorUid: authContext.uid,
        summary: linkedAuthUid
          ? `Linked account ${linkedAuthUid} to persona ${person.displayName || personId}`
          : `Removed account link from persona ${person.displayName || personId}`,
        targetType: 'person',
        targetId: personId,
        personId,
        details: {
          linkedAuthUid,
        },
      }),
    )
  })

  return {
    personId,
    linkedAuthUid,
  }
})
