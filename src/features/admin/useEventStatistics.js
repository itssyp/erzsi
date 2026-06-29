import { useEffect, useMemo, useState } from 'react'
import { subscribeOrdersForEvent } from '../orders/orderService'
import { subscribeLedgerEntriesForEvent } from '../ledger/ledgerService'
import { subscribeToPeople } from '../people/personService'
import { subscribeToProducts } from '../products/productService'
import { buildStatistics, emptyBucket } from './eventAnalyticsHelpers'

const initialState = {
  orders: [],
  ledgerEntries: [],
  people: [],
  products: [],
  errors: {},
  resolved: {
    orders: false,
    ledgerEntries: false,
    people: false,
    products: false,
  },
}

/**
 * Live event statistics for a single event. Subscribes to orders, ledger
 * entries, people and products and recomputes aggregate + per-day buckets
 * whenever any underlying collection changes.
 *
 * Returns {
 *   loading: boolean,
 *   errors: { orders?, ledgerEntries?, people?, products? },
 *   aggregate: Bucket,            // whole-event totals (always available, may be empty)
 *   daily: Bucket[],              // sorted by date asc
 *   byDate: Map<dateISO, Bucket>, // for fast lookup
 *   eventDays: string[],          // dates that have at least one order
 *   people: Person[],
 *   products: Product[],
 * }
 */
export function useEventStatistics(eventId) {
  const [state, setState] = useState(initialState)

  useEffect(() => {
    if (!eventId) {
      setState(initialState)
      return undefined
    }

    setState(initialState)

    function update(key, value) {
      setState((prev) => ({
        ...prev,
        [key]: value,
        resolved: { ...prev.resolved, [key]: true },
      }))
    }

    function fail(key, error) {
      setState((prev) => ({
        ...prev,
        errors: { ...prev.errors, [key]: error.message || String(error) },
        resolved: { ...prev.resolved, [key]: true },
      }))
    }

    const stopOrders = subscribeOrdersForEvent(
      eventId,
      (orders) => update('orders', orders),
      (error) => fail('orders', error),
    )
    const stopLedger = subscribeLedgerEntriesForEvent(
      eventId,
      (ledgerEntries) => update('ledgerEntries', ledgerEntries),
      (error) => fail('ledgerEntries', error),
    )
    const stopPeople = subscribeToPeople(
      eventId,
      (people) => update('people', people),
      (error) => fail('people', error),
    )
    const stopProducts = subscribeToProducts(
      eventId,
      (products) => update('products', products),
      (error) => fail('products', error),
    )

    return () => {
      stopOrders?.()
      stopLedger?.()
      stopPeople?.()
      stopProducts?.()
    }
  }, [eventId])

  const computed = useMemo(() => {
    if (!eventId) {
      return {
        aggregate: emptyBucket(),
        daily: [],
        byDate: new Map(),
        eventDays: [],
      }
    }
    return buildStatistics({
      orders: state.orders,
      ledgerEntries: state.ledgerEntries,
      people: state.people,
    })
  }, [eventId, state.orders, state.ledgerEntries, state.people])

  const loading = eventId
    ? !(state.resolved.orders && state.resolved.ledgerEntries && state.resolved.people && state.resolved.products)
    : false

  return {
    loading,
    errors: state.errors,
    aggregate: computed.aggregate,
    daily: computed.daily,
    byDate: computed.byDate,
    eventDays: computed.eventDays,
    people: state.people,
    products: state.products,
  }
}
