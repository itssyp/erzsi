import { serverTimestamp } from 'firebase/firestore'

export const DRS_DEPOSIT_AMOUNT = 50 // HUF, fixed for all DRS products

export function buildDrsReturnRecord({
  personId,
  personDisplayName,
  personInternalId,
  quantity,
  balanceBefore,
  balanceAfter,
  actorUid,
  actorName,
  notes = '',
}) {
  return {
    personId,
    personDisplayName,
    personInternalId,
    status: 'completed',
    quantity,
    depositAmountPerUnit: DRS_DEPOSIT_AMOUNT,
    totalCreditAmount: quantity * DRS_DEPOSIT_AMOUNT,
    balanceBefore,
    balanceAfter,
    actorUid,
    actorName,
    notes,
    currency: 'HUF',
    createdAt: serverTimestamp(),
  }
}
