import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useBeforeUnload, useLocation, useNavigate } from 'react-router-dom'
import { signOutUser } from '../features/auth/authService'
import { useAuth } from '../features/auth/useAuth'
import { useActiveEvent } from '../features/events/useActiveEvent'
import { usePosSession } from '../features/pos/usePosSession'
import { isStaffLike } from '../lib/roles'

const LOGO_SRC = '/kasszas_erzsi_nobg.png'

const PAGE_TITLES = {
  '/app': 'Saját irányítópult',
  '/staff': 'Pult',
  '/staff/kitchen': 'Konyha',
  '/catalog': 'Katalógus',
  '/admin': 'Admin',
}

export function AppShell() {
  const { role, account, user } = useAuth()
  const { activeEvent, activeEventId } = useActiveEvent()
  const { activeBasket, hasActiveBasket } = usePosSession()
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isHeaderHidden, setIsHeaderHidden] = useState(false)
  const [promptMode, setPromptMode] = useState(null)
  const [pendingDestination, setPendingDestination] = useState('')
  const [actionPending, setActionPending] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const headerWrapperRef = useRef(null)

  const signedInLabel = account?.displayName || user?.displayName || user?.email
  const avatarInitial = (signedInLabel || 'F')[0].toUpperCase()
  const pageTitle = PAGE_TITLES[location.pathname] || ''
  const eventLabel = activeEvent?.name || activeEventId
  const activeBasketSnapshot = activeBasket?.getSnapshot?.() || activeBasket

  useEffect(() => {
    setIsMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return
      if (!e.shiftKey) return

      if (e.key === 'F' || e.key === 'f') {
        e.preventDefault()
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {})
        } else {
          document.exitFullscreen()
        }
      }

      if (e.key === 'H' || e.key === 'h') {
        e.preventDefault()
        setIsHeaderHidden((v) => !v)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useBeforeUnload((event) => {
    if (!hasActiveBasket) {
      return
    }

    event.preventDefault()
    event.returnValue = ''
  })

  const menuLinks = useMemo(() => {
    const links = []
    if (role === 'user') links.push({ to: '/app', label: 'Saját irányítópult' })
    if (isStaffLike(role)) {
      links.push({ to: '/staff', label: 'Pult' })
      links.push({ to: '/staff/kitchen', label: 'Konyha' })
      links.push({ to: '/catalog', label: 'Katalógus' })
    }
    if (role === 'admin') links.push({ to: '/admin', label: 'Admin' })
    return links
  }, [role])

  async function resolveActiveBasket(action) {
    if (!activeBasket) {
      return false
    }

    setActionPending(true)

    try {
      await action()
      return true
    } finally {
      setActionPending(false)
    }
  }

  async function handleCancelAndContinue() {
    if (!activeBasket) {
      return
    }

    const completed = await resolveActiveBasket(activeBasket.cancelBasket)

    if (!completed) {
      return
    }

    setPromptMode(null)

    if (promptMode === 'navigation' && pendingDestination) {
      const destination = pendingDestination
      setPendingDestination('')
      navigate(destination)
      return
    }

    if (promptMode === 'signout') {
      await signOutUser()
    }
  }

  async function handleFinalizeAndContinue() {
    if (!activeBasketSnapshot?.canFinalize) {
      return
    }

    const completed = await resolveActiveBasket(activeBasket.finalizeBasket)

    if (!completed) {
      return
    }

    setPromptMode(null)

    if (promptMode === 'navigation' && pendingDestination) {
      const destination = pendingDestination
      setPendingDestination('')
      navigate(destination)
      return
    }

    if (promptMode === 'signout') {
      await signOutUser()
    }
  }

  function handleStayOnPage() {
    setPromptMode(null)
    setPendingDestination('')
  }

  function handleSignOutClick() {
    if (!hasActiveBasket) {
      signOutUser()
      return
    }

    setPromptMode('signout')
    setIsMenuOpen(false)
  }

  function handleMenuNavigation(event, to) {
    if (location.pathname === to) {
      return
    }

    if (!hasActiveBasket) {
      return
    }

    event.preventDefault()
    setPendingDestination(to)
    setPromptMode('navigation')
    setIsMenuOpen(false)
  }

  return (
    <div className={`app-shell${isHeaderHidden ? ' header-hidden' : ''}`}>
      {/* Collapsible header wrapper — height animates to 0 when hidden */}
      <div className="app-header-wrapper" ref={headerWrapperRef}>
        <header className="app-header">
          <button
            className="menu-toggle"
            onClick={() => setIsMenuOpen(true)}
            aria-label="Menü megnyitása"
          >
            &#9776;
          </button>
          <img className="app-brand-logo" src={LOGO_SRC} alt="Kasszas Erzsi logo" />
          {pageTitle && (
            <>
              <span className="app-header-sep" aria-hidden="true" />
              <span className="app-header-title">{pageTitle}</span>
            </>
          )}
          <span className="app-header-spacer" />
          <span className={`event-badge${!eventLabel ? ' no-event' : ''}`}>
            {eventLabel || 'Nincs aktív esemény'}
          </span>
          <button
            className="header-collapse-btn"
            onClick={() => setIsHeaderHidden(true)}
            aria-label="Navigációs sáv elrejtése (Shift+H)"
            title="Navigációs sáv elrejtése - Shift+H"
          >
            ▲
          </button>
        </header>
      </div>

      {/* Pull tab — only interactive when header is hidden */}
      <div
        className="header-pull-tab"
        role="button"
        tabIndex={isHeaderHidden ? 0 : -1}
        aria-label="Navigációs sáv megjelenítése (Shift+H)"
        onClick={() => setIsHeaderHidden(false)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setIsHeaderHidden(false) }}
      >
        <span className="header-pull-handle">
          <span className="header-pull-icon">▼</span>
        </span>
      </div>

      <div
        className={`sidebar-overlay ${isMenuOpen ? 'visible' : ''}`}
        onClick={() => setIsMenuOpen(false)}
      />

      <aside className={`app-sidebar ${isMenuOpen ? 'open' : ''}`}>
        <div className="sidebar-logo">
          <img className="sidebar-brand-logo" src={LOGO_SRC} alt="Kasszas Erzsi logo" />
          <button className="menu-toggle" onClick={() => setIsMenuOpen(false)} aria-label="Menü bezárása">
            &times;
          </button>
        </div>

        <nav className="sidebar-nav">
          {menuLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
              onClick={(event) => handleMenuNavigation(event, link.to)}
            >
              <span>{link.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-user-avatar">{avatarInitial}</div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">{signedInLabel}</div>
              <div className="sidebar-user-role">{role}</div>
            </div>
          </div>
          <button
            type="button"
            className="danger-button"
            style={{ width: '100%' }}
            onClick={handleSignOutClick}
          >
            Kijelentkezés
          </button>
        </div>
      </aside>

      <main className="app-main">
        <div className="app-main-content">
          <Outlet />
        </div>
      </main>

      {promptMode ? (
        <div className="nav-guard-overlay">
          <div className="nav-guard-dialog floating-overlay">
            <span className="eyebrow">Aktív rendelés</span>
            <h3 className="card-title">Még nyitva van egy kosár</h3>
            <p className="helper-text">
              {activeBasketSnapshot?.personDisplayName
                ? `${activeBasketSnapshot.personDisplayName} számára még aktív kosár van ezen az eszközön.`
                : 'Ezen az eszközön még van egy aktív kosár.'}
            </p>
            <p className="helper-text">
              Az oldal elhagyása előtt töröld vagy zárd le a kosarat.
            </p>
            <div className="detail-list">
              <div className="event-pill">Tételek: {activeBasketSnapshot?.itemCount || 0}</div>
            </div>
            <div className="button-row">
              <button type="button" className="secondary-button" onClick={handleStayOnPage} disabled={actionPending}>
                Maradok
              </button>
              <button type="button" className="danger-button" onClick={handleCancelAndContinue} disabled={actionPending}>
                {actionPending ? 'Folyamatban...' : 'Kosár törlése'}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={handleFinalizeAndContinue}
                disabled={actionPending || !activeBasketSnapshot?.canFinalize}
              >
                {actionPending ? 'Folyamatban...' : 'Rendelés lezárása'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
