import { AuthProvider } from '../features/auth/AuthProvider'
import { ActiveEventProvider } from '../features/events/ActiveEventProvider'
import { PosSessionProvider } from '../features/pos/PosSessionProvider'
import { AppRoutes } from './AppRoutes'

export function AppProviders() {
  return (
    <AuthProvider>
      <ActiveEventProvider>
        <PosSessionProvider>
          <AppRoutes />
        </PosSessionProvider>
      </ActiveEventProvider>
    </AuthProvider>
  )
}
