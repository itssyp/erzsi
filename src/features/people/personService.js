import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../../lib/firebase'
import {
  EVENT_SUBCOLLECTIONS,
  getAccountEventLinkPath,
  getCarryoverBalancePath,
  getEventCollectionPath,
  getEventScopedPath,
} from '../../lib/firestorePaths'
import { createAuditLogWrite } from '../audit/auditService'
import { AUDIT_TYPES } from '../audit/auditModels'
import { buildLedgerEntryRecord, LEDGER_ENTRY_TYPES } from '../ledger/ledgerModels'
import { parseHufInteger } from '../../lib/money'
import { normalizeShibboleth } from '../../lib/normalize'
import {
  ATTENDEE_TYPES,
  PERSON_RECORD_STATUSES,
  buildPersonDeletePatch,
  buildPersonRecord,
  buildPersonRestorePatch,
  buildPersonUpdatePatch,
} from './personModels'
import { buildAccountEventLinkMetadataPatch } from '../auth/accountModels'

const topUpPersonBalanceCallable = httpsCallable(functions, 'topUpPersonBalance')

function normalizeImportedAttendeeType(value) {
  const normalized = `${value ?? ''}`.trim().toLowerCase()

  switch (normalized) {
    case ATTENDEE_TYPES.freshman:
    case 'golya':
    case 'gólya':
      return ATTENDEE_TYPES.freshman
    case ATTENDEE_TYPES.organizer:
    case 'animator':
    case 'animátor':
      return ATTENDEE_TYPES.organizer
    default:
      return normalized
  }
}

function buildInternalPersonId(personDocId) {
  return `P-${personDocId.slice(0, 8).toUpperCase()}`
}

function splitImportLine(line) {
  if (line.includes('\t')) return line.split('\t')
  if (line.includes(';')) return line.split(';')
  return line.split(',')
}

export function parsePeopleImportText(input) {
  const rows = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((row) => splitImportLine(row).map((item) => item.trim()))

  return parsePeopleImportRows(rows)
}

export function parsePeopleImportRows(rows) {
  const acceptedRows = []
  const rejectedRows = []

  rows.forEach((row, index) => {
    const [nameRaw = '', teamRaw = '', attendeeTypeRaw = '', shibbolethRaw = ''] = row.map((item) => `${item ?? ''}`.trim())
    const normalizedType = normalizeImportedAttendeeType(attendeeTypeRaw)

    if (!nameRaw) {
      rejectedRows.push({ lineNumber: index + 1, reason: 'Missing name', raw: row.join('\t') })
      return
    }

    if (
      normalizedType !== ATTENDEE_TYPES.organizer &&
      normalizedType !== ATTENDEE_TYPES.freshman
    ) {
      rejectedRows.push({
        lineNumber: index + 1,
        reason: 'Status must be gólya or animátor',
        raw: row.join('\t'),
      })
      return
    }

    acceptedRows.push({
      displayName: nameRaw,
      team: teamRaw,
      attendeeType: normalizedType,
      shibboleth: shibbolethRaw,
      normalizedShibboleth: normalizeShibboleth(shibbolethRaw),
    })
  })

  return { acceptedRows, rejectedRows }
}

export async function importPeopleFromText({ eventId, actorUid, text }) {
  const { acceptedRows, rejectedRows } = parsePeopleImportText(text)

  return importPeopleRows({ eventId, actorUid, acceptedRows, rejectedRows })
}

export async function importPeopleFromRows({ eventId, actorUid, rows }) {
  const { acceptedRows, rejectedRows } = parsePeopleImportRows(rows)

  return importPeopleRows({ eventId, actorUid, acceptedRows, rejectedRows })
}

async function importPeopleRows({ eventId, actorUid, acceptedRows, rejectedRows }) {
  if (acceptedRows.length === 0) {
    return { importedCount: 0, rejectedRows }
  }

  const batch = writeBatch(db)
  const createdPeople = []
  const carryoverSnapshots = await Promise.all(
    acceptedRows.map((row) =>
      row.normalizedShibboleth
        ? getDoc(doc(db, getCarryoverBalancePath(row.normalizedShibboleth)))
        : Promise.resolve(null),
    ),
  )
  let carryoverAppliedCount = 0

  acceptedRows.forEach((row, index) => {
    const personRef = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.people)))
    const carryover = carryoverSnapshots[index]?.exists() ? carryoverSnapshots[index].data() : null
    const carryoverBalance = Number.isFinite(carryover?.balance) ? carryover.balance : 0
    const personRecord = {
      ...buildPersonRecord({
        internalId: buildInternalPersonId(personRef.id),
        displayName: row.displayName,
        team: row.team,
        attendeeType: row.attendeeType,
        shibboleth: row.shibboleth,
        balance: carryoverBalance,
      }),
      // Stamp which event's carryover was applied so joinEventByShibboleth won't double-apply
      ...(carryoverBalance !== 0 && carryover ? { carryoverAppliedFromEventId: carryover.sourceEventId } : {}),
    }

    batch.set(personRef, personRecord)
    createdPeople.push({ personId: personRef.id, ...row, internalId: personRecord.internalId, carryoverBalance })

    if (carryoverBalance !== 0) {
      carryoverAppliedCount += 1
      batch.set(
        doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.ledgerEntries))),
        buildLedgerEntryRecord({
          type: LEDGER_ENTRY_TYPES.carryoverIn,
          actorUid,
          personId: personRef.id,
          amount: carryoverBalance,
          balanceBefore: 0,
          balanceAfter: carryoverBalance,
          reason: `Carry-over from event ${carryover.sourceEventId || 'unknown'}`,
        }),
      )
    }
  })

  const auditLogWrite = createAuditLogWrite({
    eventId,
    type: AUDIT_TYPES.import,
    actorUid,
    summary: `Imported ${acceptedRows.length} attendee records`,
    targetType: 'peopleImport',
    details: {
      importedCount: acceptedRows.length,
      rejectedCount: rejectedRows.length,
      includesShibboleth: acceptedRows.some((row) => row.shibboleth),
      carryoverAppliedCount,
    },
  })

  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()

  return {
    importedCount: acceptedRows.length,
    carryoverAppliedCount,
    rejectedRows,
    createdPeople,
  }
}

export function subscribeToPeople(eventId, onNext, onError) {
  return onSnapshot(
    query(
      collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.people)),
      orderBy('createdAt', 'desc'),
      limit(500),
    ),
    (snapshot) => {
      onNext(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    },
    onError,
  )
}

export { PERSON_RECORD_STATUSES, ATTENDEE_TYPES }

export async function updatePersonRecord({
  eventId,
  actorUid,
  personId,
  displayName,
  team,
  attendeeType,
  shibboleth,
}) {
  const personRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.people, personId))
  const newNormalizedShibboleth = normalizeShibboleth(shibboleth)

  await runTransaction(db, async (transaction) => {
    const personSnapshot = await transaction.get(personRef)

    if (!personSnapshot.exists()) {
      throw new Error('Person record was not found.')
    }

    const currentPerson = personSnapshot.data()
    const oldNormalizedShibboleth = currentPerson.normalizedShibboleth || normalizeShibboleth(currentPerson.shibboleth || '')

    // Only look up carryover when shibboleth is being set or changed to a new non-empty value
    const shibbolethChanged = newNormalizedShibboleth && newNormalizedShibboleth !== oldNormalizedShibboleth
    let carryover = null

    if (shibbolethChanged) {
      const carryoverRef = doc(db, getCarryoverBalancePath(newNormalizedShibboleth))
      const carryoverSnapshot = await transaction.get(carryoverRef)
      carryover = carryoverSnapshot.exists() ? carryoverSnapshot.data() : null
    }

    const carryoverBalance = Number.isFinite(carryover?.balance) ? carryover.balance : 0
    const carryoverAlreadyApplied = Boolean(
      carryover && currentPerson.carryoverAppliedFromEventId === carryover.sourceEventId,
    )
    const shouldApplyCarryover = shibbolethChanged && carryoverBalance !== 0 && carryover && !carryoverAlreadyApplied

    // Build the update patch, optionally including balance + carryover stamp
    const personPatch = buildPersonUpdatePatch({ displayName, team, attendeeType, shibboleth })
    if (shouldApplyCarryover) {
      const balanceBefore = Number.isFinite(currentPerson.balance) ? currentPerson.balance : 0
      personPatch.balance = balanceBefore + carryoverBalance
      personPatch.carryoverAppliedFromEventId = carryover.sourceEventId
    }

    transaction.set(personRef, personPatch, { merge: true })

    if (currentPerson.linkedAuthUid) {
      transaction.set(
        doc(db, getAccountEventLinkPath(currentPerson.linkedAuthUid, eventId)),
        buildAccountEventLinkMetadataPatch({ personId, displayName, team, attendeeType, shibboleth }),
        { merge: true },
      )
    }

    if (shouldApplyCarryover) {
      const balanceBefore = Number.isFinite(currentPerson.balance) ? currentPerson.balance : 0
      transaction.set(
        doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.ledgerEntries))),
        buildLedgerEntryRecord({
          type: LEDGER_ENTRY_TYPES.carryoverIn,
          actorUid,
          personId,
          amount: carryoverBalance,
          balanceBefore,
          balanceAfter: balanceBefore + carryoverBalance,
          reason: `Carry-over from event ${carryover.sourceEventId || 'unknown'} (applied on shibboleth update)`,
        }),
      )
    }

    const auditLogWrite = createAuditLogWrite({
      eventId,
      type: AUDIT_TYPES.personUpdate,
      actorUid,
      summary: `Updated person ${displayName}`,
      targetType: 'person',
      targetId: personId,
      personId,
      details: {
        displayName,
        team,
        attendeeType,
        shibboleth,
        ...(shouldApplyCarryover ? { carryoverApplied: carryoverBalance } : {}),
      },
    })

    transaction.set(auditLogWrite.ref, auditLogWrite.data)
  })
}

export async function deletePersonRecord({ eventId, actorUid, personId }) {
  const batch = writeBatch(db)
  const personRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.people, personId))
  const personSnapshot = await getDoc(personRef)

  if (!personSnapshot.exists()) {
    throw new Error('Person record was not found.')
  }

  const person = personSnapshot.data()

  batch.set(personRef, buildPersonDeletePatch({ actorUid }), { merge: true })

  if (person.linkedAuthUid) {
    batch.delete(doc(db, getAccountEventLinkPath(person.linkedAuthUid, eventId)))
  }

  const currentQrCode = person.assignedQrId || person.qrCodeId

  if (currentQrCode) {
    batch.set(
      doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.qrAssignments, currentQrCode)),
      {
        status: 'revoked',
        revokedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )
  }

  const auditLogWrite = createAuditLogWrite({
    eventId,
    type: AUDIT_TYPES.personDelete,
    actorUid,
    summary: `Deleted person ${person.displayName}`,
    targetType: 'person',
    targetId: personId,
    personId,
    details: {
      internalId: person.internalId,
    },
  })

  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()
}

export async function restorePersonRecord({ eventId, actorUid, personId }) {
  const personRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.people, personId))
  const personSnapshot = await getDoc(personRef)

  if (!personSnapshot.exists()) {
    throw new Error('Person record was not found.')
  }

  const person = personSnapshot.data()
  const batch = writeBatch(db)

  batch.set(personRef, buildPersonRestorePatch(), { merge: true })

  const auditLogWrite = createAuditLogWrite({
    eventId,
    type: AUDIT_TYPES.personRestore,
    actorUid,
    summary: `Restored person ${person.displayName}`,
    targetType: 'person',
    targetId: personId,
    personId,
    details: {
      internalId: person.internalId,
    },
  })

  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()
}

async function writeBalanceChange({
  eventId,
  actorUid,
  personId,
  amount,
  reason,
  ledgerType,
  auditType,
  summary,
}) {
  const parsedAmount = parseHufInteger(amount)

  if (!Number.isInteger(parsedAmount) || parsedAmount === 0) {
    throw new Error('Amount must be a non-zero integer HUF value.')
  }

  const personRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.people, personId))
  const ledgerRef = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.ledgerEntries)))
  const auditRef = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.auditLogs)))

  await runTransaction(db, async (transaction) => {
    const personSnapshot = await transaction.get(personRef)

    if (!personSnapshot.exists()) {
      throw new Error('Person record was not found.')
    }

    const person = personSnapshot.data()

    if (person.recordStatus === PERSON_RECORD_STATUSES.deleted) {
      throw new Error('Deleted person records cannot receive balance changes.')
    }

    const balanceBefore = person.balance || 0
    const balanceAfter = balanceBefore + parsedAmount

    transaction.set(
      personRef,
      {
        balance: balanceAfter,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )
    transaction.set(
      ledgerRef,
      buildLedgerEntryRecord({
        type: ledgerType,
        actorUid,
        personId,
        amount: parsedAmount,
        balanceBefore,
        balanceAfter,
        reason,
      }),
    )
    transaction.set(
      auditRef,
      createAuditLogWrite({
        eventId,
        type: auditType,
        actorUid,
        summary,
        targetType: 'personBalance',
        targetId: personId,
        personId,
        details: {
          amount: parsedAmount,
          balanceBefore,
          balanceAfter,
          reason: reason || null,
        },
      }).data,
    )
  })
}

export async function topUpPersonBalance({ eventId, actorUid, personId, amount }) {
  const result = await topUpPersonBalanceCallable({
    eventId,
    actorUid,
    personId,
    amount,
  })

  return result.data
}

export async function adjustPersonBalance({ eventId, actorUid, personId, amount, reason = '' }) {
  return writeBalanceChange({
    eventId,
    actorUid,
    personId,
    amount,
    reason,
    ledgerType: LEDGER_ENTRY_TYPES.manualAdjustment,
    auditType: AUDIT_TYPES.manualBalanceAdjustment,
    summary: `Manual balance adjustment applied to person ${personId}`,
  })
}
