import { Link } from 'react-router-dom'
import { getDefaultRouteForRole } from '../../lib/roles'
import { useAuth } from '../auth/useAuth'

export function NotFoundPage() {
  const { user, role } = useAuth()

  return (
    <div className="loading-screen">
      <div className="loading-card">
        <h2 className="card-title">Az oldal nem található</h2>
        <p className="helper-text">Ez az útvonal nem létezik a jelenlegi MVP felületen.</p>
        <div className="button-row" style={{ justifyContent: 'center' }}>
          <Link className="primary-button" to={user ? getDefaultRouteForRole(role) : '/login'}>
            Vissza
          </Link>
        </div>
      </div>
    </div>
  )
}
