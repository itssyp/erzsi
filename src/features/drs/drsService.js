import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { createAuditLogWrite } from '../audit/auditService'
import { AUDIT_TYPES } from '../audit/auditModels'
import { buildLedgerEntryRecord, LEDGER_ENTRY_TYPES } from '../ledger/ledgerModels'
import { EVENT_SUBCOLLECTIONS, getEventCollectionPath, getEventScopedPath } from '../../lib/firestorePaths'
import { buildDrsReturnRecord, DRS_DEPOSIT_AMOUNT } from './drsModels'

export async function createDrsReturn({ eventId, personId, quantity, actorUid, actorName }) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('A visszaváltott palackok száma legalább 1 kell legyen.')
  }

  const personRef = doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.people, personId))
  const drsReturnRef = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.drsReturns)))
  const ledgerRef = doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.ledgerEntries)))
  const totalCreditAmount = quantity * DRS_DEPOSIT_AMOUNT

  return runTransaction(db, async (transaction) => {
    const personSnapshot = await transaction.get(personRef)

    if (!personSnapshot.exists()) {
      throw new Error('A személy nem található.')
    }

    const person = { id: personSnapshot.id, ...personSnapshot.data() }

    if (person.recordStatus === 'deleted') {
      throw new Error('Törölt személyek számára nem végezhető betétdíj-visszaváltás.')
    }

    const balanceBefore = person.balance || 0
    const balanceAfter = balanceBefore + totalCreditAmount

    const auditLogWrite = createAuditLogWrite({
      eventId,
      type: AUDIT_TYPES.drsReturn,
      actorUid,
      summary: `DRS visszaváltás: ${quantity} palack – ${person.displayName}`,
      targetType: 'drsReturn',
      targetId: drsReturnRef.id,
      personId,
      details: {
        quantity,
        depositAmountPerUnit: DRS_DEPOSIT_AMOUNT,
        totalCreditAmount,
        balanceBefore,
        balanceAfter,
      },
    })

    transaction.set(
      drsReturnRef,
      buildDrsReturnRecord({
        personId,
        personDisplayName: person.displayName,
        personInternalId: person.internalId,
        quantity,
        balanceBefore,
        balanceAfter,
        actorUid,
        actorName,
      }),
    )
    transaction.set(personRef, { balance: balanceAfter, updatedAt: serverTimestamp() }, { merge: true })
    transaction.set(
      ledgerRef,
      buildLedgerEntryRecord({
        type: LEDGER_ENTRY_TYPES.drsReturn,
        actorUid,
        personId,
        amount: totalCreditAmount,
        balanceBefore,
        balanceAfter,
        reason: drsReturnRef.id,
      }),
    )
    transaction.set(auditLogWrite.ref, auditLogWrite.data)

    return { drsReturnId: drsReturnRef.id, totalCreditAmount, balanceAfter }
  })
}

export function subscribeDrsReturns(eventId, onNext, onError) {
  return onSnapshot(
    query(
      collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.drsReturns)),
      orderBy('createdAt', 'desc'),
    ),
    (snapshot) => {
      onNext(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })))
    },
    onError,
  )
}
