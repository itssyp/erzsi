import { useEffect, useMemo, useState } from 'react'
import { subscribeToAuditLogs } from '../audit/auditService'
import { subscribeToPeople } from '../people/personService'
import { subscribeToAccountsDirectory } from '../auth/accountService'
import { subscribeToEventsList } from '../events/eventService'
import { refundOrder } from '../orders/orderService'
import { AUDIT_TYPES } from '../audit/auditModels'

const DEFAULT_LOGS_PER_PAGE = 25
const PAGE_SIZE_OPTIONS = [25, 50, 100]

function formatTimestampParts(value) {
  if (!value?.toDate) return { time: '—', date: '' }
  const d = value.toDate()
  return {
    time: d.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' }),
    date: d.toLocaleDateString('hu-HU'),
  }
}

function formatTimestamp(value) {
  if (!value?.toDate) return 'Waiting for timestamp'
  return value.toDate().toLocaleString('hu-HU')
}

function formatDate(value) {
  if (!value) return '—'
  if (value?.toDate) return value.toDate().toLocaleDateString('hu-HU')
  return value
}

function getTypeVariant(type) {
  if (!type) return 'default'
  const t = type.toLowerCase()
  if (t.includes('topup') || t.includes('balance') || t.includes('carry') || t.includes('refund')) return 'money'
  if (t.includes('order')) return 'order'
  if (t.includes('import')) return 'import'
  if (t.includes('event') || t.includes('activat') || t.includes('clos') || t.includes('creat')) return 'lifecycle'
  if (t.includes('account') || t.includes('link') || t.includes('qr')) return 'identity'
  return 'default'
}

function buildPersonLabel(personId, peopleById) {
  if (!personId) return ''

  const person = peopleById.get(personId)
  if (!person) return personId

  return [
    person.displayName,
    person.internalId ? `#${person.internalId}` : null,
    person.team || null,
    person.shibboleth || null,
  ].filter(Boolean).join(' - ')
}

function buildActorLabel(actorUid, accountsById) {
  if (!actorUid) return 'Unknown'

  const account = accountsById.get(actorUid)
  if (!account) return actorUid

  return account.displayName || account.email || actorUid
}

function buildReadableSummary(log, peopleById) {
  if (!log.personId) return log.summary

  const person = peopleById.get(log.personId)
  if (!person?.displayName || !log.summary?.includes(log.personId)) return log.summary

  return log.summary.replaceAll(log.personId, person.displayName)
}

function formatTargetLabel(log, peopleById) {
  if (log.personId) return buildPersonLabel(log.personId, peopleById)
  if (log.targetType && log.targetId) return `${log.targetType}: ${log.targetId}`
  return log.targetType || '-'
}

function buildSearchText(log, peopleById, accountsById) {
  return [
    buildReadableSummary(log, peopleById),
    log.type,
    log.actorUid,
    buildActorLabel(log.actorUid, accountsById),
    log.personId,
    buildPersonLabel(log.personId, peopleById),
    log.targetType,
    log.targetId,
    formatTimestamp(log.createdAt),
  ].filter(Boolean).join(' ').toLowerCase()
}

function getEventStatus(event, activeEventId) {
  if (!event) return 'draft'
  if (activeEventId === event.id) return 'active'
  return event.status || 'draft'
}

export function AuditLogPanel({ eventId: defaultEventId, activeEventId, actorUid, showEventSelector = false }) {
  const [logs, setLogs] = useState([])
  const [people, setPeople] = useState([])
  const [accounts, setAccounts] = useState([])
  const [events, setEvents] = useState([])
  const [selectedEventId, setSelectedEventId] = useState(defaultEventId || '')
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [pageSize, setPageSize] = useState(DEFAULT_LOGS_PER_PAGE)
  const [page, setPage] = useState(1)
  const [errorMessage, setErrorMessage] = useState('')
  const [refundConfirmId, setRefundConfirmId] = useState(null)
  const [refundPendingId, setRefundPendingId] = useState(null)
  const [refundError, setRefundError] = useState(null)

  const eventId = showEventSelector ? selectedEventId : defaultEventId

  async function handleRefund(log) {
    if (!eventId || !log.targetId || !actorUid) return
    setRefundPendingId(log.id)
    setRefundConfirmId(null)
    setRefundError(null)
    try {
      await refundOrder({ eventId, orderId: log.targetId, actorUid })
    } catch (error) {
      setRefundError({ id: log.id, message: error.message })
    } finally {
      setRefundPendingId(null)
    }
  }

  useEffect(() => {
    if (!showEventSelector) return () => {}
    return subscribeToEventsList(setEvents, (error) => setErrorMessage(error.message))
  }, [showEventSelector])

  useEffect(() => {
    if (!eventId) return () => {}
    return subscribeToAuditLogs(eventId, setLogs, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    if (!eventId) return () => {}
    return subscribeToPeople(eventId, setPeople, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    return subscribeToAccountsDirectory(setAccounts, (error) => setErrorMessage(error.message))
  }, [])

  const peopleById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people])

  const accountsById = useMemo(
    () => new Map(accounts.map((account) => [account.uid || account.id, account])),
    [accounts],
  )

  const typeOptions = useMemo(
    () => Array.from(new Set(logs.map((log) => log.type).filter(Boolean))).sort(),
    [logs],
  )

  const filteredLogs = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase()

    return logs.filter((log) => {
      if (typeFilter && log.type !== typeFilter) return false
      if (!normalizedQuery) return true
      return buildSearchText(log, peopleById, accountsById).includes(normalizedQuery)
    })
  }, [accountsById, logs, peopleById, searchQuery, typeFilter])

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const visibleLogs = filteredLogs.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  useEffect(() => { setPage(1) }, [pageSize, searchQuery, typeFilter, eventId])

  const selectedEvent = useMemo(
    () => events.find((e) => e.id === selectedEventId) || null,
    [events, selectedEventId],
  )

  return (
    <div className="admin-section">
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <section className="panel">
        <div className="audit-toolbar">
          {showEventSelector ? (
            <div className="form-field audit-event-field">
              <label htmlFor="auditEventSelect">Event</label>
              <select
                id="auditEventSelect"
                value={selectedEventId}
                onChange={(e) => {
                  setSelectedEventId(e.target.value)
                  setLogs([])
                  setPeople([])
                  setSearchQuery('')
                  setTypeFilter('')
                }}
              >
                <option value="">Select an event…</option>
                {events.map((event) => {
                  const status = getEventStatus(event, activeEventId)
                  return (
                    <option key={event.id} value={event.id}>
                      {event.name} ({event.code}) — {formatDate(event.startsOn)} [{status}]
                    </option>
                  )
                })}
              </select>
            </div>
          ) : null}

          {eventId ? (
            <>
              <div className="form-field audit-search-field">
                <label htmlFor="auditLogSearch">Search</label>
                <input
                  id="auditLogSearch"
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Name, actor, action, target, or date"
                />
              </div>
              <div className="form-field audit-filter-field">
                <label htmlFor="auditTypeFilter">Action</label>
                <select
                  id="auditTypeFilter"
                  value={typeFilter}
                  onChange={(event) => setTypeFilter(event.target.value)}
                >
                  <option value="">All</option>
                  {typeOptions.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
              <div className="form-field audit-page-size-field">
                <label htmlFor="auditPageSize">Per page</label>
                <select
                  id="auditPageSize"
                  value={pageSize}
                  onChange={(event) => setPageSize(Number.parseInt(event.target.value, 10))}
                >
                  {PAGE_SIZE_OPTIONS.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>
              <span className="helper-text audit-result-count">
                {filteredLogs.length} / {logs.length}
              </span>
            </>
          ) : null}
        </div>

        {eventId ? (
          <>
            <div className="audit-table">
              {visibleLogs.map((log) => {
                const actorLabel = buildActorLabel(log.actorUid, accountsById)
                const targetLabel = formatTargetLabel(log, peopleById)
                const ts = formatTimestampParts(log.createdAt)
                const variant = getTypeVariant(log.type)

                const isOrderLog = log.type === AUDIT_TYPES.orderFinalization && log.targetId
              const isConfirming = refundConfirmId === log.id
              const isPending = refundPendingId === log.id
              const rowError = refundError?.id === log.id ? refundError.message : null

              return (
                  <article key={log.id} className="audit-row">
                    <time className="audit-ts" title={formatTimestamp(log.createdAt)}>
                      <span>{ts.time}</span>
                      <span>{ts.date}</span>
                    </time>
                    <div className="audit-content">
                      <div className="audit-head">
                        {log.type ? (
                          <span className={`audit-type audit-type-${variant}`}>{log.type}</span>
                        ) : null}
                        <span className="audit-summary">{buildReadableSummary(log, peopleById)}</span>
                        {isOrderLog && !isConfirming && !isPending ? (
                          <button
                            type="button"
                            className="audit-refund-btn"
                            onClick={() => { setRefundConfirmId(log.id); setRefundError(null) }}
                          >
                            Refund
                          </button>
                        ) : null}
                        {isOrderLog && isConfirming ? (
                          <span className="audit-refund-confirm">
                            <span>Are you sure?</span>
                            <button
                              type="button"
                              className="audit-refund-confirm-btn yes"
                              onClick={() => handleRefund(log)}
                            >
                              Yes, refund
                            </button>
                            <button
                              type="button"
                              className="audit-refund-confirm-btn"
                              onClick={() => setRefundConfirmId(null)}
                            >
                              Cancel
                            </button>
                          </span>
                        ) : null}
                        {isPending ? (
                          <span className="helper-text" style={{ fontSize: '0.75rem' }}>Refunding…</span>
                        ) : null}
                      </div>
                      {rowError ? (
                        <span className="audit-refund-error">{rowError}</span>
                      ) : null}
                      <div className="audit-trail">
                        {actorLabel ? <span>{actorLabel}</span> : null}
                        {targetLabel && targetLabel !== '-' ? (
                          <span className="audit-trail-target">{targetLabel}</span>
                        ) : null}
                      </div>
                    </div>
                  </article>
                )
              })}
              {logs.length === 0 ? <p className="helper-text">This event has no logs yet.</p> : null}
              {logs.length > 0 && visibleLogs.length === 0 ? <p className="helper-text">No logs match the filters.</p> : null}
            </div>

            {filteredLogs.length > pageSize ? (
              <div className="audit-pagination" aria-label="Log pages">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setPage((v) => Math.max(1, v - 1))}
                  disabled={currentPage === 1}
                >
                  Previous
                </button>
                <span className="helper-text">Page {currentPage} / {totalPages}</span>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setPage((v) => Math.min(totalPages, v + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="helper-text">Select an event above to view its logs.</p>
        )}
      </section>
    </div>
  )
}
