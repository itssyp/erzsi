import { serverTimestamp } from 'firebase/firestore'

export const LEDGER_ENTRY_TYPES = {
  topup: 'topup',
  manualAdjustment: 'manualAdjustment',
  sale: 'sale',
  refund: 'refund',
}

export function buildLedgerEntryRecord({
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
    createdAt: serverTimestamp(),
  }
}
