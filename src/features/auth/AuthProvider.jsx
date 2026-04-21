import { createContext, useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from '../../lib/firebase'
import { ROLES, getRoleFromClaims, isStaffLike } from '../../lib/roles'
import { bootstrapPrivilegedSession, getSessionClaims } from './authService'
import { ensureAccountDocument, subscribeToAccount } from './accountService'

const AuthContext = createContext(null)

const initialState = {
  initializing: true,
  user: null,
  account: null,
  role: null,
  claims: null,
  authError: null,
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(initialState)

  useEffect(() => {
    let cancelled = false
    let stopAccountSubscription = () => {}

    const stopAuthSubscription = onAuthStateChanged(auth, async (nextUser) => {
      stopAccountSubscription()

      if (!nextUser) {
        if (!cancelled) {
          setSession({
            initializing: false,
            user: null,
            account: null,
            role: null,
            claims: null,
            authError: null,
          })
        }

        return
      }

      if (!cancelled) {
        setSession((current) => ({
          ...current,
          initializing: true,
          user: nextUser,
          authError: null,
        }))
      }

      try {
        await bootstrapPrivilegedSession()
        const claims = await getSessionClaims(nextUser, true)
        const claimsRole = getRoleFromClaims(claims)

        await ensureAccountDocument(nextUser, claimsRole || ROLES.user)

        stopAccountSubscription = subscribeToAccount(
          nextUser.uid,
          (account) => {
            if (cancelled) return

            setSession({
              initializing: false,
              user: nextUser,
              account,
              role: account?.role || claimsRole || ROLES.user,
              claims,
              authError: null,
            })
          },
          (error) => {
            if (cancelled) return

            setSession({
              initializing: false,
              user: nextUser,
              account: null,
              role: claimsRole || ROLES.user,
              claims,
              authError: error,
            })
          },
        )
      } catch (error) {
        if (cancelled) return

        setSession({
          initializing: false,
          user: nextUser,
          account: null,
          role: ROLES.user,
          claims: null,
          authError: error,
        })
      }
    })

    return () => {
      cancelled = true
      stopAccountSubscription()
      stopAuthSubscription()
    }
  }, [])

  const value = {
    ...session,
    isAuthenticated: Boolean(session.user),
    isAdmin: session.role === ROLES.admin,
    isStaffLike: isStaffLike(session.role),
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export { AuthContext }
