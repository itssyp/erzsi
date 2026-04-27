import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { StatusCard } from '../../components/StatusCard'
import { formatHuf } from '../../lib/money'
import { getStaffSessionId } from '../../lib/session'
import { useAuth } from '../auth/useAuth'
import { subscribeToModifierTemplates } from '../modifiers/modifierTemplateService'
import { PERSON_RECORD_STATUSES, subscribeToPeople } from '../people/personService'
import { useQrScanner } from '../qr/useQrScanner'
import { usePosSession } from './usePosSession'
import { PRODUCT_CATEGORIES, subscribeToProducts } from '../products/productService'
import {
  acquireBasketLock,
  cancelBasket,
  finalizeBasket,
  findPersonByQr,
  refreshBasketLock,
  saveBasketItems,
} from './posService'
import {
  DRS_RETURN_PRODUCT_ID,
  buildBasketLine,
  buildBasketLineMergeKey,
  buildDrsLine,
  buildDrsReturnLine,
  summarizeBasketItems,
} from './basketModels'
import { DRS_DEPOSIT_AMOUNT } from '../drs/drsModels'
import { useKitchenWorkload } from '../kitchen/useKitchenWorkload'
import { useActiveEvent } from '../events/useActiveEvent'

const MISC_CATEGORY = 'Egyebek'
const DRS_RETURN_PRODUCT = Object.freeze({
  id: DRS_RETURN_PRODUCT_ID,
  name: 'Palack visszaváltás',
  category: MISC_CATEGORY,
  price: -DRS_DEPOSIT_AMOUNT,
  isActive: true,
  isDrsReturn: true,
})
const allCategories = ['all', ...PRODUCT_CATEGORIES, MISC_CATEGORY]
const BASKET_ABANDON_CANCEL_MS = 60 * 1000
const BASKET_HEARTBEAT_MS = 15 * 1000
const BASKET_SYNC_DEBOUNCE_MS = 220
const EMPTY_BASKET_SUMMARY = Object.freeze({
  items: [],
  itemCount: 0,
  totalAmount: 0,
})

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="camera-icon">
      <path
        d="M8 6h2l1-2h2l1 2h2a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h2zm4 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0-2.2a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6z"
        fill="currentColor"
      />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path
        d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 7h2v8h-2v-8zm4 0h2v8h-2v-8zM7 10h2v8H7v-8zm1 10h8a2 2 0 0 0 2-2V8H6v10a2 2 0 0 0 2 2z"
        fill="currentColor"
      />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path
        d="M9.2 16.6 4.9 12.3l1.4-1.4 2.9 2.9 8.5-8.5 1.4 1.4-9.9 9.9z"
        fill="currentColor"
      />
    </svg>
  )
}

function createCustomizationState(template) {
  return {
    includedIngredientIds: new Set((template.defaultIncludedIngredients || []).map((item) => item.id)),
    extras: (template.optionalExtras || []).map((item) => ({
      id: item.id,
      label: item.label,
      price: item.price,
      maxQuantity: item.maxQuantity,
      quantity: 0,
    })),
  }
}

function buildCustomizationPayload(template, customizationState) {
  const includedIngredients = (template.defaultIncludedIngredients || []).filter((item) =>
    customizationState.includedIngredientIds.has(item.id),
  )
  const removedIngredients = (template.defaultIncludedIngredients || []).filter(
    (item) => !customizationState.includedIngredientIds.has(item.id),
  )
  const extras = customizationState.extras
    .filter((item) => item.quantity > 0)
    .map((item) => ({
      id: item.id,
      label: item.label,
      price: item.price,
      quantity: item.quantity,
    }))

  return { includedIngredients, removedIngredients, extras }
}

const ProductTile = memo(({ product, onClick, disabled }) => (
  <button
    type="button"
    className={`product-tile${product.isTemporarilyUnavailable ? ' unavailable' : ''}${product.isDrsReturn ? ' credit' : ''}`}
    onClick={() => onClick(product)}
    disabled={disabled || product.isTemporarilyUnavailable}
  >
    <strong style={{ fontSize: '0.9rem', fontWeight: 700 }}>{product.name}</strong>
    <span style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
      {product.category}
    </span>
    {product.isTemporarilyUnavailable ? (
      <span className="product-tile-status">TNA</span>
    ) : null}
    <span style={{ fontWeight: 800, color: 'var(--primary)', fontSize: '0.95rem', marginTop: 'auto' }}>
      {formatHuf(product.price)}
    </span>
  </button>
))

export function StaffPosPanel({ eventId }) {
  const { user, account } = useAuth()
  const { registerActiveBasket, clearActiveBasket } = usePosSession()
  const { activeEvent } = useActiveEvent()
  const { workloadError, ...workload } = useKitchenWorkload(eventId)
  const [people, setPeople] = useState([])
  const [products, setProducts] = useState([])
  const [modifierTemplates, setModifierTemplates] = useState([])
  const [selectedPerson, setSelectedPerson] = useState(null)
  const [switchTargetPerson, setSwitchTargetPerson] = useState(null)
  const [basketItems, setBasketItems] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [customizingProduct, setCustomizingProduct] = useState(null)
  const [customizationState, setCustomizationState] = useState(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [basketSyncing, setBasketSyncing] = useState(false)
  const [pending, setPending] = useState(false)
  const performSwitchToPersonRef = useRef(async () => {})
  const cancelBasketHandlerRef = useRef(async () => {})
  const finalizeBasketHandlerRef = useRef(async () => {})
  const abandonmentCancelRef = useRef(async () => {})
  const abandonmentTimeoutRef = useRef(null)
  const shouldCancelAfterReturnRef = useRef(false)
  const basketSyncTimerRef = useRef(null)
  const basketRenderFrameRef = useRef(null)
  const basketDirtyRef = useRef(false)
  const latestBasketItemsRef = useRef([])
  const committedBasketItemsRef = useRef([])
  const activeBasketSaveRef = useRef(null)
  const selectedPersonRef = useRef(null)
  const flushBasketDraftRef = useRef(async () => {})
  const activeBasketSnapshotRef = useRef({
    personDisplayName: '',
    itemCount: 0,
    canFinalize: false,
    isSyncing: false,
  })

  const deferredSearchQuery = useDeferredValue(searchQuery)
  const sessionId = useMemo(() => getStaffSessionId(), [])
  const staffName = account?.displayName || user?.displayName || user?.email || 'Staff eszköz'

  useEffect(() => {
    return subscribeToPeople(eventId, (nextPeople) => {
      setPeople(nextPeople.filter((person) => person.recordStatus !== PERSON_RECORD_STATUSES.deleted))
    }, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    return subscribeToProducts(eventId, setProducts, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    return subscribeToModifierTemplates(eventId, setModifierTemplates, (error) => setErrorMessage(error.message))
  }, [eventId])

  const displayedPerson = switchTargetPerson || selectedPerson
  const isSwitchingPerson = Boolean(switchTargetPerson)

  const filteredPeople = useMemo(() => {
    const normalizedQuery = deferredSearchQuery.trim().toLowerCase()
    if (!normalizedQuery) return []
    return people.filter((person) => {
      if (displayedPerson?.id === person.id) return false
      const haystack = `${person.displayName} ${person.internalId} ${person.team || ''}`.toLowerCase()
      return haystack.includes(normalizedQuery)
    }).slice(0, 20)
  }, [deferredSearchQuery, displayedPerson, people])

  const availableProducts = useMemo(() => {
    const visibleProducts = products
      .filter((product) => {
        if (!product.isActive) return false
        if (selectedCategory === MISC_CATEGORY) return false
        return selectedCategory === 'all' ? true : product.category === selectedCategory
      })
      .map((product) => {
        const isFood = product.category === 'food'
        if (isFood && activeEvent?.isKitchenClosed) {
          return { ...product, isTemporarilyUnavailable: true }
        }
        return product
      })
      .sort((left, right) => {
        const leftCategoryIndex = PRODUCT_CATEGORIES.indexOf(left.category)
        const rightCategoryIndex = PRODUCT_CATEGORIES.indexOf(right.category)
        const categoryComparison = (leftCategoryIndex === -1 ? PRODUCT_CATEGORIES.length : leftCategoryIndex)
          - (rightCategoryIndex === -1 ? PRODUCT_CATEGORIES.length : rightCategoryIndex)

        if (categoryComparison !== 0) {
          return categoryComparison
        }

        return left.name.localeCompare(right.name, 'hu')
      })
    if (selectedCategory === 'all' || selectedCategory === MISC_CATEGORY) {
      return [...visibleProducts, DRS_RETURN_PRODUCT]
    }
    return visibleProducts
  }, [products, selectedCategory, activeEvent?.isKitchenClosed])

  const groupedProducts = useMemo(() => {
    const groups = new Map()

    availableProducts.forEach((product) => {
      if (!groups.has(product.category)) {
        groups.set(product.category, [])
      }

      groups.get(product.category).push(product)
    })

    return Array.from(groups, ([category, items]) => ({ category, items }))
  }, [availableProducts])

  const showProductCategoryHeadings = selectedCategory === 'all'

  const basketSummary = useMemo(() => summarizeBasketItems(basketItems), [basketItems])
  const shouldShowSearchResults = searchQuery.trim().length >= 2
  const displayedBasketSummary = isSwitchingPerson ? EMPTY_BASKET_SUMMARY : basketSummary

  selectedPersonRef.current = selectedPerson
  activeBasketSnapshotRef.current = {
    personDisplayName: selectedPerson?.displayName || '',
    itemCount: basketSummary.itemCount,
    canFinalize: basketSummary.itemCount > 0,
    isSyncing: basketSyncing,
  }

  const { videoRef, scannerSupported } = useQrScanner({
    active: cameraOpen,
    onDetected: async (rawValue) => {
      const normalizedQr = rawValue.trim()

      if (!normalizedQr) {
        return
      }

      setCameraOpen(false)

      await runAction(async () => {
        const person = await findPersonByQr(eventId, normalizedQr)
        await performSwitchToPersonRef.current(person)
      })
    },
    onError: (error) => {
      setCameraOpen(false)
      setErrorMessage(error.message || 'A kamerás QR-beolvasás nem érhető el ezen az eszközön.')
    },
  })

  async function runAction(action) {
    setPending(true)
    setErrorMessage('')
    try {
      await action()
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setPending(false)
    }
  }

  const clearBasketSyncTimer = useCallback(() => {
    if (basketSyncTimerRef.current) {
      window.clearTimeout(basketSyncTimerRef.current)
      basketSyncTimerRef.current = null
    }
  }, [])

  const clearBasketRenderFrame = useCallback(() => {
    if (basketRenderFrameRef.current) {
      window.cancelAnimationFrame(basketRenderFrameRef.current)
      basketRenderFrameRef.current = null
    }
  }, [])

  const scheduleBasketRender = useCallback(() => {
    if (typeof window === 'undefined') {
      setBasketItems(latestBasketItemsRef.current)
      return
    }

    if (basketRenderFrameRef.current) {
      return
    }

    basketRenderFrameRef.current = window.requestAnimationFrame(() => {
      basketRenderFrameRef.current = null
      const nextItems = latestBasketItemsRef.current
      startTransition(() => {
        setBasketItems(nextItems)
      })
    })
  }, [])

  function resetBasketDraft(items = []) {
    clearBasketSyncTimer()
    clearBasketRenderFrame()
    basketDirtyRef.current = false
    latestBasketItemsRef.current = items
    committedBasketItemsRef.current = items
    setBasketSyncing(false)
  }

  function clearSelectedBasketState() {
    resetBasketDraft([])
    setSelectedPerson(null)
    setBasketItems([])
  }

  function loadSelectedBasket(person, items) {
    const nextItems = items || []
    resetBasketDraft(nextItems)
    setSelectedPerson(person)
    setBasketItems(nextItems)
  }

  async function flushBasketDraft() {
    clearBasketSyncTimer()

    const person = selectedPersonRef.current

    if (!person || !basketDirtyRef.current) {
      return
    }

    if (activeBasketSaveRef.current) {
      await activeBasketSaveRef.current
      return flushBasketDraft()
    }

    const itemsToPersist = latestBasketItemsRef.current
    basketDirtyRef.current = false
    setBasketSyncing(true)

    const savePromise = saveBasketItems({
      eventId,
      personId: person.id,
      items: itemsToPersist,
      staffUid: user.uid,
      sessionId,
      staffName,
    })

    activeBasketSaveRef.current = savePromise

    try {
      await savePromise
      committedBasketItemsRef.current = itemsToPersist

      if (selectedPersonRef.current?.id === person.id && latestBasketItemsRef.current !== itemsToPersist) {
        basketDirtyRef.current = true
        scheduleBasketSync()
      }
    } catch (error) {
      if (selectedPersonRef.current?.id === person.id) {
        latestBasketItemsRef.current = committedBasketItemsRef.current
        setBasketItems(committedBasketItemsRef.current)
      }

      basketDirtyRef.current = false
      setErrorMessage(error.message)
      throw error
    } finally {
      if (activeBasketSaveRef.current === savePromise) {
        activeBasketSaveRef.current = null
      }

      if (!basketDirtyRef.current) {
        setBasketSyncing(false)
      }
    }
  }

  flushBasketDraftRef.current = flushBasketDraft

  const scheduleBasketSync = useCallback(() => {
    clearBasketSyncTimer()

    basketSyncTimerRef.current = window.setTimeout(() => {
      flushBasketDraftRef.current().catch(() => {})
    }, BASKET_SYNC_DEBOUNCE_MS)
  }, [clearBasketSyncTimer])

  const applyOptimisticBasketItems = useCallback((nextItems) => {
    basketDirtyRef.current = true
    latestBasketItemsRef.current = nextItems
    scheduleBasketRender()
    setBasketSyncing(true)
    scheduleBasketSync()
  }, [scheduleBasketRender, scheduleBasketSync])

  async function performSwitchToPerson(nextPerson) {
    const previousPerson = selectedPersonRef.current
    const currentItemCount = latestBasketItemsRef.current.reduce((sum, item) => sum + item.quantity, 0)

    setSwitchTargetPerson(nextPerson)
    setSearchQuery('')

    if (previousPerson) {
      if (currentItemCount > 0) {
        await flushBasketDraft()
        await finalizeBasket({ eventId, personId: previousPerson.id, staffUid: user.uid, sessionId, staffName })
      } else {
        clearBasketSyncTimer()
        if (activeBasketSaveRef.current) {
          await activeBasketSaveRef.current.catch(() => {})
        }
        await cancelBasket({ eventId, personId: previousPerson.id, staffUid: user.uid, sessionId })
      }

      clearSelectedBasketState()
    }

    try {
      const lockedBasket = await acquireBasketLock({ eventId, person: nextPerson, staffUid: user.uid, sessionId, staffName })
      loadSelectedBasket(nextPerson, lockedBasket.items || [])
    } finally {
      setSwitchTargetPerson(null)
    }
  }

  performSwitchToPersonRef.current = performSwitchToPerson

  async function switchToPerson(nextPerson) {
    if (displayedPerson?.id === nextPerson.id) return
    setSearchQuery('')
    await runAction(() => performSwitchToPerson(nextPerson))
  }

  async function handleFinalizeCurrentBasket() {
    if (!selectedPerson || basketSummary.itemCount === 0) return
    await runAction(async () => {
      await flushBasketDraft()
      await finalizeBasket({ eventId, personId: selectedPerson.id, staffUid: user.uid, sessionId, staffName })
      clearSelectedBasketState()
    })
  }

  async function handleCancelCurrentBasket() {
    if (!selectedPerson) return
    await runAction(async () => {
      clearBasketSyncTimer()
      if (activeBasketSaveRef.current) {
        await activeBasketSaveRef.current.catch(() => {})
      }
      await cancelBasket({ eventId, personId: selectedPerson.id, staffUid: user.uid, sessionId })
      clearSelectedBasketState()
    })
  }

  async function cancelCurrentBasketForAbandonment(message) {
    if (!selectedPerson) {
      return
    }

    try {
      await cancelBasket({ eventId, personId: selectedPerson.id, staffUid: user.uid, sessionId })
      clearSelectedBasketState()
      setErrorMessage(message)
    } catch (error) {
      setErrorMessage(error.message)
    }
  }

  cancelBasketHandlerRef.current = handleCancelCurrentBasket
  finalizeBasketHandlerRef.current = handleFinalizeCurrentBasket
  abandonmentCancelRef.current = cancelCurrentBasketForAbandonment

  const addItemToBasket = useCallback((product, customization) => {
    if (!selectedPersonRef.current) {
      setErrorMessage('Tétel hozzáadása előtt válassz ki egy személyt.')
      return
    }

    const currentItems = latestBasketItemsRef.current
    if (product.isDrsReturn) {
      const existingReturnIndex = currentItems.findIndex((item) => item.lineType === 'drsReturn')
      const nextItems = existingReturnIndex >= 0
        ? currentItems.map((item, index) => (
            index === existingReturnIndex ? { ...item, quantity: item.quantity + 1 } : item
          ))
        : [...currentItems, buildDrsReturnLine()]

      applyOptimisticBasketItems(nextItems)
      return
    }

    const mergeKey = buildBasketLineMergeKey(product.id, customization)
    const existingIndex = currentItems.findIndex(
      (item) => item.lineType !== 'drs'
        && (item.mergeKey || buildBasketLineMergeKey(item.productId, item.customization)) === mergeKey,
    )

    if (existingIndex >= 0) {
      const parentLine = currentItems[existingIndex]
      const nextItems = currentItems.map((item) => {
        if (item.lineId === parentLine.lineId) return { ...item, quantity: item.quantity + 1 }
        if (item.lineType === 'drs' && item.parentLineId === parentLine.lineId) return { ...item, quantity: item.quantity + 1 }
        return item
      })
      applyOptimisticBasketItems(nextItems)
    } else {
      const newLine = buildBasketLine({ product, customization })
      const nextItems = [...currentItems, newLine]
      if (product.isDRS) {
        nextItems.push(buildDrsLine({ parentLineId: newLine.lineId }))
      }
      applyOptimisticBasketItems(nextItems)
    }
  }, [applyOptimisticBasketItems])

  const startCustomization = useCallback((product) => {
    const template = modifierTemplates.find((entry) => entry.id === product.modifierTemplateId)
    if (!template) {
      addItemToBasket(product, null)
      return
    }
    setCustomizingProduct({ product, template })
    setCustomizationState(createCustomizationState(template))
  }, [modifierTemplates, addItemToBasket])

  function handleConfirmCustomization() {
    if (!customizingProduct || !customizationState) return
    const customization = buildCustomizationPayload(customizingProduct.template, customizationState)
    const targetProduct = customizingProduct.product
    setCustomizingProduct(null)
    setCustomizationState(null)
    addItemToBasket(targetProduct, customization)
  }

  function updateBasketLine(lineId, updater) {
    if (!selectedPersonRef.current) return
    const nextItems = latestBasketItemsRef.current
      .map((item) => {
        if (item.lineId !== lineId) {
          return item
        }
        if (item.lineType === 'drs') {
          return item
        }
        return updater(item)
      })
      .map((item, _, allItems) => {
        if (item.lineType === 'drs') {
          const parentLine = allItems.find((candidate) => candidate.lineId === item.parentLineId)
          if (!parentLine || parentLine.quantity <= 0) {
            return { ...item, quantity: 0 }
          }
          return { ...item, quantity: parentLine.quantity }
        }
        return item
      })
      .filter((item) => item.quantity > 0)
    applyOptimisticBasketItems(nextItems)
  }

  function closeCustomization() {
    setCustomizingProduct(null)
    setCustomizationState(null)
  }

  useEffect(() => {
    return () => {
      clearBasketSyncTimer()
      clearBasketRenderFrame()
    }
  }, [clearBasketRenderFrame, clearBasketSyncTimer])

  useEffect(() => {
    if (!selectedPerson) {
      clearActiveBasket()
      return
    }

    registerActiveBasket({
      personId: selectedPerson.id,
      getSnapshot: () => activeBasketSnapshotRef.current,
      cancelBasket: () => cancelBasketHandlerRef.current(),
      finalizeBasket: () => finalizeBasketHandlerRef.current(),
    })

    return () => {
      clearActiveBasket()
    }
  }, [
    clearActiveBasket,
    registerActiveBasket,
    selectedPerson,
  ])

  useEffect(() => {
    if (!selectedPerson || typeof document === 'undefined') {
      return () => {}
    }

    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || navigator.onLine === false) {
        return
      }

      refreshBasketLock({
        eventId,
        personId: selectedPerson.id,
        staffUid: user.uid,
        sessionId,
        staffName,
      }).catch((error) => {
        setErrorMessage(error.message)
      })
    }, BASKET_HEARTBEAT_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [eventId, selectedPerson, sessionId, staffName, user.uid])

  useEffect(() => {
    function clearAbandonmentTimer() {
      if (abandonmentTimeoutRef.current) {
        window.clearTimeout(abandonmentTimeoutRef.current)
        abandonmentTimeoutRef.current = null
      }
    }

    if (!selectedPerson || typeof document === 'undefined') {
      clearAbandonmentTimer()
      shouldCancelAfterReturnRef.current = false
      return () => {}
    }

    const scheduleAbandonmentCheck = () => {
      clearAbandonmentTimer()

      abandonmentTimeoutRef.current = window.setTimeout(() => {
        const isHidden = document.visibilityState === 'hidden'
        const isOffline = navigator.onLine === false

        if (!isHidden && !isOffline) {
          return
        }

      if (isOffline) {
          shouldCancelAfterReturnRef.current = true
          setErrorMessage('Túl sokáig megszakadt a kapcsolat. A kosár a kapcsolat helyreállásakor törlődni fog.')
          return
        }

        abandonmentCancelRef.current('A kosár törölve lett, mert az oldal túl sokáig inaktív volt.')
      }, BASKET_ABANDON_CANCEL_MS)
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        scheduleAbandonmentCheck()
        return
      }

      clearAbandonmentTimer()

      if (shouldCancelAfterReturnRef.current && navigator.onLine !== false) {
        shouldCancelAfterReturnRef.current = false
        abandonmentCancelRef.current('A kosár törölve lett, mert az eszköz túl sokáig offline volt.')
      }
    }

    const handleOffline = () => {
      scheduleAbandonmentCheck()
    }

    const handleOnline = () => {
      clearAbandonmentTimer()

      if (shouldCancelAfterReturnRef.current && document.visibilityState === 'visible') {
        shouldCancelAfterReturnRef.current = false
        abandonmentCancelRef.current('A kosár törölve lett, mert az eszköz túl sokáig offline volt.')
      }
    }

    const handlePageHide = () => {
      // Tab is closing or navigating away. The server-side STALE_BASKET_LOCK_MS 
      // will release the lock after 2.5 minutes of inactivity, but we clear local state now.
      clearActiveBasket()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    window.addEventListener('pagehide', handlePageHide)

    return () => {
      clearAbandonmentTimer()
      shouldCancelAfterReturnRef.current = false
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [clearActiveBasket, eventId, selectedPerson, sessionId, user.uid])

  return (
    <div className="pos-screen-layout">
      {/* LEFT COLUMN: Lookup + Basket */}
      <div className="pos-basket-area">
        <div className="pos-toolbar-area">
          {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

          <div className="lookup-toolbar">
            <input
              id="personSearch"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Keresés név vagy 5 számjegyű kód alapján..."
              autoComplete="off"
            />
            <button
              type="button"
              className={`icon-button${cameraOpen ? ' active' : ''}`}
              onClick={() => {
                if (!scannerSupported) { setErrorMessage('A kamerás QR-beolvasás nem támogatott.'); return }
                setCameraOpen((current) => !current)
              }}
              aria-label={cameraOpen ? 'Kamera bezárása' : 'QR beolvasása'}
              title={cameraOpen ? 'Kamera bezárása' : 'QR-kód beolvasása'}
            >
              <CameraIcon />
            </button>
          </div>

          {cameraOpen && (
            <div className="camera-panel">
              <video ref={videoRef} className="camera-preview" playsInline muted />
            </div>
          )}

          {shouldShowSearchResults && (
            <div className="record-list compact pos-search-results panel">
              {filteredPeople.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  className={`record-row${displayedPerson?.id === person.id ? ' selected' : ''}`}
                  onClick={() => switchToPerson(person)}
                  disabled={pending}
                >
                  <span>
                    <strong>{person.displayName}</strong>
                    <small>{person.internalId}{person.team ? ` · ${person.team}` : ''}</small>
                  </span>
                  <span style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--primary)', flexShrink: 0 }}>
                    {formatHuf(person.balance || 0)}
                  </span>
                </button>
              ))}
              {filteredPeople.length === 0 && <p className="helper-text" style={{ padding: '8px' }}>Nincs találat.</p>}
            </div>
          )}
        </div>

        {/* Receipt */}
        <div className="receipt-container">
          <div className="receipt-header">
            {displayedPerson ? (
              <>
                <div style={{ fontWeight: 800, fontSize: '1rem' }}>{displayedPerson.displayName}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '2px' }}>
                  #{displayedPerson.internalId}
                </div>
                <div style={{ borderTop: '1px dashed var(--border)', marginTop: '8px', paddingTop: '8px', fontSize: '0.85rem' }}>
                  Egyenleg: {formatHuf(displayedPerson.balance || 0)}
                </div>
                {isSwitchingPerson ? (
                  <p className="helper-text" style={{ marginTop: '8px' }}>
                    Vendég betöltése...
                  </p>
                ) : null}
              </>
            ) : (
              <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>Nincs kiválasztott vendég</p>
            )}
          </div>

          <div className="receipt-body">
            {displayedBasketSummary.items.map((item) => {
              const isDrsLine = item.lineType === 'drs'
              const isDrsReturnLine = item.lineType === 'drsReturn'
              return (
                <div
                  key={item.lineId}
                  className={`receipt-line${isDrsLine ? ' receipt-line-drs' : ''}${isDrsReturnLine ? ' receipt-line-credit' : ''}`}
                >
                  <span
                    className="receipt-item-name"
                    style={isDrsLine ? { color: 'var(--muted)', fontSize: '0.8em', paddingLeft: '10px' } : {}}
                  >
                    {item.productName}
                  </span>
                  <span className="receipt-dots" />
                  <span className="receipt-qty-price">{item.quantity}x</span>
                  <span className="receipt-line-price">{formatHuf(item.lineTotal)}</span>
                  {!isDrsLine ? (
                    <div className="receipt-controls">
                      <button
                        type="button"
                        className="receipt-btn"
                        onClick={() => updateBasketLine(item.lineId, (entry) => ({ ...entry, quantity: entry.quantity - 1 }))}
                        aria-label="Remove one"
                      >
                        -
                      </button>
                      <button
                        type="button"
                        className="receipt-btn"
                        onClick={() => updateBasketLine(item.lineId, (entry) => ({ ...entry, quantity: entry.quantity + 1 }))}
                        aria-label="Add one"
                      >
                        +
                      </button>
                    </div>
                  ) : null}
                </div>
              )
            })}
            {displayedBasketSummary.items.length === 0 && (
              <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: '0.85rem', padding: '20px 0' }}>
                - Üres kosár -
              </p>
            )}
          </div>

          <div className="receipt-footer">
            {basketSyncing && selectedPerson ? (
              <p className="helper-text" style={{ marginBottom: '10px' }}>
                Kosár szinkronizálása...
              </p>
            ) : null}
            {isSwitchingPerson ? (
              <p className="helper-text" style={{ marginBottom: '10px' }}>
                Vendég kiválasztása folyamatban...
              </p>
            ) : null}
            <div className="receipt-subtotal">
              <span>Tételek</span>
              <span className="receipt-dots" />
              <span>{displayedBasketSummary.itemCount}</span>
            </div>
            {displayedPerson && displayedBasketSummary.totalAmount !== 0 && (
              <div className="receipt-subtotal">
                <span>{displayedBasketSummary.totalAmount > 0 ? 'Maradék' : 'Jóváírás után'}</span>
                <span className="receipt-dots" />
                <span>{formatHuf((displayedPerson.balance || 0) - displayedBasketSummary.totalAmount)}</span>
              </div>
            )}
            <div className="receipt-total">
              <span>TOTAL</span>
              <span className="receipt-dots" />
              <span>{formatHuf(displayedBasketSummary.totalAmount)}</span>
            </div>

            <div className="receipt-action-row pos-cart-action-row">
              <button
                type="button"
                className="secondary-button pos-cart-delete-btn"
                onClick={handleCancelCurrentBasket}
                disabled={pending || !selectedPerson}
              >
                Törlés
              </button>
              <button
                type="button"
                className="primary-button pos-cart-finalize-btn"
                onClick={handleFinalizeCurrentBasket}
                disabled={pending || displayedBasketSummary.itemCount === 0}
              >
                {pending ? 'Folyamatban...' : 'Lezárás'}
              </button>
            </div>
          </div>
        </div>

      </div>

      {/* RIGHT COLUMN: Product catalog */}
      <div className="pos-products-area panel">
        <div className="pos-catalog-header">
          <div className="category-row">
            {allCategories.map((category) => (
              <button
                key={category}
                type="button"
                className={`category-btn${selectedCategory === category ? ' active' : ''}`}
                onClick={() => setSelectedCategory(category)}
              >
                {category}
              </button>
            ))}
          </div>

          <div className={`pos-workload-mini ${workloadError ? 'workload-error-state' : workload.barClass}`}>
            <div className="workload-mini-left">
              <span className="workload-tag">Konyha</span>
              <span className="workload-level">{workloadError ? 'Hiba' : workload.label}</span>
            </div>
            <div className="workload-mini-center">
              <span className="workload-wait-label">Várható várakozás</span>
              <span className="workload-wait-value">{workloadError ? '—' : workload.formattedWait}</span>
            </div>
            <div className="workload-mini-right">
              <span className="workload-count">{workloadError ? 'Nem elérhető' : `${workload.itemCount} tétel`}</span>
            </div>
          </div>
        </div>

        {!displayedPerson && (
          <p className="helper-text" style={{ textAlign: 'center', paddingTop: '8px' }}>
            Rendelés indításához olvass be vagy keress rá egy vendégre.
          </p>
        )}

        <div className="product-grid-scroll">
          <div
            className="product-category-list"
            style={{ opacity: !displayedPerson ? 0.45 : 1, pointerEvents: !displayedPerson ? 'none' : 'auto' }}
          >
            {groupedProducts.map((group) => (
              <section key={group.category} className="product-category-section">
                {showProductCategoryHeadings ? (
                  <h4 className="product-category-title">{group.category}</h4>
                ) : null}
                <div className="product-grid">
                  {group.items.map((product) => (
                    <ProductTile
                      key={product.id}
                      product={product}
                      onClick={startCustomization}
                      disabled={pending || !selectedPerson}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>

        {/* Customization modal */}
        {customizingProduct && (
          <>
            <div
              className="modal-backdrop"
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)', zIndex: 999 }}
              onClick={closeCustomization}
            />
            <div
              className="customization-modal floating-overlay"
              style={{
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: 'min(680px, calc(100vw - 40px))',
                maxHeight: 'calc(100vh - 80px)',
                zIndex: 1000,
                background: 'white',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-lg)',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              {/* Modal header */}
              <div className="customization-modal-header" style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                <div>
                  <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: '3px' }}>
                    Testreszabás
                  </div>
                  <h4 style={{ fontSize: '1.15rem', fontWeight: 800 }}>
                    {customizingProduct.product.name}
                  </h4>
                </div>
                <button type="button" className="secondary-button" onClick={closeCustomization}>
                  Bezárás
                </button>
              </div>

              {/* Modal body */}
              <div className="customization-modal-body" style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                <div className="dashboard-grid">
                  {(customizingProduct.template.defaultIncludedIngredients || []).length > 0 && (
                    <div className="stack-block" style={{ gap: '8px' }}>
                      <h5 className="card-title" style={{ marginBottom: '4px' }}>Hozzávalók</h5>
                      {customizingProduct.template.defaultIncludedIngredients.map((ingredient) => (
                        <label key={ingredient.id} className="checkbox-row" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                          <input
                            type="checkbox"
                            checked={customizationState?.includedIngredientIds.has(ingredient.id) || false}
                            onChange={(event) =>
                              setCustomizationState((current) => {
                                const nextIds = new Set(current.includedIngredientIds)
                                if (event.target.checked) nextIds.add(ingredient.id)
                                else nextIds.delete(ingredient.id)
                                return { ...current, includedIngredientIds: nextIds }
                              })
                            }
                          />
                          <span style={{ fontWeight: 500, fontSize: '0.875rem' }}>{ingredient.label}</span>
                        </label>
                      ))}
                    </div>
                  )}

                  {(customizationState?.extras || []).length > 0 && (
                    <div className="stack-block" style={{ gap: '8px' }}>
                      <h5 className="card-title" style={{ marginBottom: '4px' }}>Extrák</h5>
                      {customizationState.extras.map((extra) => (
                        <div
                          key={extra.id}
                          className="customization-extra-row"
                          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
                        >
                          <div>
                            <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>{extra.label}</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>+{formatHuf(extra.price)} each</div>
                          </div>
                          <input
                            type="number"
                            min="0"
                            max={extra.maxQuantity}
                            value={extra.quantity}
                            className="customization-extra-input"
                            style={{ width: '64px', textAlign: 'center' }}
                            onChange={(event) => {
                              const nextValue = Number.parseInt(event.target.value || '0', 10)
                              setCustomizationState((current) => ({
                                ...current,
                                extras: current.extras.map((entry) =>
                                  entry.id === extra.id
                                    ? { ...entry, quantity: Math.max(0, Math.min(entry.maxQuantity, nextValue)) }
                                    : entry
                                ),
                              }))
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Modal footer */}
              <div className="customization-modal-footer" style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
                <button
                  type="button"
                  className="primary-button"
                  style={{ width: '100%', padding: '12px' }}
                  onClick={handleConfirmCustomization}
                >
                  Kosárba
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
