import { serverTimestamp } from 'firebase/firestore'

export const AUDIT_TYPES = {
  import: 'import',
  personUpdate: 'personUpdate',
  personDelete: 'personDelete',
  personRestore: 'personRestore',
  accountLink: 'accountLink',
  qrAssignment: 'qrAssignment',
  qrGeneration: 'qrGeneration',
  qrRevocation: 'qrRevocation',
  qrReset: 'qrReset',
  topup: 'topup',
  manualBalanceAdjustment: 'manualBalanceAdjustment',
  productChange: 'productChange',
  modifierTemplateChange: 'modifierTemplateChange',
  eventChange: 'eventChange',
  orderFinalization: 'orderFinalization',
  refund: 'refund',
  kitchenStatusChange: 'kitchenStatusChange',
  drsReturn: 'drsReturn',
  accountSelfJoin: 'accountSelfJoin',
}

export function buildAuditLogRecord({
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
    createdAt: serverTimestamp(),
  }
}
