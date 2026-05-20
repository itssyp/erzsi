import { useEffect, useMemo, useState } from 'react'
import { subscribeToAccountsDirectory } from '../auth/accountService'
import { setAccountRole } from './adminService'
import { ACCOUNT_STATUSES } from '../auth/accountModels'
import { subscribeToPeople } from '../people/personService'
import { ALL_ROLES, ROLES } from '../../lib/roles'

const roleOptions = [
  { value: ROLES.user, label: 'Vendég' },
  { value: ROLES.posStaff, label: 'Beugrós' },
  { value: ROLES.topupStaff, label: 'Paku' },
  { value: ROLES.staff, label: 'Büfés' },
  { value: ROLES.admin, label: 'Admin' },
]

const roleLabels = new Map(roleOptions.map((option) => [option.value, option.label]))

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

function getAccountActionErrorMessage(error) {
  switch (error?.code) {
    case 'functions/permission-denied':
      return 'A fiókod nem jogosult szerepkörök kezelésére.'
    case 'functions/invalid-argument':
      return error.message || 'A megadott szerepkör érvénytelen.'
    default:
      return error?.message || 'A szerepkör frissítése sikertelen volt.'
  }
}

export function RegisteredUsersPanel({ eventId = null, actorUid = null }) {
  const [accounts, setAccounts] = useState([])
  const [people, setPeople] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [pendingUid, setPendingUid] = useState(null)

  useEffect(() => {
    return subscribeToAccountsDirectory(setAccounts, (error) => setErrorMessage(error.message))
  }, [])

  useEffect(() => {
    if (!eventId) {
      setPeople([])
      return undefined
    }

    return subscribeToPeople(eventId, setPeople, (error) => setErrorMessage(error.message))
  }, [eventId])

  const personaByAccountId = useMemo(() => {
    const map = new Map()

    people.forEach((person) => {
      const accountId = person.linkedAccountId || person.linkedAuthUid
      if (accountId) {
        map.set(accountId, person)
      }
    })

    return map
  }, [people])

  const registeredUsers = useMemo(() => {
    return accounts.filter((account) => ALL_ROLES.includes(account.role || ROLES.user))
  }, [accounts])

  const filteredUsers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return registeredUsers

    return registeredUsers.filter((account) => {
      const linkedPersona = personaByAccountId.get(account.uid || account.id)
      const haystack = [
        account.displayName,
        account.email,
        account.shibboleth,
        account.normalizedShibboleth,
        account.uid,
        account.status,
        account.role,
        roleLabels.get(account.role),
        account.linkedPersonaId,
        account.personId,
        linkedPersona?.displayName,
        linkedPersona?.team,
        linkedPersona?.shibboleth,
        linkedPersona?.internalId,
      ].filter(Boolean).join(' ').toLowerCase()

      return haystack.includes(query)
    })
  }, [personaByAccountId, registeredUsers, searchQuery])

  async function handleRoleChange(account, role) {
    const currentRole = account.role || ROLES.user
    if (role === currentRole) return

    if (account.uid === actorUid && currentRole === ROLES.admin && role !== ROLES.admin) {
      const confirmed = window.confirm(
        'A saját admin jogosultságodat készülsz elvenni. Ha folytatod, elveszítheted az admin felülethez való hozzáférést. Biztosan folytatod?',
      )

      if (!confirmed) {
        return
      }
    }

    setPendingUid(account.uid || account.id)
    setErrorMessage('')
    setStatusMessage('')

    try {
      await setAccountRole({ uid: account.uid || account.id, role })
      setStatusMessage(`${account.displayName || account.email || 'Fiók'} szerepköre frissült: ${roleLabels.get(role) || role}.`)
    } catch (error) {
      setErrorMessage(getAccountActionErrorMessage(error))
    } finally {
      setPendingUid(null)
    }
  }

  return (
    <div className="admin-section">
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
      {statusMessage ? <div className="status-inline">{statusMessage}</div> : null}

      <section className="panel">
        <div className="split-header users-list-header">
          <div>
            <h4 className="card-title">Felhasználói fiókok</h4>
            <p className="helper-text">{filteredUsers.length} / {registeredUsers.length} fiók</p>
          </div>
          <div className="field users-search-field">
            <label htmlFor="registeredUserSearch">Keresés</label>
            <input
              id="registeredUserSearch"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Név, e-mail, shibboleth, szerepkör vagy UID"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="registered-user-list">
          {filteredUsers.map((account) => {
            const linkedPersona = personaByAccountId.get(account.uid || account.id)
            const hasLinkedPersona = Boolean(linkedPersona || account.linkedPersonaId || account.personId)
            const accountId = account.uid || account.id
            const accountRole = account.role || ROLES.user

            return (
              <article key={accountId} className="registered-user-row">
                <div className="registered-user-main">
                  <strong>{account.displayName || account.email || 'Névtelen felhasználó'}</strong>
                  <span>{account.email || 'Nincs e-mail'}</span>
                </div>
                <div className="registered-user-meta">
                  <span>{account.shibboleth || '-'}</span>
                  <span>{linkedPersona?.displayName || formatTimestamp(account.createdAt)}</span>
                </div>
                <div className="registered-user-pills">
                  <span className="event-pill">{getStatusLabel(account.status)}</span>
                  <span className="event-pill">{roleLabels.get(accountRole) || accountRole}</span>
                  <span className={`event-pill${hasLinkedPersona ? ' status-active' : ''}`}>
                    {hasLinkedPersona ? 'kötve' : 'nincs persona'}
                  </span>
                  <select
                    value={accountRole}
                    onChange={(event) => handleRoleChange(account, event.target.value)}
                    disabled={pendingUid === accountId || account.status === ACCOUNT_STATUSES.disabled}
                    aria-label={`${account.displayName || account.email || 'Fiók'} szerepköre`}
                  >
                    {roleOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </article>
            )
          })}

          {registeredUsers.length === 0 ? (
            <p className="helper-text">Még nincs felhasználói fiók.</p>
          ) : null}
          {registeredUsers.length > 0 && filteredUsers.length === 0 ? (
            <p className="helper-text">Nincs a keresésnek megfelelő felhasználó.</p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
