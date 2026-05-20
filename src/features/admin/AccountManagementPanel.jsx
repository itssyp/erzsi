import { useEffect, useMemo, useState } from 'react'
import { subscribeToAccountsDirectory } from '../auth/accountService'
import { createPrivilegedAccount, disablePrivilegedAccount, setAccountRole } from './adminService'
import { ACCOUNT_STATUSES } from '../auth/accountModels'
import { PRIVILEGED_ROLES, ROLES } from '../../lib/roles'

const initialFormState = {
  email: '',
  password: '',
  displayName: '',
  role: ROLES.posStaff,
}

const privilegedRoleOptions = [
  { value: ROLES.admin, label: 'Admin' },
  { value: ROLES.staff, label: 'Staff' },
  { value: ROLES.topupStaff, label: 'Paku' },
  { value: ROLES.posStaff, label: 'POS' },
]

function getAccountActionErrorMessage(error) {
  switch (error?.code) {
    case 'functions/already-exists':
      return 'Ezzel az e-mail-címmel már létezik fiók.'
    case 'functions/permission-denied':
      return 'A fiókod nem jogosult kiemelt fiókok kezelésére.'
    case 'functions/invalid-argument':
      return error.message || 'A megadott fiókadatok érvénytelenek.'
    default:
      return error?.message || 'A fiókkezelési művelet sikertelen volt.'
  }
}

export function AccountManagementPanel({ actorUid }) {
  const [accounts, setAccounts] = useState([])
  const [formState, setFormState] = useState(initialFormState)
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')

  useEffect(() => {
    return subscribeToAccountsDirectory(
      setAccounts,
      (error) => setErrorMessage(error.message),
    )
  }, [])

  const privilegedAccounts = useMemo(() => {
    return accounts.filter((account) => PRIVILEGED_ROLES.includes(account.role))
  }, [accounts])

  function updateField(event) {
    const { name, value } = event.target

    setFormState((current) => ({
      ...current,
      [name]: value,
    }))
  }

  async function runAction(action) {
    setPending(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      await action()
    } catch (error) {
      setErrorMessage(getAccountActionErrorMessage(error))
    } finally {
      setPending(false)
    }
  }

  async function handleCreateAccount(event) {
    event.preventDefault()

    await runAction(async () => {
      const result = await createPrivilegedAccount(formState)
      setStatusMessage(`Létrejött egy ${result.role} szerepkörű fiók ehhez: ${result.email}.`)
      setFormState(initialFormState)
    })
  }

  async function handleRoleChange(account, role) {
    if (account.uid === actorUid && account.role === ROLES.admin && role !== ROLES.admin) {
      const confirmed = window.confirm(
        'A saját admin jogosultságodat készülsz elvenni. Ha folytatod, elveszítheted az admin felülethez való hozzáférést. Biztosan folytatod?',
      )

      if (!confirmed) {
        return
      }
    }

    await runAction(async () => {
      await setAccountRole({ uid: account.uid, role })
      setStatusMessage(`A szerepkör frissült erre: ${role}.`)
    })
  }

  async function handleDisableAccount(uid) {
    await runAction(async () => {
      await disablePrivilegedAccount({ uid })
      setStatusMessage('A fiók le lett tiltva.')
    })
  }

  return (
    <div className="admin-section">
      <section className="page-heading">
        <span className="eyebrow">Fiókok</span>
        <h3>Staff és admin hozzáférés</h3>
        <p className="muted">
          Itt hozhatsz létre staff vagy admin fiókokat, módosíthatod a szerepkörüket, és letilthatod a régi fiókokat az előzmények törlése nélkül.
        </p>
      </section>

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
      {statusMessage ? <div className="status-inline">{statusMessage}</div> : null}

      <div className="two-column-grid">
        <section className="panel">
          <h4 className="card-title">Kiemelt fiók létrehozása</h4>
          <form className="form-grid" onSubmit={handleCreateAccount}>
            <div className="field">
              <label htmlFor="privilegedDisplayName">Megjelenített név</label>
              <input
                id="privilegedDisplayName"
                name="displayName"
                value={formState.displayName}
                onChange={updateField}
                placeholder="Tábori staff"
              />
            </div>
            <div className="field">
              <label htmlFor="privilegedEmail">E-mail</label>
              <input
                id="privilegedEmail"
                name="email"
                type="email"
                value={formState.email}
                onChange={updateField}
                placeholder="staff@example.com"
                autoComplete="email"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="privilegedPassword">Ideiglenes jelszó</label>
              <input
                id="privilegedPassword"
                name="password"
                type="password"
                minLength={6}
                value={formState.password}
                onChange={updateField}
                placeholder="Legalább 6 karakter"
                autoComplete="new-password"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="privilegedRole">Szerepkör</label>
              <select
                id="privilegedRole"
                name="role"
                value={formState.role}
                onChange={updateField}
              >
                {privilegedRoleOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="button-row">
              <button type="submit" className="primary-button" disabled={pending || !actorUid}>
                Fiók létrehozása
              </button>
            </div>
          </form>
        </section>

        <section className="panel">
          <h4 className="card-title">Meglévő kiemelt fiókok</h4>
          <p className="helper-text">
            Itt csak a kiemelt fiókok látszanak. A résztvevői fiókok továbbra is külön önregisztrációval jönnek létre.
          </p>
          <div className="record-list stacked">
            {privilegedAccounts.map((account) => (
              <article key={account.uid} className="order-card">
                <div className="split-header">
                  <div>
                    <strong>{account.displayName || account.email}</strong>
                    <p className="helper-text">{account.email || 'Nincs e-mail'}</p>
                  </div>
                  <div className="pill-row">
                    <span className="event-pill">{account.role}</span>
                    <span className="event-pill">{account.status || ACCOUNT_STATUSES.active}</span>
                  </div>
                </div>

                <div className="button-row">
                  {privilegedRoleOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="secondary-button"
                      disabled={pending || account.status === ACCOUNT_STATUSES.disabled || account.role === option.value}
                      onClick={() => handleRoleChange(account, option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="danger-button"
                    disabled={pending || account.status === ACCOUNT_STATUSES.disabled || account.uid === actorUid}
                    onClick={() => handleDisableAccount(account.uid)}
                  >
                    Letiltás
                  </button>
                </div>
              </article>
            ))}

            {privilegedAccounts.length === 0 ? (
              <p className="helper-text">Még nincs staff vagy admin fiók.</p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
