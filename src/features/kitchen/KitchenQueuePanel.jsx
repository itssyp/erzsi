import { useEffect, useMemo, useRef, useState } from 'react'
import { FOOD_ORDER_STATUSES } from '../orders/orderModels'
import { subscribeFoodOrders, updateFoodOrderStatus } from '../orders/orderService'
import { useActiveEvent } from '../events/useActiveEvent'
import { setKitchenClosedStatus } from '../events/eventService'
import { estimateWaitMinutes, formatWaitTime, getWorkloadLevel } from './kitchenModels'

const nextStatusMap = {
  [FOOD_ORDER_STATUSES.new]: FOOD_ORDER_STATUSES.preparing,
  [FOOD_ORDER_STATUSES.preparing]: FOOD_ORDER_STATUSES.ready,
  [FOOD_ORDER_STATUSES.ready]: FOOD_ORDER_STATUSES.delivered,
  [FOOD_ORDER_STATUSES.delivered]: null,
}

const actionLabelMap = {
  [FOOD_ORDER_STATUSES.new]: 'Elkészítes indítása',
  [FOOD_ORDER_STATUSES.preparing]: 'Késznek jelölés',
  [FOOD_ORDER_STATUSES.ready]: 'Átadottnak jelölés',
  [FOOD_ORDER_STATUSES.delivered]: '',
}

const statusLabelMap = {
  [FOOD_ORDER_STATUSES.new]: 'Új',
  [FOOD_ORDER_STATUSES.preparing]: 'Készül',
  [FOOD_ORDER_STATUSES.ready]: 'Elkészült',
  [FOOD_ORDER_STATUSES.delivered]: 'Átadva',
}

const COLUMNS = [
  { status: FOOD_ORDER_STATUSES.new, label: 'Új', colClass: 'kds-col-new' },
  { status: FOOD_ORDER_STATUSES.preparing, label: 'Készül', colClass: 'kds-col-preparing' },
  { status: FOOD_ORDER_STATUSES.ready, label: 'Elkészült', colClass: 'kds-col-ready' },
  { status: FOOD_ORDER_STATUSES.delivered, label: 'Átadva', colClass: 'kds-col-delivered' },
]

const DELIVERED_HIDE_MS = 90 * 1000

function formatTimestamp(value) {
  if (!value?.toDate) return 'Függőben...'
  return value.toDate().toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
}

function getMinutesOpen(createdAt) {
  if (!createdAt?.toDate) return null
  return Math.max(0, Math.round((Date.now() - createdAt.toDate().getTime()) / 60000))
}

function getMillis(value) {
  if (!value?.toDate) return 0
  return value.toDate().getTime()
}

function isLate(status, minutesOpen) {
  return status !== FOOD_ORDER_STATUSES.delivered &&
    status !== FOOD_ORDER_STATUSES.ready &&
    (minutesOpen || 0) >= 12
}

export function KitchenQueuePanel({ eventId, actorUid, actorName }) {
  const { activeEvent } = useActiveEvent()
  const [orders, setOrders] = useState([])
  const [errorMessage, setErrorMessage] = useState('')
  const [kitchenPending, setKitchenPending] = useState(false)
  const [pendingOrderId, setPendingOrderId] = useState('')
  const [selectedOrderId, setSelectedOrderId] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const boardRef = useRef(null)
  const statusChangeRef = useRef(async () => {})

  useEffect(() => {
    return subscribeFoodOrders(eventId, setOrders, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === boardRef.current)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 15000)
    return () => window.clearInterval(timer)
  }, [])

  const visibleOrders = useMemo(() => {
    return orders.filter((order) => {
      const status = order.foodStatus || FOOD_ORDER_STATUSES.new
      if (status !== FOOD_ORDER_STATUSES.delivered) return true
      const updatedAtMs = getMillis(order.foodStatusUpdatedAt || order.updatedAt)
      return nowMs - updatedAtMs < DELIVERED_HIDE_MS
    })
  }, [nowMs, orders])

  const sortedOrders = useMemo(() => {
    return [...visibleOrders].sort((a, b) => getMillis(a.createdAt) - getMillis(b.createdAt))
  }, [visibleOrders])

  const ordersByStatus = useMemo(() => {
    const groups = {
      [FOOD_ORDER_STATUSES.new]: [],
      [FOOD_ORDER_STATUSES.preparing]: [],
      [FOOD_ORDER_STATUSES.ready]: [],
      [FOOD_ORDER_STATUSES.delivered]: [],
    }
    sortedOrders.forEach((order) => {
      const status = order.foodStatus || FOOD_ORDER_STATUSES.new
      if (groups[status]) groups[status].push(order)
    })
    return groups
  }, [sortedOrders])

  const workload = useMemo(() => {
    const countFoodItems = (order) =>
      order.lines.filter((line) => line.category === 'food').reduce((sum, line) => sum + (line.quantity || 0), 0)

    const newOrders = ordersByStatus[FOOD_ORDER_STATUSES.new]
    const preparingOrders = ordersByStatus[FOOD_ORDER_STATUSES.preparing]
    const newItems = newOrders.reduce((sum, order) => sum + countFoodItems(order), 0)
    const preparingItems = preparingOrders.reduce((sum, order) => sum + countFoodItems(order), 0)
    const activeItems = newItems + preparingItems
    const activeOrderCount = newOrders.length + preparingOrders.length
    const level = getWorkloadLevel(activeItems)
    const estimatedMinutes = estimateWaitMinutes(newItems, preparingItems)

    return {
      activeItems,
      activeOrderCount,
      level,
      estimatedMinutes,
      formattedWait: formatWaitTime(estimatedMinutes),
    }
  }, [ordersByStatus])

  useEffect(() => {
    if (!sortedOrders.length) {
      setSelectedOrderId('')
      return
    }
    if (!selectedOrderId || !sortedOrders.some((order) => order.id === selectedOrderId)) {
      setSelectedOrderId(sortedOrders[0].id)
    }
  }, [sortedOrders, selectedOrderId])

  useEffect(() => {
    if (!selectedOrderId) return
    const element = boardRef.current?.querySelector(`[data-order-id="${selectedOrderId}"]`)
    if (element) element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedOrderId])

  useEffect(() => {
    const handleKeyDown = (event) => {
      const activeTag = document.activeElement?.tagName
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return
      if (!sortedOrders.length) return

      const currentIndex = sortedOrders.findIndex((order) => order.id === selectedOrderId)
      const safeIndex = currentIndex >= 0 ? currentIndex : 0

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        setSelectedOrderId(sortedOrders[Math.min(sortedOrders.length - 1, safeIndex + 1)].id)
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setSelectedOrderId(sortedOrders[Math.max(0, safeIndex - 1)].id)
      }

      if (event.key === 'Enter' || event.key === ' ') {
        const currentOrder = sortedOrders[safeIndex]
        const nextStatus = nextStatusMap[currentOrder.foodStatus || FOOD_ORDER_STATUSES.new]
        if (nextStatus && pendingOrderId !== currentOrder.id) {
          event.preventDefault()
          statusChangeRef.current(currentOrder.id, nextStatus)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [sortedOrders, selectedOrderId, pendingOrderId])

  async function handleStatusChange(orderId, nextStatus) {
    if (!nextStatus) return
    setPendingOrderId(orderId)
    setErrorMessage('')
    try {
      await updateFoodOrderStatus({ eventId, orderId, nextStatus, actorUid, actorName })
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setPendingOrderId('')
    }
  }

  statusChangeRef.current = handleStatusChange

  return (
    <div
      className={isFullscreen ? 'kds-fullscreen-shell' : ''}
      ref={boardRef}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}
    >
      {errorMessage ? <div className="error-banner" style={{ margin: '10px 16px 0', flexShrink: 0 }}>{errorMessage}</div> : null}

      <div className={`kds-workload-bar ${activeEvent?.isKitchenClosed ? 'kds-workload-kitchen-closed' : workload.level.barClass}`}>
        <div className="kds-workload-left">
          <span className="kds-workload-tag">TERHELÉS</span>
          <span className="kds-workload-level">
            {activeEvent?.isKitchenClosed ? 'ZÁRVA' : workload.level.label}
          </span>
        </div>
        <div className="kds-workload-track">
          <div className="kds-workload-fill" style={{ width: activeEvent?.isKitchenClosed ? '100%' : `${workload.level.fill}%` }} />
        </div>
        <div className="kds-workload-center">
          <span className="kds-workload-wait-label">Várható várakozás</span>
          <span className="kds-workload-wait-value">
            {activeEvent?.isKitchenClosed ? '—' : workload.formattedWait}
          </span>
        </div>
        <div className="kds-workload-right">
          <span className="kds-workload-stat">{workload.activeOrderCount} rendelés</span>
          <span className="kds-workload-sep">|</span>
          <span className="kds-workload-stat">{workload.activeItems} aktív tétel</span>
          <button
            type="button"
            className={`kds-kitchen-toggle-btn${activeEvent?.isKitchenClosed ? ' is-closed' : ''}`}
            disabled={kitchenPending}
            onClick={async () => {
              setKitchenPending(true)
              try {
                await setKitchenClosedStatus({ eventId, isClosed: !activeEvent?.isKitchenClosed, actorUid })
              } catch (err) {
                setErrorMessage(err.message)
              } finally {
                setKitchenPending(false)
              }
            }}
          >
            {kitchenPending ? '...' : activeEvent?.isKitchenClosed ? 'Konyha megnyitása' : 'Konyha zárása'}
          </button>
        </div>
      </div>

      <div className="kds-board">
        {COLUMNS.map(({ status, label, colClass }) => {
          const columnOrders = ordersByStatus[status] || []
          return (
            <div key={status} className={`kds-column ${colClass}`}>
              <div className="kds-column-header">
                <span>{label}</span>
                <span>{columnOrders.length}</span>
              </div>

              <div className="kds-column-body">
                {columnOrders.map((order) => {
                  const minutesOpen = getMinutesOpen(order.createdAt)
                  const nextStatus = nextStatusMap[status]
                  const late = isLate(status, minutesOpen)
                  const foodLines = order.lines.filter((line) => line.category === 'food')

                  return (
                    <article
                      key={order.id}
                      data-order-id={order.id}
                      className={`kds-ticket receipt-container${late ? ' tone-late' : ''} tone-${status === FOOD_ORDER_STATUSES.delivered ? 'delivered' : status === FOOD_ORDER_STATUSES.ready ? 'ready' : status === FOOD_ORDER_STATUSES.preparing ? 'preparing' : 'new'}${selectedOrderId === order.id ? ' selected' : ''}`}
                      onClick={() => { setSelectedOrderId(order.id) }}
                    >
                      <div className="kds-ticket-header receipt-header">
                        <div className="kds-ticket-header-row">
                          <span className="kds-ticket-name">{order.personDisplayName}</span>
                          <span className="kds-ticket-id">#{order.personInternalId}</span>
                        </div>
                        <div className="kds-ticket-meta">
                          <span className="kds-ticket-time">{formatTimestamp(order.createdAt)}</span>
                          <div className="kds-ticket-meta-right">
                            <span className={`kds-status-badge ${status}${late ? ' late' : ''}`}>
                              {late ? 'KÉSÉS' : statusLabelMap[status]}
                            </span>
                            {minutesOpen !== null && (
                              <span className={`kds-ticket-age${minutesOpen >= 12 ? ' urgent' : ''}`}>
                                {minutesOpen}m
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="kds-ticket-body receipt-body">
                        {foodLines.map((line) => (
                          <div key={line.lineId} className="kds-food-item">
                            <div className="kds-food-item-row">
                              <span className="kds-food-item-name">{line.productName}</span>
                              <span className="kds-food-item-qty">{line.quantity}x</span>
                            </div>
                            {(line.customization?.removedIngredients?.length || line.customization?.extras?.length) ? (
                              <div className="kds-customization">
                                {line.customization?.removedIngredients?.map((item) => (
                                  <span key={`rem-${item.id}`} className="kds-mod-remove">NO {item.label}</span>
                                ))}
                                {line.customization?.extras?.map((item) => (
                                  <span key={`ext-${item.id}`} className="kds-mod-add">+{item.quantity}x {item.label}</span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>

                      <div className="kds-ticket-footer receipt-footer">
                        <div className="kds-ticket-summary receipt-subtotal">
                          <span>Tételek</span>
                          <span className="receipt-dots" />
                          <span>{foodLines.reduce((sum, line) => sum + (line.quantity || 0), 0)}</span>
                        </div>
                        {nextStatus ? (
                          <button
                            type="button"
                            className="primary-button"
                            style={{ width: '100%', padding: '10px', fontWeight: 800, fontSize: '0.85rem' }}
                            onClick={(event) => { event.stopPropagation(); handleStatusChange(order.id, nextStatus) }}
                            disabled={pendingOrderId === order.id}
                          >
                            {pendingOrderId === order.id ? '...' : actionLabelMap[status]}
                          </button>
                        ) : (
                          <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: '0.78rem', fontWeight: 700 }}>
                            ATADVA
                          </div>
                        )}
                      </div>
                    </article>
                  )
                })}

                {columnOrders.length === 0 && (
                  <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: '0.78rem', padding: '20px 8px', opacity: 0.5 }}>
                    -
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
