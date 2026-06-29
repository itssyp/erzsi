import { useEffect, useMemo, useState } from 'react'
import { FOOD_ORDER_STATUSES } from '../orders/orderModels'
import { subscribeFoodOrders, subscribeOrdersForPerson } from '../orders/orderService'
import { subscribeToActiveEventLink, subscribeToLinkedPerson } from './userService'

const initialState = {
  loading: true,
  link: null,
  person: null,
  orders: [],
  foodQueueOrders: [],
  error: null,
}

const FOOD_QUEUE_STATUS_RANK = {
  [FOOD_ORDER_STATUSES.preparing]: 0,
  [FOOD_ORDER_STATUSES.new]: 1,
  [FOOD_ORDER_STATUSES.ready]: 2,
  [FOOD_ORDER_STATUSES.delivered]: 3,
}

function getOrderTimeMs(order) {
  return order?.createdAt?.toMillis?.() || 0
}

function countOrdersAhead(activeOrder, foodQueueOrders) {
  if (!activeOrder || activeOrder.foodStatus === FOOD_ORDER_STATUSES.ready) {
    return 0
  }

  const activeStatus = activeOrder.foodStatus || FOOD_ORDER_STATUSES.new
  const activeRank = FOOD_QUEUE_STATUS_RANK[activeStatus] ?? FOOD_QUEUE_STATUS_RANK[FOOD_ORDER_STATUSES.new]
  const activeTime = getOrderTimeMs(activeOrder)

  return (foodQueueOrders || []).filter((order) => {
    if (order.id === activeOrder.id) return false

    const status = order.foodStatus || FOOD_ORDER_STATUSES.new
    if (status === FOOD_ORDER_STATUSES.ready || status === FOOD_ORDER_STATUSES.delivered) return false

    const rank = FOOD_QUEUE_STATUS_RANK[status] ?? FOOD_QUEUE_STATUS_RANK[FOOD_ORDER_STATUSES.new]
    if (rank < activeRank) return true
    if (rank > activeRank) return false

    return getOrderTimeMs(order) < activeTime
  }).length
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
              foodQueueOrders: [],
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

  const activeFoodOrder = useMemo(() => {
    return state.orders.find(
      (order) =>
        order.hasFood &&
        order.foodStatus &&
        order.foodStatus !== FOOD_ORDER_STATUSES.delivered,
    ) || null
  }, [state.orders])

  const activeFoodOrdersAhead = useMemo(
    () => countOrdersAhead(activeFoodOrder, state.foodQueueOrders),
    [activeFoodOrder, state.foodQueueOrders],
  )

  return {
    ...state,
    activeFoodOrder,
    activeFoodOrdersAhead,
    hasLinkedPerson: Boolean(state.link?.personId && state.person),
  }
}
