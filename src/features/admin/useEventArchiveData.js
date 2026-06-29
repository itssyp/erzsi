import { useEffect, useState } from 'react'
import { subscribeLedgerEntriesForEvent } from '../ledger/ledgerService'
import { subscribeToModifierTemplates } from '../modifiers/modifierTemplateService'
import { subscribeOrdersForEvent } from '../orders/orderService'
import { subscribeToPeople } from '../people/personService'
import { subscribeToProducts } from '../products/productService'

// Live data feed for the Események tab. Stats / charts moved to the dedicated
// Statisztika tab — this hook now just wires the raw collections used by the
// event detail view (carry-over health check, catalog counts, etc.).

const initialState = {
  loading: true,
  people: [],
  products: [],
  modifierTemplates: [],
  orders: [],
  ledgerEntries: [],
  error: null,
}

function markResolved(resolved, key, setState) {
  resolved[key] = true

  if (Object.values(resolved).every(Boolean)) {
    setState((current) => ({
      ...current,
      loading: false,
    }))
  }
}

export function useEventArchiveData(eventId) {
  const [state, setState] = useState(initialState)

  useEffect(() => {
    if (!eventId) {
      setState({
        ...initialState,
        loading: false,
      })
      return () => {}
    }

    const resolved = {
      people: false,
      products: false,
      modifierTemplates: false,
      orders: false,
      ledgerEntries: false,
    }

    setState(initialState)

    function handleError(error, key) {
      setState((current) => ({
        ...current,
        loading: false,
        error,
      }))
      markResolved(resolved, key, setState)
    }

    const stopPeople = subscribeToPeople(
      eventId,
      (people) => {
        setState((current) => ({ ...current, people }))
        markResolved(resolved, 'people', setState)
      },
      (error) => handleError(error, 'people'),
    )
    const stopProducts = subscribeToProducts(
      eventId,
      (products) => {
        setState((current) => ({ ...current, products }))
        markResolved(resolved, 'products', setState)
      },
      (error) => handleError(error, 'products'),
    )
    const stopTemplates = subscribeToModifierTemplates(
      eventId,
      (modifierTemplates) => {
        setState((current) => ({ ...current, modifierTemplates }))
        markResolved(resolved, 'modifierTemplates', setState)
      },
      (error) => handleError(error, 'modifierTemplates'),
    )
    const stopOrders = subscribeOrdersForEvent(
      eventId,
      (orders) => {
        setState((current) => ({ ...current, orders }))
        markResolved(resolved, 'orders', setState)
      },
      (error) => handleError(error, 'orders'),
    )
    const stopLedgerEntries = subscribeLedgerEntriesForEvent(
      eventId,
      (ledgerEntries) => {
        setState((current) => ({ ...current, ledgerEntries }))
        markResolved(resolved, 'ledgerEntries', setState)
      },
      (error) => handleError(error, 'ledgerEntries'),
    )

    return () => {
      stopPeople()
      stopProducts()
      stopTemplates()
      stopOrders()
      stopLedgerEntries()
    }
  }, [eventId])

  return state
}
