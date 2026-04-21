import { useEffect, useState } from 'react'
import { subscribeToAuditLogs } from '../audit/auditService'

function formatTimestamp(value) {
  if (!value?.toDate) return 'Várakozó időbélyeg'

  return value.toDate().toLocaleString('hu-HU')
}

export function AuditLogPanel({ eventId }) {
  const [logs, setLogs] = useState([])
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    return subscribeToAuditLogs(eventId, setLogs, (error) => setErrorMessage(error.message))
  }, [eventId])

  return (
    <div className="admin-section">
      <section className="page-heading">
        <span className="eyebrow">Napló</span>
        <h3>Legutóbbi admin tevékenység</h3>
        <p className="muted">Az importok, kapcsolások, QR-módosítások, egyenlegműveletek és katalógus-változások eseményenként naplózva vannak.</p>
      </section>

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <section className="panel">
        <div className="record-list stacked">
          {logs.map((log) => (
            <article key={log.id} className="audit-row">
              <div className="split-header">
                <strong>{log.summary}</strong>
                <span className="helper-text">{formatTimestamp(log.createdAt)}</span>
              </div>
              <p className="helper-text">
                {log.type} | végrehajtó: {log.actorUid}
                {log.personId ? ` | személy: ${log.personId}` : ''}
              </p>
            </article>
          ))}
          {logs.length === 0 ? <p className="helper-text">Ehhez az eseményhez még nincs naplóbejegyzés.</p> : null}
        </div>
      </section>
    </div>
  )
}
