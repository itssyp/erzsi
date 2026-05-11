import { useEffect, useMemo, useState } from 'react'
import { subscribeToAccountsDirectory } from '../auth/accountService'
import { ACCOUNT_STATUSES } from '../auth/accountModels'
import { ROLES } from '../../lib/roles'

function formatTimestamp(value) {
  if (!value?.toDate) return '-'
  return value.toDate().toLocaleString('hu-HU')
}

function getStatusLabel(status) {
  switch (status) {
    case ACCOUNT_STATUSES.active:
      return 'aktív'
    case ACCOUNT_STATUSES.disabled:
      return 'letiltva'
    default:
      return status || '-'
  }
}

export function RegisteredUsersPanel() {
  const [accounts, setAccounts] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    return subscribeToAccountsDirectory(setAccounts, (error) => setErrorMessage(error.message))
  }, [])

  const registeredUsers = useMemo(() => {
    return accounts.filter((account) => account.role === ROLES.user)
  }, [accounts])

  const filteredUsers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return registeredUsers

    return registeredUsers.filter((account) => {
      const haystack = [
        account.displayName,
        account.email,
        account.shibboleth,
        account.normalizedShibboleth,
        account.uid,
        account.status,
        account.linkedPersonaId,
        account.personId,
      ].filter(Boolean).join(' ').toLowerCase()

      return haystack.includes(query)
    })
  }, [registeredUsers, searchQuery])

  return (
    <div className="admin-section">
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <section className="panel">
        <div className="split-header users-list-header">
          <div>
            <h4 className="card-title">Regisztrált felhasználók</h4>
            <p className="helper-text">{filteredUsers.length} / {registeredUsers.length} felhasználó</p>
          </div>
          <div className="field users-search-field">
            <label htmlFor="registeredUserSearch">Keresés</label>
            <input
              id="registeredUserSearch"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Név, e-mail, shibboleth vagy UID"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="registered-user-list">
          {filteredUsers.map((account) => (
            <article key={account.uid || account.id} className="registered-user-row">
              <div className="registered-user-main">
                <strong>{account.displayName || account.email || 'Névtelen felhasználó'}</strong>
                <span>{account.email || 'Nincs e-mail'}</span>
              </div>
              <div className="registered-user-meta">
                <span>{account.shibboleth || '-'}</span>
                <span>{formatTimestamp(account.createdAt)}</span>
              </div>
              <div className="registered-user-pills">
                <span className="event-pill">{getStatusLabel(account.status)}</span>
                <span className={`event-pill${account.linkedPersonaId || account.personId ? ' status-active' : ''}`}>
                  {account.linkedPersonaId || account.personId ? 'kötve' : 'nincs persona'}
                </span>
              </div>
            </article>
          ))}

          {registeredUsers.length === 0 ? (
            <p className="helper-text">Még nincs regisztrált felhasználó.</p>
          ) : null}
          {registeredUsers.length > 0 && filteredUsers.length === 0 ? (
            <p className="helper-text">Nincs a keresésnek megfelelő felhasználó.</p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
