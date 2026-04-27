import { useEffect, useMemo, useState } from 'react'
import { FOOD_ORDER_STATUSES } from '../orders/orderModels'
import { subscribeFoodOrders } from '../orders/orderService'
import { estimateWaitMinutes, formatWaitTime, getWorkloadLevel } from './kitchenModels'

export function useKitchenWorkload(eventId) {
  const [orders, setOrders] = useState([])
  const [workloadError, setWorkloadError] = useState(null)

  useEffect(() => {
    if (!eventId) return
    setWorkloadError(null)
    return subscribeFoodOrders(eventId, setOrders, (error) => {
      console.error('Workload subscription error:', error)
      setWorkloadError(error)
    })
  }, [eventId])

  const workload = useMemo(() => {
    const countItems = (order) =>
      order.lines?.filter((l) => l.category === 'food').reduce((s, l) => s + (l.quantity || 0), 0) ?? 0

    const newOrders      = orders.filter((o) => (o.foodStatus || FOOD_ORDER_STATUSES.new) === FOOD_ORDER_STATUSES.new)
    const preparingOrders = orders.filter((o) => o.foodStatus === FOOD_ORDER_STATUSES.preparing)

    const newItems       = newOrders.reduce((s, o) => s + countItems(o), 0)
    const preparingItems = preparingOrders.reduce((s, o) => s + countItems(o), 0)
    const activeItems    = newItems + preparingItems
    const estimatedMinutes = estimateWaitMinutes(newItems, preparingItems)

    return {
      ...getWorkloadLevel(activeItems),
      itemCount: activeItems,
      newItems,
      preparingItems,
      estimatedMinutes,
      formattedWait: formatWaitTime(estimatedMinutes),
    }
  }, [orders])

  return { ...workload, workloadError }
}
