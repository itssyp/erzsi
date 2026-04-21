import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  writeBatch,
} from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { EVENT_SUBCOLLECTIONS, getEventCollectionPath, getEventScopedPath } from '../../lib/firestorePaths'
import { createAuditLogWrite } from '../audit/auditService'
import { AUDIT_TYPES } from '../audit/auditModels'
import {
  buildModifierTemplatePatch,
  buildModifierTemplateRecord,
  parseDefaultIngredientsText,
  parseOptionalExtrasText,
} from './modifierTemplateModels'

export function subscribeToModifierTemplates(eventId, onNext, onError) {
  return onSnapshot(
    query(
      collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.modifierTemplates)),
      orderBy('createdAt', 'desc'),
    ),
    (snapshot) => {
      onNext(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
    },
    onError,
  )
}

export async function saveModifierTemplate({
  eventId,
  actorUid,
  templateId,
  name,
  defaultIncludedIngredientsText,
  optionalExtrasText,
}) {
  const defaultIncludedIngredients = parseDefaultIngredientsText(defaultIncludedIngredientsText)
  const optionalExtras = parseOptionalExtrasText(optionalExtrasText)
  const batch = writeBatch(db)
  const templateRef = templateId
    ? doc(db, getEventScopedPath(eventId, EVENT_SUBCOLLECTIONS.modifierTemplates, templateId))
    : doc(collection(db, getEventCollectionPath(eventId, EVENT_SUBCOLLECTIONS.modifierTemplates)))

  const payload = {
    name,
    defaultIncludedIngredients,
    optionalExtras,
    actorUid,
  }

  batch.set(
    templateRef,
    templateId ? buildModifierTemplatePatch(payload) : buildModifierTemplateRecord(payload),
    { merge: Boolean(templateId) },
  )

  const auditLogWrite = createAuditLogWrite({
    eventId,
    type: AUDIT_TYPES.modifierTemplateChange,
    actorUid,
    summary: `${templateId ? 'Updated' : 'Created'} modifier template ${name}`,
    targetType: 'modifierTemplate',
    targetId: templateRef.id,
    details: {
      defaultIncludedCount: defaultIncludedIngredients.length,
      optionalExtrasCount: optionalExtras.length,
    },
  })

  batch.set(auditLogWrite.ref, auditLogWrite.data)
  await batch.commit()
}
