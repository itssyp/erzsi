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
import { db } from '../../lib/firebase'
import { EVENT_SUBCOLLECTIONS, getAccountEventLinkPath, getEventCollectionPath, getEventScopedPath } from '../../lib/firestorePaths'
import { createAuditLogWrite } from '../audit/auditService'
import { AUDIT_TYPES } from '../audit/auditModels'
import { buildLedgerEntryRecord, LEDGER_ENTRY_TYPES } from '../ledger/ledgerModels'
import { parseHufInteger } from '../../lib/money'
import {
  ATTENDEE_TYPES,
  PERSON_RECORD_STATUSES,
  buildPersonDeletePatch,
  buildPersonRecord,
  buildPersonRestorePatch,
  buildPersonUpdatePatch,
} from './personModels'
import { buildAccountEventLinkMetadataPatch } from '../auth/accountModels'

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

  const acceptedRows = []
  const rejectedRows = []

  rows.forEach((row, index) => {
    const [nameRaw = '', teamRaw = '', attendeeTypeRaw = ''] = splitImportLine(row).map((item) => item.trim())
    const normalizedType = attendeeTypeRaw.toLowerCase()

    if (!nameRaw) {
      rejectedRows.push({ lineNumber: index + 1, reason: 'Missing name', raw: row })
      return
    }

    if (
      normalizedType !== ATTENDEE_TYPES.organizer &&
      normalizedType !== ATTENDEE_TYPES.freshman
    ) {
      rejectedRows.push({
        lineNumber: index + 1,
        reason: 'Status must be organizer or freshman',
        raw: row,
      })
      return
    }

    acceptedRows.push({
      displayName: nameRaw,
      team: teamRaw,
      attendeeType: normalizedType,
    })
  })

  return { acceptedRows, rejectedRows }
}

export async function importPeopleFromText({ eventId, actorUid, text }) {
  const { acceptedRows, rejectedRows } = parsePeopleImportText(text)

  if (acceptedRows.length === 0) {
    return { importedCount: 0, rejectedRows }
  }

  const batch = writeBatch(db)
  const createdPeople = []

  acceptedRows.forEach((row) => {
    const personRef = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.people)))
    const personRecord = buildPersonRecord({
      internalId: buildInternalPersonId(personRef.id),
      displayName: row.displayName,
      team: row.team,
      attendeeType: row.attendeeType,
    })

    batch.set(personRef, personRecord)
    createdPeople.push({ personId: personRef.id, ...row, internalId: personRecord.internalId })
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
    },
  })

  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()

  return {
    importedCount: acceptedRows.length,
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
}) {
  const personRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.people, personId))
  const personSnapshot = await getDoc(personRef)

  if (!personSnapshot.exists()) {
    throw new Error('Person record was not found.')
  }

  const currentPerson = personSnapshot.data()
  const batch = writeBatch(db)

  batch.set(
    personRef,
    buildPersonUpdatePatch({ displayName, team, attendeeType }),
    { merge: true },
  )

  if (currentPerson.linkedAuthUid) {
    batch.set(
      doc(db, getAccountEventLinkPath(currentPerson.linkedAuthUid, eventId)),
      buildAccountEventLinkMetadataPatch({
        personId,
        displayName,
        team,
        attendeeType,
      }),
      { merge: true },
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
    },
  })

  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()
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
  return writeBalanceChange({
    eventId,
    actorUid,
    personId,
    amount,
    reason: '',
    ledgerType: LEDGER_ENTRY_TYPES.topup,
    auditType: AUDIT_TYPES.topup,
    summary: `Top-up applied to person ${personId}`,
  })
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
