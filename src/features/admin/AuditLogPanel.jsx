import { useEffect, useMemo, useState } from 'react'
import { subscribeToAuditLogs } from '../audit/auditService'
import { subscribeToPeople } from '../people/personService'
import { subscribeToAccountsDirectory } from '../auth/accountService'

const LOGS_PER_PAGE = 20

function formatTimestamp(value) {
  if (!value?.toDate) return 'Várakozó időbélyeg'

  return value.toDate().toLocaleString('hu-HU')
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
  ].filter(Boolean).join(' · ')
}

function buildActorLabel(actorUid, accountsById) {
  if (!actorUid) return 'Ismeretlen'

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

function buildSearchText(log, peopleById, accountsById) {
  return [
    buildReadableSummary(log, peopleById),
    log.type,
    log.actorUid,
    buildActorLabel(log.actorUid, accountsById),
    log.personId,
    buildPersonLabel(log.personId, peopleById),
    formatTimestamp(log.createdAt),
  ].filter(Boolean).join(' ').toLowerCase()
}

export function AuditLogPanel({ eventId }) {
  const [logs, setLogs] = useState([])
  const [people, setPeople] = useState([])
  const [accounts, setAccounts] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [page, setPage] = useState(1)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    return subscribeToAuditLogs(eventId, setLogs, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    return subscribeToPeople(eventId, setPeople, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    return subscribeToAccountsDirectory(setAccounts, (error) => setErrorMessage(error.message))
  }, [])

  const peopleById = useMemo(() => {
    return new Map(people.map((person) => [person.id, person]))
  }, [people])

  const accountsById = useMemo(() => {
    return new Map(accounts.map((account) => [account.uid || account.id, account]))
  }, [accounts])

  const filteredLogs = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase()
    if (!normalizedQuery) return logs

    return logs.filter((log) =>
      buildSearchText(log, peopleById, accountsById).includes(normalizedQuery),
    )
  }, [accountsById, logs, peopleById, searchQuery])

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / LOGS_PER_PAGE))
  const currentPage = Math.min(page, totalPages)
  const visibleLogs = filteredLogs.slice(
    (currentPage - 1) * LOGS_PER_PAGE,
    currentPage * LOGS_PER_PAGE,
  )

  useEffect(() => {
    setPage(1)
  }, [searchQuery])

  return (
    <div className="admin-section">
      <section className="page-heading">
        <span className="eyebrow">Napló</span>
        <h3>Legutóbbi admin tevékenység</h3>
        <p className="muted">Az importok, kapcsolások, QR-módosítások, egyenlegműveletek és katalógus-változások eseményenként naplózva vannak.</p>
      </section>

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <section className="panel">
        <div className="audit-toolbar">
          <div className="form-field audit-search-field">
            <label htmlFor="auditLogSearch">Napló keresése</label>
            <input
              id="auditLogSearch"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Név, végrehajtó, típus vagy dátum"
            />
          </div>
          <span className="helper-text audit-result-count">
            {filteredLogs.length} / {logs.length} bejegyzés
          </span>
        </div>

        <div className="record-list stacked">
          {visibleLogs.map((log) => {
            const personLabel = buildPersonLabel(log.personId, peopleById)
            const actorLabel = buildActorLabel(log.actorUid, accountsById)

            return (
              <article key={log.id} className="audit-row">
                <div className="split-header">
                  <strong>{buildReadableSummary(log, peopleById)}</strong>
                  <span className="helper-text">{formatTimestamp(log.createdAt)}</span>
                </div>
                <div className="audit-meta">
                  <span className="audit-meta-item">
                    <strong>Típus</strong>
                    <span>{log.type}</span>
                  </span>
                  <span className="audit-meta-item">
                    <strong>Végrehajtó</strong>
                    <span>{actorLabel}</span>
                  </span>
                  {personLabel ? (
                    <span className="audit-meta-item">
                      <strong>Személy</strong>
                      <span>{personLabel}</span>
                    </span>
                  ) : null}
                </div>
              </article>
            )
          })}
          {logs.length === 0 ? <p className="helper-text">Ehhez az eseményhez még nincs naplóbejegyzés.</p> : null}
          {logs.length > 0 && visibleLogs.length === 0 ? <p className="helper-text">Nincs találat a keresésre.</p> : null}
        </div>

        {filteredLogs.length > LOGS_PER_PAGE ? (
          <div className="audit-pagination" aria-label="Napló oldalak">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              disabled={currentPage === 1}
            >
              Előző
            </button>
            <span className="helper-text">
              {currentPage}. oldal / {totalPages}
            </span>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              disabled={currentPage === totalPages}
            >
              Következő
            </button>
          </div>
        ) : null}
      </section>
    </div>
  )
}
