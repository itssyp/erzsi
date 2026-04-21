import { useContext } from 'react'
import { PosSessionContext } from './PosSessionProvider'

export function usePosSession() {
  const value = useContext(PosSessionContext)

  if (!value) {
    throw new Error('usePosSession must be used inside PosSessionProvider')
  }

  return value
}
