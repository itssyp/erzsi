import { useEffect, useMemo, useState } from 'react'
import { FOOD_ORDER_STATUSES } from '../orders/orderModels'
import { subscribeFoodOrders, subscribeOrdersForPerson } from '../orders/orderService'
import { splitOrderByStation } from '../kitchen/kitchenStations'
import { countStationTicketsAhead } from '../kitchen/foodQueuePosition'
import { subscribeToActiveEventLink, subscribeToLinkedPerson } from './userService'

const initialState = {
  loading: true,
  link: null,
  person: null,
  orders: [],
  foodQueueOrders: [],
  foodQueueLoaded: false,
  error: null,
}

export function useUserDashboardData({ uid, eventId }) {
  const [state, setState] = useState(initialState)

  useEffect(() => {
    let cancelled = false
    let stopPersonSubscription = () => {}
    let stopOrdersSubscription = () => {}
    let stopFoodQueueSubscription = () => {}

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
        stopFoodQueueSubscription()

        if (!link?.personId) {
          if (!cancelled) {
            setState({
              loading: false,
              link: null,
              person: null,
              orders: [],
              foodQueueOrders: [],
              foodQueueLoaded: false,
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
            person: null,
            orders: [],
            foodQueueOrders: [],
            foodQueueLoaded: false,
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
              foodQueueOrders: [],
              foodQueueLoaded: false,
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

        stopFoodQueueSubscription = subscribeFoodOrders(
          eventId,
          (foodQueueOrders) => {
            if (cancelled) return

            setState((current) => ({
              ...current,
              foodQueueOrders,
              foodQueueLoaded: true,
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
          foodQueueOrders: [],
          foodQueueLoaded: false,
          error,
        })
      },
    )

    return () => {
      cancelled = true
      stopPersonSubscription()
      stopOrdersSubscription()
      stopFoodQueueSubscription()
      stopLinkSubscription()
    }
  }, [uid, eventId])

  const activeFoodOrders = useMemo(() => {
    return state.orders.filter(
      (order) =>
        order.hasFood &&
        order.foodStatus &&
        order.foodStatus !== FOOD_ORDER_STATUSES.delivered,
    )
  }, [state.orders])

  const activeFoodOrdersWithQueues = useMemo(() => {
    const allTickets = state.foodQueueOrders.flatMap(splitOrderByStation)
    return activeFoodOrders.map((order) => ({
      order,
      stations: splitOrderByStation(order).map((ticket) => ({
        station: ticket.station,
        status: ticket.status,
        ordersAhead: state.foodQueueLoaded ? countStationTicketsAhead(ticket, allTickets) : null,
      })),
    }))
  }, [activeFoodOrders, state.foodQueueOrders, state.foodQueueLoaded])

  return {
    ...state,
    activeFoodOrdersWithQueues,
    hasLinkedPerson: Boolean(state.link?.personId && state.person),
  }
}
