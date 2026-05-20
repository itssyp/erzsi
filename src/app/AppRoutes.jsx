import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './AppShell'
import {
  AuthRedirect,
  RequireActiveEvent,
  RequireAuth,
  RequireRole,
  RoleHomeRedirect,
} from './RouteGuards'
import { ALL_ROLES, ROLES } from '../lib/roles'
import { LoginPage } from '../features/auth/LoginPage'
import { AdminDashboardPage } from '../features/dashboard/AdminDashboardPage'
import { CatalogManagementPage } from '../features/dashboard/CatalogManagementPage'
import { NotFoundPage } from '../features/dashboard/NotFoundPage'
import { QrLandingPage } from '../features/dashboard/QrLandingPage'
import { StaffDashboardPage } from '../features/dashboard/StaffDashboardPage'
import { TopupPage } from '../features/dashboard/TopupPage'
import { UserDashboardPage } from '../features/dashboard/UserDashboardPage'

export function AppRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={
            <AuthRedirect>
              <LoginPage />
            </AuthRedirect>
          }
        />
        <Route path="/qr/:qrCode" element={<QrLandingPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<RoleHomeRedirect />} />
          <Route
            path="app"
            element={
              <RequireRole allowedRoles={ALL_ROLES}>
                <RequireActiveEvent>
                  <UserDashboardPage />
                </RequireActiveEvent>
              </RequireRole>
            }
          />
          <Route
            path="staff"
            element={
              <RequireRole allowedRoles={[ROLES.staff, ROLES.posStaff, ROLES.admin]}>
                <RequireActiveEvent>
                  <StaffDashboardPage mode="sell" />
                </RequireActiveEvent>
              </RequireRole>
            }
          />
          <Route
            path="staff/kitchen"
            element={
              <RequireRole allowedRoles={[ROLES.staff, ROLES.posStaff, ROLES.admin]}>
                <RequireActiveEvent>
                  <StaffDashboardPage mode="kitchen" />
                </RequireActiveEvent>
              </RequireRole>
            }
          />
          <Route
            path="catalog"
            element={
              <RequireRole allowedRoles={[ROLES.staff, ROLES.admin]}>
                <RequireActiveEvent>
                  <CatalogManagementPage />
                </RequireActiveEvent>
              </RequireRole>
            }
          />
          <Route
            path="topup"
            element={
              <RequireRole allowedRoles={[ROLES.admin, ROLES.topupStaff]}>
                <RequireActiveEvent>
                  <TopupPage />
                </RequireActiveEvent>
              </RequireRole>
            }
          />
          <Route
            path="admin"
            element={
              <RequireRole allowedRoles={[ROLES.admin]}>
                <RequireActiveEvent allowAdminWithoutEvent>
                  <AdminDashboardPage />
                </RequireActiveEvent>
              </RequireRole>
            }
          />
        </Route>
        <Route path="/index.html" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  )
}
