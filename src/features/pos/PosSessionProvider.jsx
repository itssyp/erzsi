import { createContext, useCallback, useMemo, useState } from 'react'

const PosSessionContext = createContext(null)

export function PosSessionProvider({ children }) {
  const [activeBasket, setActiveBasket] = useState(null)

  const registerActiveBasket = useCallback((nextBasket) => {
    setActiveBasket(nextBasket)
  }, [])

  const clearActiveBasket = useCallback(() => {
    setActiveBasket(null)
  }, [])

  const value = useMemo(() => ({
    activeBasket,
    hasActiveBasket: Boolean(activeBasket),
    registerActiveBasket,
    clearActiveBasket,
  }), [activeBasket, registerActiveBasket, clearActiveBasket])

  return <PosSessionContext.Provider value={value}>{children}</PosSessionContext.Provider>
}

export { PosSessionContext }
