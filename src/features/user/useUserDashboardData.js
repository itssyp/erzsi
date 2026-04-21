import { useEffect, useMemo, useState } from 'react'
import { FOOD_ORDER_STATUSES } from '../orders/orderModels'
import { subscribeOrdersForPerson } from '../orders/orderService'
import { subscribeToActiveEventLink, subscribeToLinkedPerson } from './userService'

const initialState = {
  loading: true,
  link: null,
  person: null,
  orders: [],
  error: null,
}

export function useUserDashboardData({ uid, eventId }) {
  const [state, setState] = useState(initialState)

  useEffect(() => {
    let cancelled = false
    let stopPersonSubscription = () => {}
    let stopOrdersSubscription = () => {}

    if (!uid || !eventId) {
      setState(initialState)
      return () => {}
    }

    const stopLinkSubscription = subscribeToActiveEventLink(
      uid,
      eventId,
      (link) => {
        stopPersonSubscription()
        stopOrdersSubscription()

        if (!link?.personId) {
          if (!cancelled) {
            setState({
              loading: false,
              link: null,
              person: null,
              orders: [],
              error: null,
            })
          }
          return
        }

        if (!cancelled) {
          setState((current) => ({
            ...current,
            loading: true,
            link,
            error: null,
          }))
        }

        stopPersonSubscription = subscribeToLinkedPerson(
          eventId,
          link.personId,
          (person) => {
            if (cancelled) return

            setState((current) => ({
              ...current,
              loading: false,
              link,
              person,
              error: null,
            }))
          },
          (error) => {
            if (cancelled) return

            setState({
              loading: false,
              link,
              person: null,
              orders: [],
              error,
            })
          },
        )

        stopOrdersSubscription = subscribeOrdersForPerson(
          eventId,
          link.personId,
          (orders) => {
            if (cancelled) return

            setState((current) => ({
              ...current,
              orders,
              error: null,
            }))
          },
          (error) => {
            if (cancelled) return

            setState((current) => ({
              ...current,
              error,
            }))
          },
        )
      },
      (error) => {
        if (cancelled) return

        setState({
          loading: false,
          link: null,
          person: null,
          orders: [],
          error,
        })
      },
    )

    return () => {
      cancelled = true
      stopPersonSubscription()
      stopOrdersSubscription()
      stopLinkSubscription()
    }
  }, [uid, eventId])

  const activeFoodOrder = useMemo(() => {
    return state.orders.find(
      (order) =>
        order.hasFood &&
        order.foodStatus &&
        order.foodStatus !== FOOD_ORDER_STATUSES.delivered,
    ) || null
  }, [state.orders])

  return {
    ...state,
    activeFoodOrder,
    hasLinkedPerson: Boolean(state.link?.personId && state.person),
  }
}
