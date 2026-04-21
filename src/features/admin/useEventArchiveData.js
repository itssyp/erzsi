import { useEffect, useMemo, useState } from 'react'
import { subscribeToAuditLogs } from '../audit/auditService'
import { subscribeLedgerEntriesForEvent } from '../ledger/ledgerService'
import { subscribeToModifierTemplates } from '../modifiers/modifierTemplateService'
import { subscribeOrdersForEvent } from '../orders/orderService'
import { PERSON_RECORD_STATUSES, subscribeToPeople } from '../people/personService'
import { subscribeToProducts } from '../products/productService'
import { LEDGER_ENTRY_TYPES } from '../ledger/ledgerModels'

const initialState = {
  loading: true,
  people: [],
  products: [],
  modifierTemplates: [],
  orders: [],
  ledgerEntries: [],
  auditLogs: [],
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

function buildEventStats({ people, orders, ledgerEntries }) {
  const activePeople = people.filter((person) => person.recordStatus !== PERSON_RECORD_STATUSES.deleted)
  const totalTopups = ledgerEntries
    .filter((entry) => entry.type === LEDGER_ENTRY_TYPES.topup)
    .reduce((sum, entry) => sum + entry.amount, 0)
  const totalSpent = orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0)
  const refundedAmount = orders.reduce((sum, order) => sum + (order.refundedTotal || 0), 0)
  const netSales = totalSpent - refundedAmount
  const outstandingNegativeBalances = activePeople.filter((person) => (person.balance || 0) < 0)
  const outstandingNegativeBalanceTotal = outstandingNegativeBalances.reduce(
    (sum, person) => sum + Math.abs(person.balance || 0),
    0,
  )
  const productSalesMap = new Map()
  const categorySalesMap = new Map()

  orders.forEach((order) => {
    order.lines.forEach((line) => {
      const refundedQuantity = line.refundedQuantity || 0
      const netQuantity = line.quantity - refundedQuantity
      const netRevenue = line.lineTotal - (line.unitTotal * refundedQuantity)
      const productKey = line.productId || `${line.category}:${line.productName}`
      const categoryKey = line.category || 'unknown'
      const existingProduct = productSalesMap.get(productKey) || {
        key: productKey,
        productName: line.productName,
        category: line.category,
        grossQuantity: 0,
        refundedQuantity: 0,
        netQuantity: 0,
        grossRevenue: 0,
        netRevenue: 0,
      }
      const existingCategory = categorySalesMap.get(categoryKey) || {
        category: categoryKey,
        grossRevenue: 0,
        refundedRevenue: 0,
        netRevenue: 0,
        netQuantity: 0,
      }

      existingProduct.grossQuantity += line.quantity
      existingProduct.refundedQuantity += refundedQuantity
      existingProduct.netQuantity += netQuantity
      existingProduct.grossRevenue += line.lineTotal
      existingProduct.netRevenue += netRevenue
      productSalesMap.set(productKey, existingProduct)

      existingCategory.grossRevenue += line.lineTotal
      existingCategory.refundedRevenue += line.unitTotal * refundedQuantity
      existingCategory.netRevenue += netRevenue
      existingCategory.netQuantity += netQuantity
      categorySalesMap.set(categoryKey, existingCategory)
    })
  })

  const topSellingProducts = Array.from(productSalesMap.values())
    .sort((left, right) => right.netQuantity - left.netQuantity || right.netRevenue - left.netRevenue)
    .slice(0, 8)
  const salesByCategory = Array.from(categorySalesMap.values())
    .sort((left, right) => right.netRevenue - left.netRevenue)

  return {
    totalTopups,
    totalSpent,
    refundedAmount,
    netSales,
    totalOrders: orders.length,
    foodOrderCount: orders.filter((order) => order.hasFood).length,
    outstandingNegativeBalanceCount: outstandingNegativeBalances.length,
    outstandingNegativeBalanceTotal,
    topSellingProducts,
    salesByCategory,
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
      auditLogs: false,
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
    const stopAuditLogs = subscribeToAuditLogs(
      eventId,
      (auditLogs) => {
        setState((current) => ({ ...current, auditLogs }))
        markResolved(resolved, 'auditLogs', setState)
      },
      (error) => handleError(error, 'auditLogs'),
    )

    return () => {
      stopPeople()
      stopProducts()
      stopTemplates()
      stopOrders()
      stopLedgerEntries()
      stopAuditLogs()
    }
  }, [eventId])

  const stats = useMemo(
    () => buildEventStats(state),
    [state],
  )

  return {
    ...state,
    stats,
  }
}
