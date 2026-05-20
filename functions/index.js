import { randomInt } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { setGlobalOptions } from 'firebase-functions/v2'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { defineString } from 'firebase-functions/params'

initializeApp()

const callableCorsOrigins = [
  'https://kasszaserzsi.hu',
  'https://www.kasszaserzsi.hu',
  'https://staging.kasszaserzsi.hu',
  'http://localhost:3000',
  'http://localhost:5173',
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
]

setGlobalOptions({ region: 'europe-west1', maxInstances: 10, cors: callableCorsOrigins })

const adminAuth = getAuth()
const db = getFirestore()
const bootstrapAdminEmails = defineString('BOOTSTRAP_ADMIN_EMAILS')
const callableOptions = { cors: callableCorsOrigins }

const QR_CODE_LENGTH = 4
const QR_CODE_MIN = 1000
const QR_CODE_MAX_EXCLUSIVE = 10000
const QR_PUBLIC_BASE_URL = 'https://kasszaserzsi.hu'
const MAX_QR_GENERATION_BATCH = 250
const MAX_QR_INPUT_LENGTH = 512
const MAX_QR_IMPORT_BATCH = 1000

const QR_STATUSES = {
  unassigned: 'unassigned',
  assigned: 'assigned',
  revoked: 'revoked',
}

const AUDIT_TYPES = {
  accountLink: 'accountLink',
  accountSelfJoin: 'accountSelfJoin',
  qrAssignment: 'qrAssignment',
  qrGeneration: 'qrGeneration',
  qrRevocation: 'qrRevocation',
  qrReset: 'qrReset',
  eventChange: 'eventChange',
  topup: 'topup',
}

const LEDGER_ENTRY_TYPES = {
  topup: 'topup',
}

const PERSON_RECORD_STATUSES = {
  deleted: 'deleted',
}

const ROLES = {
  admin: 'admin',
  staff: 'staff',
  posStaff: 'pos_staff',
  topupStaff: 'topup_staff',
  user: 'user',
}

const validRoles = new Set(Object.values(ROLES))

function normalizeRole(role) {
  return validRoles.has(role) ? role : ROLES.user
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

  if (authContext.token.role !== ROLES.admin) {
    throw new HttpsError('permission-denied', 'Admin privileges are required.')
  }

  return authContext
}

function ensureStaffLike(request) {
  const authContext = ensureAuthenticated(request)
  const role = authContext.token.role

  if (role !== ROLES.admin && role !== ROLES.staff && role !== ROLES.posStaff) {
    throw new HttpsError('permission-denied', 'Staff or admin privileges are required.')
  }

  return authContext
}

function ensureTopupLike(request) {
  const authContext = ensureAuthenticated(request)
  const role = authContext.token.role

  if (role !== ROLES.admin && role !== ROLES.topupStaff) {
    throw new HttpsError('permission-denied', 'Top-up privileges are required.')
  }

  return authContext
}

function parsePositiveHufAmount(rawValue) {
  const amount = Number.parseInt(`${rawValue ?? ''}`.trim(), 10)

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new HttpsError('invalid-argument', 'amount must be a positive integer HUF value.')
  }

  return amount
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

function normalizeShibboleth(rawValue) {
  const shibboleth = typeof rawValue === 'string' ? rawValue.trim() : ''

  if (!shibboleth) {
    throw new HttpsError('invalid-argument', 'Shibboleth is required.')
  }

  return shibboleth
}

function normalizeShibbolethKey(rawValue) {
  return `${rawValue ?? ''}`
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function buildQrCredentialLink(code) {
  return `${QR_PUBLIC_BASE_URL}/qr/${code}`
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

  const qrCodePattern = new RegExp(`^\\d{${QR_CODE_LENGTH}}$`)

  if (qrCodePattern.test(value)) {
    return value
  }

  const embeddedQrPathMatch = value.match(new RegExp(`/qr/(\\d{${QR_CODE_LENGTH}})(?:[/?#\\s]|$)`, 'i'))

  if (embeddedQrPathMatch?.[1]) {
    return embeddedQrPathMatch[1]
  }

  try {
    const parsedUrl = new URL(value)
    const queryCandidate = parsedUrl.searchParams.get('code') || parsedUrl.searchParams.get('qr')

    if (queryCandidate && qrCodePattern.test(queryCandidate.trim())) {
      return queryCandidate.trim()
    }

    const pathMatch = parsedUrl.pathname.match(new RegExp(`/qr/(\\d{${QR_CODE_LENGTH}})/?$`, 'i'))

    if (pathMatch?.[1]) {
      return pathMatch[1]
    }
  } catch {
    // Fall through to the generic validation error below.
  }

  throw new HttpsError('invalid-argument', `QR input must be a ${QR_CODE_LENGTH}-digit code or a supported QR link.`)
}

function normalizeQrCredentialInputs(rawValue) {
  const rawItems = Array.isArray(rawValue)
    ? rawValue
    : `${rawValue ?? ''}`.split(/[\s,;]+/g)
  const codes = []
  const seen = new Set()

  rawItems.forEach((item) => {
    const value = `${item ?? ''}`.trim()
    if (!value) return

    const code = normalizeScannedQrCode(value)

    if (!seen.has(code)) {
      seen.add(code)
      codes.push(code)
    }
  })

  if (!codes.length) {
    throw new HttpsError('invalid-argument', 'At least one QR code or QR link is required.')
  }

  if (codes.length > MAX_QR_IMPORT_BATCH) {
    throw new HttpsError('invalid-argument', `At most ${MAX_QR_IMPORT_BATCH} QR codes can be imported at once.`)
  }

  return codes
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

function getCarryoverBalanceRef(normalizedShibboleth) {
  return db.doc(`carryoverBalances/${normalizedShibboleth}`)
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

function buildLedgerEntryRecord({
  type,
  actorUid,
  personId,
  amount,
  balanceBefore,
  balanceAfter,
  reason = '',
}) {
  return {
    type,
    actorUid,
    personId,
    amount,
    balanceBefore,
    balanceAfter,
    currency: 'HUF',
    reason,
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
    role: ROLES.admin,
  })

  await upsertAccountDocument({
    uid: authContext.uid,
    email: userRecord.email,
    displayName: userRecord.displayName,
    role: ROLES.admin,
  })

  return { role: ROLES.admin, elevated: true }
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

  if (role === ROLES.user) {
    throw new HttpsError('invalid-argument', 'Use this function only for privileged staff or admin accounts.')
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

export const topUpPersonBalance = onCall(callableOptions, async (request) => {
  const authContext = ensureTopupLike(request)
  const eventId = normalizeEventId(request.data?.eventId)
  const personId = normalizePersonId(request.data?.personId)
  const amount = parsePositiveHufAmount(request.data?.amount)
  const personRef = getPersonRef(eventId, personId)
  const ledgerRef = db.collection(`${getEventPath(eventId)}/ledgerEntries`).doc()
  const auditRef = createAuditLogRef(eventId)

  await db.runTransaction(async (transaction) => {
    const personSnapshot = await transaction.get(personRef)

    if (!personSnapshot.exists) {
      throw new HttpsError('not-found', 'Person record was not found.')
    }

    const person = personSnapshot.data()

    if (person.recordStatus === PERSON_RECORD_STATUSES.deleted) {
      throw new HttpsError('failed-precondition', 'Deleted person records cannot receive top-ups.')
    }

    const balanceBefore = Number.isFinite(person.balance) ? person.balance : 0
    const balanceAfter = balanceBefore + amount

    transaction.set(
      personRef,
      {
        balance: balanceAfter,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    transaction.set(
      ledgerRef,
      buildLedgerEntryRecord({
        type: LEDGER_ENTRY_TYPES.topup,
        actorUid: authContext.uid,
        personId,
        amount,
        balanceBefore,
        balanceAfter,
        reason: '',
      }),
    )
    transaction.set(
      auditRef,
      buildAuditLogRecord({
        type: AUDIT_TYPES.topup,
        actorUid: authContext.uid,
        summary: `Top-up applied to person ${personId}`,
        targetType: 'personBalance',
        targetId: personId,
        personId,
        details: {
          amount,
          balanceBefore,
          balanceAfter,
          reason: null,
        },
      }),
    )
  })

  return { personId, amount }
})

export const generateQrCredentials = onCall(async (request) => {
  const authContext = ensureAdmin(request)
  const eventId = normalizeEventId(request.data?.eventId)
  const count = coerceCount(request.data?.count)

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
      const link = buildQrCredentialLink(code)

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
        `Unable to reserve enough unique ${QR_CODE_LENGTH}-digit QR codes. Retry the batch or revoke unused credentials.`,
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

export const importQrCredentials = onCall(callableOptions, async (request) => {
  const authContext = ensureAdmin(request)
  const eventId = normalizeEventId(request.data?.eventId)
  const codes = normalizeQrCredentialInputs(request.data?.codes)
  const eventSnapshot = await getEventDocRef(eventId).get()

  if (!eventSnapshot.exists) {
    throw new HttpsError('not-found', 'Event was not found.')
  }

  const createdCredentials = []
  const skippedCredentials = []
  const batch = db.batch()

  const snapshots = await Promise.all(
    codes.map((code) => getQrCredentialRef(eventId, code).get()),
  )

  codes.forEach((code, index) => {
    const snapshot = snapshots[index]
    const link = buildQrCredentialLink(code)

    if (snapshot.exists) {
      const existing = normalizeQrCredentialSnapshot(snapshot)
      skippedCredentials.push({
        code,
        reason: existing.status === QR_STATUSES.assigned ? 'assigned' : 'exists',
      })
      return
    }

    batch.set(
      getQrCredentialRef(eventId, code),
      buildQrCredentialCreateRecord({
        code,
        link,
        actorUid: authContext.uid,
      }),
    )
    createdCredentials.push({ id: code, code, link, status: QR_STATUSES.unassigned })
  })

  if (createdCredentials.length) {
    batch.set(
      createAuditLogRef(eventId),
      buildAuditLogRecord({
        type: AUDIT_TYPES.qrGeneration,
        actorUid: authContext.uid,
        summary: `Imported ${createdCredentials.length} QR credential${createdCredentials.length === 1 ? '' : 's'}`,
        targetType: 'qrCredentialBatch',
        details: {
          count: createdCredentials.length,
          skippedCount: skippedCredentials.length,
          codes: createdCredentials.map((item) => item.code),
        },
      }),
    )
  }

  if (createdCredentials.length) {
    await batch.commit()
  }

  return {
    count: createdCredentials.length,
    skippedCount: skippedCredentials.length,
    credentials: createdCredentials,
    skipped: skippedCredentials,
  }
})

export const deleteQrCredential = onCall(callableOptions, async (request) => {
  const authContext = ensureAdmin(request)
  const eventId = normalizeEventId(request.data?.eventId)
  const qrCode = normalizeScannedQrCode(request.data?.qrInput || request.data?.code)

  await db.runTransaction(async (transaction) => {
    const credentialRef = getQrCredentialRef(eventId, qrCode)
    const credentialSnapshot = await transaction.get(credentialRef)

    if (!credentialSnapshot.exists) {
      throw new HttpsError('not-found', 'QR credential was not found.')
    }

    const credential = normalizeQrCredentialSnapshot(credentialSnapshot)

    if (credential.status === QR_STATUSES.assigned || credential.assignedPersonaId) {
      throw new HttpsError('failed-precondition', 'Assigned QR credentials cannot be deleted. Revoke them first.')
    }

    transaction.delete(credentialRef)
    transaction.set(
      createAuditLogRef(eventId),
      buildAuditLogRecord({
        type: AUDIT_TYPES.qrRevocation,
        actorUid: authContext.uid,
        summary: `Deleted QR credential ${qrCode}`,
        targetType: 'qrCredential',
        targetId: qrCode,
        details: {
          code: qrCode,
          previousStatus: credential.status,
        },
      }),
    )
  })

  return { code: qrCode, deleted: true }
})

export const assignQrCredentialToPersona = onCall(async (request) => {
  const authContext = ensureAdmin(request)
  const eventId = normalizeEventId(request.data?.eventId)
  const personId = normalizePersonId(request.data?.personId)
  const qrCode = normalizeScannedQrCode(request.data?.qrInput)
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

    const nextLink = buildQrCredentialLink(qrCode)

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

    // Read carryover in parallel with existing-link check (all reads before writes)
    const personNormalizedShibboleth = person.normalizedShibboleth || normalizeShibbolethKey(person.shibboleth)
    const readsToAwait = [
      linkedAuthUid && targetEventLinkRef ? transaction.get(targetEventLinkRef) : Promise.resolve(null),
      linkedAuthUid && personNormalizedShibboleth
        ? transaction.get(getCarryoverBalanceRef(personNormalizedShibboleth))
        : Promise.resolve(null),
    ]
    const [existingLinkSnapshot, carryoverSnapshot] = await Promise.all(readsToAwait)

    if (person.linkedAuthUid && person.linkedAuthUid !== linkedAuthUid) {
      transaction.delete(db.doc(`accounts/${person.linkedAuthUid}/eventLinks/${eventId}`))
    }

    if (linkedAuthUid && targetEventLinkRef) {
      if (existingLinkSnapshot?.exists && existingLinkSnapshot.data().personId !== personId) {
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
          shibboleth: person.shibboleth || '',
          normalizedShibboleth: personNormalizedShibboleth,
          linkedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
      )
    }

    if (!linkedAuthUid && person.linkedAuthUid) {
      transaction.delete(db.doc(`accounts/${person.linkedAuthUid}/eventLinks/${eventId}`))
    }

    // Apply carryover balance if linking (not unlinking) and not already applied
    const carryover = carryoverSnapshot?.exists ? carryoverSnapshot.data() : null
    const carryoverBalance = Number.isFinite(carryover?.balance) ? carryover.balance : 0
    const carryoverAlreadyApplied = Boolean(
      carryover && person.carryoverAppliedFromEventId === carryover.sourceEventId,
    )
    const shouldApplyCarryover = linkedAuthUid && carryoverBalance !== 0 && carryover && !carryoverAlreadyApplied

    const personPatch = buildPersonLinkPatch({ linkedAuthUid })
    if (shouldApplyCarryover) {
      const balanceBefore = Number.isFinite(person.balance) ? person.balance : 0
      personPatch.balance = balanceBefore + carryoverBalance
      personPatch.carryoverAppliedFromEventId = carryover.sourceEventId
    }

    transaction.set(personRef, personPatch, { merge: true })

    if (shouldApplyCarryover) {
      const balanceBefore = Number.isFinite(person.balance) ? person.balance : 0
      const ledgerRef = db.collection(`${getEventPath(eventId)}/ledgerEntries`).doc()
      transaction.set(ledgerRef, {
        type: 'carryoverIn',
        actorUid: authContext.uid,
        personId,
        amount: carryoverBalance,
        balanceBefore,
        balanceAfter: balanceBefore + carryoverBalance,
        currency: 'HUF',
        reason: `Carry-over from event ${carryover.sourceEventId || 'unknown'} (applied on admin link)`,
        createdAt: FieldValue.serverTimestamp(),
      })
    }

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

export const closeEventAndCarryBalances = onCall(callableOptions, async (request) => {
  const authContext = ensureAdmin(request)
  const eventId = normalizeEventId(request.data?.eventId)
  const eventRef = getEventDocRef(eventId)
  const runtimeRef = db.doc('system/runtime')

  let summary = {
    carriedCount: 0,
    totalBalance: 0,
  }

  await db.runTransaction(async (transaction) => {
    const eventSnapshot = await transaction.get(eventRef)

    if (!eventSnapshot.exists) {
      throw new HttpsError('not-found', 'Event was not found.')
    }

    const event = eventSnapshot.data()

    if (event.status !== 'active') {
      throw new HttpsError('failed-precondition', 'Only the active event can be closed.')
    }

    const peopleSnapshot = await transaction.get(db.collection(`${getEventPath(eventId)}/people`))
    const activePeople = peopleSnapshot.docs
      .map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }))
      .filter((person) => person.recordStatus !== 'deleted')

    // Collect unique normalized shibboleth values so we can read their existing
    // carryover docs before writing. This lets us rescue any balance that was
    // never applied to a persona in this event and would otherwise be overwritten.
    const uniqueShibboleths = [
      ...new Set(
        activePeople
          .map((p) => p.normalizedShibboleth || normalizeShibbolethKey(p.shibboleth))
          .filter(Boolean),
      ),
    ]

    const existingCarryoverSnaps = await Promise.all(
      uniqueShibboleths.map((s) => transaction.get(getCarryoverBalanceRef(s))),
    )
    const existingCarryoverByShib = new Map()
    uniqueShibboleths.forEach((shib, i) => {
      if (existingCarryoverSnaps[i].exists) {
        existingCarryoverByShib.set(shib, existingCarryoverSnaps[i].data())
      }
    })

    const missingShibboleth = []
    const peopleByShibboleth = new Map()

    activePeople.forEach((person) => {
      const balance = Number.isFinite(person.balance) ? person.balance : 0
      const normalizedShibboleth = person.normalizedShibboleth || normalizeShibbolethKey(person.shibboleth)

      if (!normalizedShibboleth) {
        if (balance !== 0) {
          missingShibboleth.push({
            personId: person.id,
            displayName: person.displayName || '',
            balance,
          })
        }
        return
      }

      const existing = peopleByShibboleth.get(normalizedShibboleth) || []
      existing.push({
        personId: person.id,
        displayName: person.displayName || '',
      })
      peopleByShibboleth.set(normalizedShibboleth, existing)
    })

    const duplicateShibboleths = [...peopleByShibboleth.entries()]
      .filter(([, people]) => people.length > 1)
      .map(([normalizedShibboleth, people]) => ({ normalizedShibboleth, people }))

    if (missingShibboleth.length || duplicateShibboleths.length) {
      throw new HttpsError(
        'failed-precondition',
        'Event cannot be closed until shibboleth problems are fixed.',
        { missingShibboleth, duplicateShibboleths },
      )
    }

    let carriedCount = 0
    let totalBalance = 0

    activePeople.forEach((person) => {
      const normalizedShibboleth = person.normalizedShibboleth || normalizeShibbolethKey(person.shibboleth)
      if (!normalizedShibboleth) return

      const personBalance = Number.isFinite(person.balance) ? person.balance : 0

      // If there is an existing carryover from a previous event that was never
      // applied to this persona, accumulate it so the money is not lost when
      // we overwrite the carryover doc below.
      const existingCarryover = existingCarryoverByShib.get(normalizedShibboleth)
      const unappliedCarryover =
        existingCarryover &&
        existingCarryover.sourceEventId !== eventId &&
        person.carryoverAppliedFromEventId !== existingCarryover.sourceEventId
          ? (Number.isFinite(existingCarryover.balance) ? existingCarryover.balance : 0)
          : 0

      const balance = personBalance + unappliedCarryover

      carriedCount += 1
      totalBalance += balance

      transaction.set(
        getCarryoverBalanceRef(normalizedShibboleth),
        {
          shibboleth: person.shibboleth || '',
          normalizedShibboleth,
          balance,
          currency: 'HUF',
          sourceEventId: eventId,
          sourcePersonId: person.id,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: authContext.uid,
          lastClosedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
    })

    transaction.set(
      eventRef,
      {
        status: 'closed',
        updatedBy: authContext.uid,
        updatedAt: FieldValue.serverTimestamp(),
        closedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )

    transaction.set(
      runtimeRef,
      {
        activeEventId: null,
        updatedBy: authContext.uid,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )

    transaction.set(
      createAuditLogRef(eventId),
      buildAuditLogRecord({
        type: AUDIT_TYPES.eventChange,
        actorUid: authContext.uid,
        summary: `Closed event ${event.name || eventId} and carried ${carriedCount} balances`,
        targetType: 'event',
        targetId: eventId,
        details: {
          carriedCount,
          totalBalance,
        },
      }),
    )

    summary = { carriedCount, totalBalance }
  })

  return summary
})

export const joinEventByShibboleth = onCall(callableOptions, async (request) => {
  const authContext = ensureAuthenticated(request)
  const eventId = normalizeEventId(request.data?.eventId)
  const submittedShibboleth = typeof request.data?.shibboleth === 'string'
    ? request.data.shibboleth.trim()
    : ''

  const accountRef = getAccountRef(authContext.uid)
  const eventLinkRef = db.doc(`accounts/${authContext.uid}/eventLinks/${eventId}`)

  let joinedPerson = null

  await db.runTransaction(async (transaction) => {
    const [accountSnapshot, existingLinkSnapshot] = await Promise.all([
      transaction.get(accountRef),
      transaction.get(eventLinkRef),
    ])

    if (!accountSnapshot.exists) {
      throw new HttpsError('failed-precondition', 'Account record was not found.')
    }

    const account = accountSnapshot.data()
    const shibboleth = normalizeShibboleth(submittedShibboleth || account.shibboleth)
    const normalizedShibboleth = normalizeShibbolethKey(shibboleth)

    if (existingLinkSnapshot.exists) {
      const existingLink = existingLinkSnapshot.data()

      if (existingLink.personId) {
        joinedPerson = {
          id: existingLink.personId,
          displayName: existingLink.displayName || '',
          alreadyLinked: true,
        }
        return
      }
    }

    // Read people query and carryover balance in parallel (all reads before any writes)
    const [matchingPeopleSnapshot1, carryoverSnapshot] = await Promise.all([
      transaction.get(
        db.collection(`${getEventPath(eventId)}/people`)
          .where('normalizedShibboleth', '==', normalizedShibboleth),
      ),
      transaction.get(getCarryoverBalanceRef(normalizedShibboleth)),
    ])

    let matchingPeopleSnapshot = matchingPeopleSnapshot1
    if (matchingPeopleSnapshot.empty) {
      matchingPeopleSnapshot = await transaction.get(
        db.collection(`${getEventPath(eventId)}/people`)
          .where('shibboleth', '==', shibboleth),
      )
    }

    const matchingPeople = matchingPeopleSnapshot.docs
      .map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }))
      .filter((person) => person.recordStatus !== 'deleted')

    if (matchingPeople.length === 0) {
      throw new HttpsError('not-found', 'Ilyen shibboleth-tel nem található személy az eseményen, keress egy animátort.')
    }

    if (matchingPeople.length > 1) {
      throw new HttpsError('failed-precondition', 'Több mint egy személy van rendelve ehhez a shibboleth-hez, keress egy animátort.')
    }

    const person = matchingPeople[0]

    if (person.linkedAuthUid && person.linkedAuthUid !== authContext.uid) {
      throw new HttpsError('failed-precondition', 'Ehhez a shibboleth-hez már van fiók kötve, keress egy animátort.')
    }

    // ── Carryover balance application ────────────────────────────────────
    const carryover = carryoverSnapshot.exists ? carryoverSnapshot.data() : null
    const carryoverBalance = Number.isFinite(carryover?.balance) ? carryover.balance : 0
    // Guard against double-apply: import stamps carryoverAppliedFromEventId when it applies carryover
    const carryoverAlreadyApplied = Boolean(
      carryover && person.carryoverAppliedFromEventId === carryover.sourceEventId,
    )
    const shouldApplyCarryover = carryoverBalance !== 0 && carryover && !carryoverAlreadyApplied

    // Build person patch — combine link + optional carryover into one write
    const personPatch = buildPersonLinkPatch({ linkedAuthUid: authContext.uid })
    if (shouldApplyCarryover) {
      const balanceBefore = Number.isFinite(person.balance) ? person.balance : 0
      personPatch.balance = balanceBefore + carryoverBalance
      personPatch.carryoverAppliedFromEventId = carryover.sourceEventId
    }

    transaction.set(
      accountRef,
      {
        shibboleth,
        normalizedShibboleth,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )

    transaction.set(
      eventLinkRef,
      {
        eventId,
        personId: person.id,
        linkedPersonaId: person.id,
        linkedAuthUid: authContext.uid,
        linkedBy: authContext.uid,
        displayName: person.displayName || '',
        team: person.team || '',
        attendeeType: person.attendeeType || null,
        shibboleth: person.shibboleth || shibboleth,
        normalizedShibboleth,
        linkedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
    )

    transaction.set(getPersonRef(eventId, person.id), personPatch, { merge: true })

    // Write ledger entry if carryover was applied now
    if (shouldApplyCarryover) {
      const balanceBefore = Number.isFinite(person.balance) ? person.balance : 0
      const ledgerRef = db.collection(`${getEventPath(eventId)}/ledgerEntries`).doc()
      transaction.set(ledgerRef, {
        type: 'carryoverIn',
        actorUid: authContext.uid,
        personId: person.id,
        amount: carryoverBalance,
        balanceBefore,
        balanceAfter: balanceBefore + carryoverBalance,
        currency: 'HUF',
        reason: `Carry-over from event ${carryover.sourceEventId || 'unknown'} (applied on join)`,
        createdAt: FieldValue.serverTimestamp(),
      })
    }

    if (person.assignedQrId || person.qrCodeId) {
      const qrCode = person.assignedQrId || person.qrCodeId
      transaction.set(
        getQrCredentialRef(eventId, qrCode),
        {
          assignedAccountId: authContext.uid,
          linkedAuthUid: authContext.uid,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
    }

    transaction.set(
      createAuditLogRef(eventId),
      buildAuditLogRecord({
        type: AUDIT_TYPES.accountSelfJoin,
        actorUid: authContext.uid,
        summary: `Account ${account.email || authContext.uid} joined persona ${person.displayName || person.id} by shibboleth`,
        targetType: 'person',
        targetId: person.id,
        personId: person.id,
        details: {
          linkedAuthUid: authContext.uid,
          shibboleth,
        },
      }),
    )

    joinedPerson = {
      id: person.id,
      displayName: person.displayName || '',
      internalId: person.internalId || '',
    }
  })

  return {
    joined: Boolean(joinedPerson),
    person: joinedPerson,
  }
})

export const selfAssignQrCredential = onCall(callableOptions, async (request) => {
  const authContext = ensureAuthenticated(request)
  const uid = authContext.uid
  const eventId = normalizeEventId(request.data?.eventId)
  const qrCode = normalizeScannedQrCode(request.data?.qrInput)
  const eventLinkRef = db.doc(`accounts/${uid}/eventLinks/${eventId}`)
  const eventLinkSnapshot = await eventLinkRef.get()

  if (!eventLinkSnapshot.exists) {
    throw new HttpsError('not-found', 'Your account is not linked to a persona in this event.')
  }

  const personId = eventLinkSnapshot.data().personId

  if (!personId) {
    throw new HttpsError('not-found', 'Your account is not linked to a persona in this event.')
  }

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

    const person = personSnapshot.data()

    if (person.recordStatus === 'deleted') {
      throw new HttpsError('failed-precondition', 'This persona cannot receive a QR credential.')
    }

    // Verify the caller actually owns this persona
    if (person.linkedAuthUid !== uid) {
      throw new HttpsError('permission-denied', 'This persona is not linked to your account.')
    }

    // Block self-assign if persona already has a QR (staff must revoke first)
    const currentQrCode = person.assignedQrId || person.qrCodeId || null
    if (currentQrCode) {
      throw new HttpsError('failed-precondition', 'Your profile already has a QR code. Ask a staff member to remove it first.')
    }

    if (!credentialSnapshot.exists) {
      throw new HttpsError('not-found', 'QR code not found. Check the code and try again.')
    }

    const credential = normalizeQrCredentialSnapshot(credentialSnapshot)

    if (credential.status === QR_STATUSES.revoked) {
      throw new HttpsError('failed-precondition', 'This QR code has been revoked and cannot be claimed.')
    }

    if (credential.status === QR_STATUSES.assigned) {
      throw new HttpsError('failed-precondition', 'This QR code is already in use.')
    }

    const nextLink = buildQrCredentialLink(qrCode)

    if (!nextLink) {
      throw new HttpsError('failed-precondition', 'QR credential link could not be determined.')
    }

    transaction.set(
      credentialRef,
      buildAssignedQrCredentialPatch({
        code: qrCode,
        link: nextLink,
        personId,
        linkedAccountId: uid,
        actorUid: uid,
        assignedAt: null,
      }),
      { merge: true },
    )

    transaction.set(personRef, buildPersonQrAssignmentPatch({ qrCode, qrLink: nextLink }), { merge: true })

    transaction.set(
      auditLogRef,
      buildAuditLogRecord({
        type: AUDIT_TYPES.qrAssignment,
        actorUid: uid,
        summary: `Self-assigned QR ${qrCode} to persona ${person.displayName || personId}`,
        targetType: 'person',
        targetId: personId,
        personId,
        details: { qrCode, selfAssign: true },
      }),
    )
  })

  return { personId, qrCode }
})
