import { createContext, useEffect, useState, useMemo } from 'react'
import { subscribeToActiveEvent, subscribeToRuntime } from './eventService'
import { useAuth } from '../auth/useAuth'

const ActiveEventContext = createContext(null)

const initialState = {
  loading: true,
  runtime: null,
  activeEventId: null,
  activeEvent: null,
  error: null,
}

export function ActiveEventProvider({ children }) {
  const { user } = useAuth()
  const [state, setState] = useState(initialState)

  useEffect(() => {
    let cancelled = false
    let stopEventSubscription = () => { }

    if (!user) {
      setState({
        loading: false,
        runtime: null,
        activeEventId: null,
        activeEvent: null,
        error: null,
      })

      return () => { }
    }

    const stopRuntimeSubscription = subscribeToRuntime(
      (runtime) => {
        stopEventSubscription()

        const activeEventId = runtime?.activeEventId || null

        if (!activeEventId) {
          if (!cancelled) {
            setState({
              loading: false,
              runtime,
              activeEventId: null,
              activeEvent: null,
              error: null,
            })
          }

          return
        }

        if (!cancelled) {
          setState((current) => ({
            ...current,
            loading: true,
            runtime,
            activeEventId,
            error: null,
          }))
        }

        stopEventSubscription = subscribeToActiveEvent(
          activeEventId,
          (activeEvent) => {
            if (cancelled) return

            setState({
              loading: false,
              runtime,
              activeEventId,
              activeEvent,
              error: null,
            })
          },
          (error) => {
            if (cancelled) return

            setState({
              loading: false,
              runtime,
              activeEventId,
              activeEvent: null,
              error,
            })
          },
        )
      },
      (error) => {
        if (cancelled) return

        setState({
          loading: false,
          runtime: null,
          activeEventId: null,
          activeEvent: null,
          error,
        })
      },
    )

    return () => {
      cancelled = true
      stopEventSubscription()
      stopRuntimeSubscription()
    }
  }, [user])

  const value = useMemo(() => ({
    ...state,
    hasActiveEvent: Boolean(state.activeEventId),
  }), [state])

  return <ActiveEventContext.Provider value={value}>{children}</ActiveEventContext.Provider>
}

export { ActiveEventContext }
