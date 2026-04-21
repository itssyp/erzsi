import { Navigate, useLocation } from 'react-router-dom'
import { LoadingScreen } from '../components/LoadingScreen'
import { StatusCard } from '../components/StatusCard'
import { useAuth } from '../features/auth/useAuth'
import { useActiveEvent } from '../features/events/useActiveEvent'
import { getDefaultRouteForRole } from '../lib/roles'

export function AuthRedirect({ children }) {
  const { initializing, user, role } = useAuth()

  if (initializing) {
    return <LoadingScreen label="Munkamenet ellenőrzése" />
  }

  if (user) {
    return <Navigate to={getDefaultRouteForRole(role)} replace />
  }

  return children
}

export function RequireAuth({ children }) {
  const { initializing, user } = useAuth()
  const location = useLocation()

  if (initializing) {
    return <LoadingScreen label="Fiók betöltése" />
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return children
}

export function RequireRole({ allowedRoles, children }) {
  const { role } = useAuth()

  if (!allowedRoles.includes(role)) {
    return <Navigate to={getDefaultRouteForRole(role)} replace />
  }

  return children
}

export function RequireActiveEvent({ allowAdminWithoutEvent = false, children }) {
  const { role } = useAuth()
  const { loading, activeEventId } = useActiveEvent()

  if (loading) {
    return <LoadingScreen label="Aktív esemény betöltése" />
  }

  if (activeEventId) {
    return children
  }

  if (allowAdminWithoutEvent && role === 'admin') {
    return children
  }

  return (
    <StatusCard
      title="Nincs aktív esemény"
      tone="warning"
      body="A működő oldalak addig zárolva maradnak, amíg egy admin létre nem hozza és aktiválja a következő tábort."
    />
  )
}

export function RoleHomeRedirect() {
  const { role } = useAuth()

  return <Navigate to={getDefaultRouteForRole(role)} replace />
}
