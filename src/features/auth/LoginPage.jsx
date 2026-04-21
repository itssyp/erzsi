import { useState } from 'react'
import InstallPWAButton from '../../components/InstallPWAButton'
import { registerUser, signInWithPassword } from './authService'
import { useAuth } from './useAuth'

const LOGO_SRC = '/kasszas_erzsi_nobg.png'

function getAuthMessage(error) {
  switch (error?.code) {
    case 'auth/email-already-in-use':
      return 'Ez az e-mail-cím már regisztrálva van. Használd inkább a bejelentkezés fület.'
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Hibás e-mail-cím vagy jelszó.'
    case 'auth/weak-password':
      return 'Válassz erősebb jelszót, legalább 6 karakterrel.'
    default:
      return error?.message || 'A hitelesítés sikertelen volt. Próbáld újra.'
  }
}

export function LoginPage() {
  const { authError } = useAuth()
  const [mode, setMode] = useState('signin')
  const [formState, setFormState] = useState({
    email: '',
    password: '',
    displayName: '',
  })
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  function updateField(event) {
    setFormState((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setPending(true)
    setErrorMessage('')

    try {
      if (mode === 'register') {
        await registerUser(formState)
      } else {
        await signInWithPassword(formState)
      }
    } catch (error) {
      setErrorMessage(getAuthMessage(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="login-layout">
      <section className="login-hero">
        <div className="login-logo-shell">
          <img className="login-logo" src={LOGO_SRC} alt="Kasszas Erzsi logo" />
        </div>

        <div className="login-hero-copy">
          <span className="eyebrow">Kasszas Erzsi</span>
          <h1 className="hero-title">Egyszerű tábori kasszarendszer.</h1>
          <p>Jelentkezz be a rendelések, egyenlegek és a konyhai folyamatok kezeléséhez.</p>
        </div>

        <div className="login-actions">
          <InstallPWAButton />
        </div>
      </section>

      <section className="login-panel">
        <div className="auth-toggle">
          <button
            type="button"
            className={mode === 'signin' ? 'active' : ''}
            onClick={() => setMode('signin')}
          >
            Bejelentkezés
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'active' : ''}
            onClick={() => setMode('register')}
          >
            Regisztráció
          </button>
        </div>

        <div>
          <h2>{mode === 'register' ? 'Fiók létrehozása' : 'Bejelentkezés'}</h2>
          <p className="helper-text login-panel-copy">
            {mode === 'register'
              ? 'Hozd létre a résztvevői fiókodat.'
              : 'Add meg az e-mail-címedet és a jelszavadat.'}
          </p>
        </div>

        {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
        {authError ? <div className="error-banner">{authError.message}</div> : null}

        <form className="form-grid" onSubmit={handleSubmit}>
          {mode === 'register' ? (
            <div className="field">
              <label htmlFor="displayName">Neved</label>
              <input
                id="displayName"
                name="displayName"
                value={formState.displayName}
                onChange={updateField}
                placeholder="Teljes név"
                required
              />
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="email">E-mail</label>
            <input
              id="email"
              name="email"
              type="email"
              value={formState.email}
              onChange={updateField}
              placeholder="name@example.com"
              autoComplete="email"
              required
            />
          </div>

          <div className="field">
            <label htmlFor="password">Jelszó</label>
            <input
              id="password"
              name="password"
              type="password"
              value={formState.password}
              onChange={updateField}
              placeholder="Jelszó"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              minLength={6}
              required
            />
          </div>

          <button type="submit" className="primary-button" style={{ marginTop: '4px' }} disabled={pending}>
            {pending ? 'Folyamatban...' : mode === 'register' ? 'Fiók létrehozása' : 'Bejelentkezés'}
          </button>
        </form>
      </section>
    </div>
  )
}
