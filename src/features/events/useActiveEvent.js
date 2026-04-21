import { useContext } from 'react'
import { ActiveEventContext } from './ActiveEventProvider'

export function useActiveEvent() {
  const context = useContext(ActiveEventContext)

  if (!context) {
    throw new Error('useActiveEvent must be used inside ActiveEventProvider')
  }

  return context
}
