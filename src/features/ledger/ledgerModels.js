import { serverTimestamp } from 'firebase/firestore'

export const LEDGER_ENTRY_TYPES = {
  topup: 'topup',
  manualAdjustment: 'manualAdjustment',
  sale: 'sale',
  refund: 'refund',
  drsReturn: 'drsReturn',
  carryoverIn: 'carryoverIn',
}

export function buildLedgerEntryRecord({
  type,
  actorUid,
  personId,
  amount,
  balanceBefore,
  balanceAfter,
  reason = '',
  // Optional grouping token for bulk operations (e.g. bulk balance adjust).
  // When present, all entries from a single bulk run share the same id, so
  // reports can roll them up as one action.
  correlationId = null,
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
    correlationId,
    createdAt: serverTimestamp(),
  }
}
