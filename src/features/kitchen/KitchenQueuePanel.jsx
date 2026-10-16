import { useEffect, useMemo, useRef, useState } from 'react'
import { FOOD_ORDER_STATUSES } from '../orders/orderModels'
import { subscribeFoodOrders, updateFoodOrderStatus } from '../orders/orderService'
import { useActiveEvent } from '../events/useActiveEvent'
import { setKitchenClosedStatus } from '../events/eventService'
import { isFoodCategory } from '../products/productModels'
import { estimateWaitMinutes, formatWaitTime, getWorkloadLevel } from './kitchenModels'
import {
  FILTERABLE_STATIONS,
  KITCHEN_STATIONS,
  KITCHEN_STATION_COLORS,
  KITCHEN_STATION_LABELS,
  splitOrderByStation,
} from './kitchenStations'
import { compareKitchenTickets } from './foodQueuePosition'

// LocalStorage key for the filter selection — per event so a tablet that
// switches between events doesn't carry over the burger filter into a future
// event by accident.
const FILTER_STORAGE_KEY = (eventId) => `kds.stationFilter::${eventId || 'default'}`
const AUDIO_MUTED_STORAGE_KEY = (eventId) => `kds.audioMuted::${eventId || 'default'}`

// New-ticket audio cues — three prerecorded WAVs served from /public/cues.
// One is picked at random on every new ticket arrival (regardless of station)
// so the kitchen doesn't hear the same clip repeatedly during a rush.
const KITCHEN_CUE_URLS = [
  '/cues/erkezettrendeles.wav',
  '/cues/figyelem.wav',
  '/cues/rendeleserekezett.wav',
]

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
  // selectedStations is an explicit whitelist of FILTERABLE_STATIONS. Empty set
  // = "Összes" mode (every station, including `other`, visible). Non-empty =
  // strict whitelist; `other` is implicitly hidden because it has no chip.
  const [selectedStations, setSelectedStations] = useState(() => new Set())
  const [audioMuted, setAudioMuted] = useState(false)
  const [audioUnlocked, setAudioUnlocked] = useState(false)
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  const boardRef = useRef(null)
  const filterMenuRef = useRef(null)
  const statusChangeRef = useRef(async () => {})
  // Preloaded HTMLAudioElement pool for the new-ticket cues.
  const cuePoolRef = useRef([])
  // Tracks whether the current selection came from a user action (tap / arrow
  // key) versus the automatic "pick the first ticket" on load. Used to skip
  // scrollIntoView on the initial auto-pick — otherwise on mobile the board
  // jumps to whichever column happens to hold the oldest ticket (often
  // Készül), even though the user just opened the page wanting to see Új.
  const userInteractedRef = useRef(false)
  // Tickets we've already seen across renders. Prevents the very first render
  // from chiming for every pre-existing ticket on mount.
  const seenTicketIdsRef = useRef(new Set())
  const seenTicketsInitialisedRef = useRef(false)

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

  // Load persisted filter selection for this event on mount / event-change.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(FILTER_STORAGE_KEY(eventId))
      if (!raw) {
        setSelectedStations(new Set())
        return
      }
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr)) {
        setSelectedStations(new Set())
        return
      }
      // Only keep stations that are still in FILTERABLE_STATIONS (defensive
      // against future renames / removals).
      const filtered = arr.filter((s) => FILTERABLE_STATIONS.includes(s))
      setSelectedStations(new Set(filtered))
    } catch {
      setSelectedStations(new Set())
    }
  }, [eventId])

  // Persist on change. Empty set written as [] (= "Összes") so user choice
  // round-trips correctly.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        FILTER_STORAGE_KEY(eventId),
        JSON.stringify(Array.from(selectedStations)),
      )
    } catch {
      // localStorage can be unavailable in private or locked-down browser modes.
    }
  }, [eventId, selectedStations])

  // ── Audio cue engine ────────────────────────────────────────────────────
  // Preload the three WAV cues into a pool of HTMLAudioElement instances so
  // playback is instant when a new ticket arrives. Cleaned up on unmount.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    cuePoolRef.current = KITCHEN_CUE_URLS.map((url) => {
      const audio = new Audio(url)
      audio.preload = 'auto'
      // Preserve default volume; consumers can still mute via the toggle.
      return audio
    })
    return () => {
      cuePoolRef.current.forEach((audio) => {
        try {
          audio.pause()
          audio.src = ''
        } catch { /* noop */ }
      })
      cuePoolRef.current = []
    }
  }, [])

  function playRandomCue() {
    const pool = cuePoolRef.current
    if (!pool.length) return
    const audio = pool[Math.floor(Math.random() * pool.length)]
    try {
      // If the same cue is still playing (rapid-fire arrivals), restart it
      // so we always get a fresh chime rather than silently ignoring it.
      audio.pause()
      audio.currentTime = 0
      const p = audio.play()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch { /* noop */ }
  }

  // Browser autoplay policies require a user gesture before audio plays.
  // On the first pointerdown / keydown we "warm up" every clip in the pool
  // (play → pause) which registers a user-initiated play() and unlocks
  // subsequent playback without further gestures.
  useEffect(() => {
    if (audioUnlocked) return undefined
    const unlock = () => {
      cuePoolRef.current.forEach((audio) => {
        try {
          const p = audio.play()
          if (p && typeof p.then === 'function') {
            p.then(() => {
              audio.pause()
              audio.currentTime = 0
            }).catch(() => {})
          }
        } catch { /* noop */ }
      })
      setAudioUnlocked(true)
    }
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [audioUnlocked])

  // Load + persist mute state per event.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(AUDIO_MUTED_STORAGE_KEY(eventId))
      setAudioMuted(raw === 'true')
    } catch {
      setAudioMuted(false)
    }
    // Reset the seen-ids tracker when switching events so the new event
    // doesn't immediately chime for every existing ticket.
    seenTicketIdsRef.current = new Set()
    seenTicketsInitialisedRef.current = false
  }, [eventId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(AUDIO_MUTED_STORAGE_KEY(eventId), String(audioMuted))
    } catch {
      // localStorage can be unavailable in private or locked-down browser modes.
    }
  }, [eventId, audioMuted])

  // Close the filter dropdown when the user taps anywhere outside it (incl.
  // taps inside the dropdown's own buttons trigger this *after* the option
  // handler ran, so the menu collapses post-selection without extra wiring).
  useEffect(() => {
    if (!filterMenuOpen) return undefined
    const handler = (event) => {
      const root = filterMenuRef.current
      if (root && !root.contains(event.target)) setFilterMenuOpen(false)
    }
    window.addEventListener('pointerdown', handler)
    return () => window.removeEventListener('pointerdown', handler)
  }, [filterMenuOpen])

  // Derived: when no specific filter is active OR every filterable is selected,
  // treat as "Összes" — show every ticket including the `other` station.
  const isAllMode = selectedStations.size === 0
    || selectedStations.size === FILTERABLE_STATIONS.length

  function toggleStation(station) {
    setSelectedStations((prev) => {
      const next = new Set(prev)
      if (next.has(station)) {
        next.delete(station)
      } else {
        next.add(station)
      }
      // Collapsing back to "all selected" → store as empty so isAllMode stays
      // truthy and "other" tickets come back.
      if (next.size === FILTERABLE_STATIONS.length) return new Set()
      return next
    })
  }

  function selectAllStations() {
    setSelectedStations(new Set())
  }

  // Split every order into per-station sub-tickets. splitOrderByStation
  // handles the lazy fallback for orders created before the per-station fields
  // existed — those still produce tickets, all sharing order.foodStatus until
  // the first time a chef advances one of them.
  const allTickets = useMemo(() => {
    const out = []
    for (const order of orders) out.push(...splitOrderByStation(order))
    return out
  }, [orders])

  // ── Audio: detect newly-arrived tickets and chime once each ─────────────
  // Strategy: on the FIRST render after data arrives, just record every ticket
  // id as "seen" with no sound. On every subsequent change, any id that isn't
  // in the seen set is brand new — chime if it's currently visible (respects
  // the station filter) and not muted, then mark it seen so we don't repeat.
  useEffect(() => {
    if (!seenTicketsInitialisedRef.current) {
      // First population — silence + seed the set.
      for (const t of allTickets) seenTicketIdsRef.current.add(t.id)
      seenTicketsInitialisedRef.current = true
      return
    }
    if (audioMuted || !audioUnlocked) {
      // Even when muted, advance the seen-set so unmuting later doesn't
      // backfire and chime for stale tickets.
      for (const t of allTickets) seenTicketIdsRef.current.add(t.id)
      return
    }
    let anyChimeWorthy = false
    for (const t of allTickets) {
      if (seenTicketIdsRef.current.has(t.id)) continue
      seenTicketIdsRef.current.add(t.id)
      // Only chime for tickets that arrive in 'new' state — skip backfills
      // and any status transitions on existing tickets.
      if (t.status !== FOOD_ORDER_STATUSES.new) continue
      // Respect the station filter: a pizza-only tablet stays silent for
      // burger tickets even when they come in.
      if (!isAllMode && !selectedStations.has(t.station)) continue
      anyChimeWorthy = true
    }
    // Play ONE random cue per batch of new tickets — the WAVs are ~half a
    // second long, so playing several at once would produce overlapping
    // audio that's harder for the kitchen to parse than a single hit.
    if (anyChimeWorthy) playRandomCue()
    // playRandomCue is intentionally not in deps — it's a stable function
    // reading refs. Including it would re-run on every render.
  }, [allTickets, audioMuted, audioUnlocked, isAllMode, selectedStations])

  // Visibility: hide a ticket once it has been `delivered` for more than the
  // grace window AND honour the station filter (whitelist if not in "Összes"
  // mode).
  const visibleTickets = useMemo(() => {
    return allTickets.filter((t) => {
      if (!isAllMode && !selectedStations.has(t.station)) return false
      if (t.status !== FOOD_ORDER_STATUSES.delivered) return true
      const updatedAtMs = getMillis(t.statusUpdatedAt || t.order.updatedAt)
      return nowMs - updatedAtMs < DELIVERED_HIDE_MS
    })
  }, [nowMs, allTickets, isAllMode, selectedStations])

  // Per-station active counts for the workload-bar breakdown + filter pills.
  // ALWAYS computed across all (non-filtered) tickets so the pills tell the
  // truth even when the user is filtered to one station.
  const activeCountsByStation = useMemo(() => {
    const counts = { burger: 0, gyros: 0, pizza: 0, other: 0 }
    for (const t of allTickets) {
      if (t.status === FOOD_ORDER_STATUSES.delivered) continue
      counts[t.station] = (counts[t.station] || 0) + 1
    }
    return counts
  }, [allTickets])

  const sortedTickets = useMemo(() => {
    // Stable order: by original order createdAt, order ID, then station.
    return [...visibleTickets].sort(compareKitchenTickets)
  }, [visibleTickets])

  const ticketsByStatus = useMemo(() => {
    const groups = {
      [FOOD_ORDER_STATUSES.new]: [],
      [FOOD_ORDER_STATUSES.preparing]: [],
      [FOOD_ORDER_STATUSES.ready]: [],
      [FOOD_ORDER_STATUSES.delivered]: [],
    }
    sortedTickets.forEach((ticket) => {
      const status = ticket.status || FOOD_ORDER_STATUSES.new
      if (groups[status]) groups[status].push(ticket)
    })
    return groups
  }, [sortedTickets])

  const workload = useMemo(() => {
    const countTicketItems = (ticket) =>
      ticket.lines.filter((line) => isFoodCategory(line.category))
        .reduce((sum, line) => sum + (line.quantity || 0), 0)

    const newTickets = ticketsByStatus[FOOD_ORDER_STATUSES.new]
    const preparingTickets = ticketsByStatus[FOOD_ORDER_STATUSES.preparing]
    const newItems = newTickets.reduce((sum, t) => sum + countTicketItems(t), 0)
    const preparingItems = preparingTickets.reduce((sum, t) => sum + countTicketItems(t), 0)
    const activeItems = newItems + preparingItems
    const activeOrderCount = newTickets.length + preparingTickets.length
    const level = getWorkloadLevel(activeItems)
    const estimatedMinutes = estimateWaitMinutes(newItems, preparingItems)

    return {
      activeItems,
      activeOrderCount,
      level,
      estimatedMinutes,
      formattedWait: formatWaitTime(estimatedMinutes),
    }
  }, [ticketsByStatus])

  // selectedOrderId is now actually a ticket id (`${orderId}::${station}`).
  // Kept the variable name to minimise diff churn elsewhere in the file.
  useEffect(() => {
    if (!sortedTickets.length) {
      setSelectedOrderId('')
      return
    }
    if (!selectedOrderId || !sortedTickets.some((t) => t.id === selectedOrderId)) {
      setSelectedOrderId(sortedTickets[0].id)
    }
  }, [sortedTickets, selectedOrderId])

  useEffect(() => {
    if (!selectedOrderId) return
    if (!userInteractedRef.current) return
    const element = boardRef.current?.querySelector(`[data-ticket-id="${selectedOrderId}"]`)
    if (element) element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedOrderId])

  useEffect(() => {
    const handleKeyDown = (event) => {
      const activeTag = document.activeElement?.tagName
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return
      if (!sortedTickets.length) return

      const currentIndex = sortedTickets.findIndex((t) => t.id === selectedOrderId)
      const safeIndex = currentIndex >= 0 ? currentIndex : 0

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        userInteractedRef.current = true
        setSelectedOrderId(sortedTickets[Math.min(sortedTickets.length - 1, safeIndex + 1)].id)
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        userInteractedRef.current = true
        setSelectedOrderId(sortedTickets[Math.max(0, safeIndex - 1)].id)
      }

      if (event.key === 'Enter' || event.key === ' ') {
        const currentTicket = sortedTickets[safeIndex]
        const nextStatus = nextStatusMap[currentTicket.status || FOOD_ORDER_STATUSES.new]
        if (nextStatus && pendingOrderId !== currentTicket.id) {
          event.preventDefault()
          statusChangeRef.current(currentTicket, nextStatus)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [sortedTickets, selectedOrderId, pendingOrderId])

  async function handleStatusChange(ticket, nextStatus) {
    if (!nextStatus) return
    if (!actorUid) {
      setErrorMessage('A felhasználói munkamenet még tölt. Próbáld újra egy pillanat múlva.')
      return
    }
    setPendingOrderId(ticket.id)
    setErrorMessage('')
    try {
      await updateFoodOrderStatus({
        eventId,
        orderId: ticket.order.id,
        station: ticket.station,
        nextStatus,
        actorUid,
        actorName,
      })
    } catch (error) {
      console.error('Kitchen status update failed', error)
      setErrorMessage(error.message || 'Nem sikerült frissíteni a rendelés állapotát.')
    } finally {
      setPendingOrderId('')
    }
  }

  statusChangeRef.current = handleStatusChange

  return (
    <div
      className={isFullscreen ? 'kds-fullscreen-shell' : ''}
      ref={boardRef}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}
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

          {/* Station-filter dropdown — inline replacement for the old pill
              row. Label summarises the current selection; menu has multi-
              select checkboxes including Összes (which selects all). */}
          <div className="kds-filter-menu" ref={filterMenuRef}>
            <button
              type="button"
              className={`kds-filter-trigger${filterMenuOpen ? ' is-open' : ''}`}
              onClick={() => setFilterMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={filterMenuOpen}
            >
              <span className="kds-filter-trigger-label">
                {isAllMode
                  ? 'Összes'
                  : (FILTERABLE_STATIONS.filter((s) => selectedStations.has(s))
                      .map((s) => KITCHEN_STATION_LABELS[s])
                      .join(', ') || 'Egyik sem')}
              </span>
              <span className="kds-filter-trigger-caret" aria-hidden="true">▾</span>
            </button>
            {filterMenuOpen ? (
              <div className="kds-filter-menu-panel" role="menu">
                <label className="kds-filter-row">
                  <input
                    type="checkbox"
                    checked={isAllMode}
                    onChange={selectAllStations}
                  />
                  <span className="kds-filter-row-label">Összes</span>
                  <span className="kds-filter-row-count">
                    {activeCountsByStation.burger
                      + activeCountsByStation.gyros
                      + activeCountsByStation.pizza
                      + activeCountsByStation.other}
                  </span>
                </label>
                {FILTERABLE_STATIONS.map((s) => (
                  <label key={s} className="kds-filter-row">
                    <input
                      type="checkbox"
                      checked={!isAllMode && selectedStations.has(s)}
                      onChange={() => toggleStation(s)}
                    />
                    <span
                      className="kds-filter-row-swatch"
                      style={{ background: KITCHEN_STATION_COLORS[s] }}
                      aria-hidden="true"
                    />
                    <span className="kds-filter-row-label">{KITCHEN_STATION_LABELS[s]}</span>
                    <span className="kds-filter-row-count">{activeCountsByStation[s] || 0}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className={`kds-audio-toggle${audioMuted ? ' is-muted' : ''}`}
            onClick={() => setAudioMuted((m) => !m)}
            title={audioMuted ? 'Hangok bekapcsolása' : 'Hangok némítása'}
            aria-label={audioMuted ? 'Hangok bekapcsolása' : 'Hangok némítása'}
          >
            {audioMuted ? 'NÉMA' : 'HANG'}
          </button>
          {!audioUnlocked && !audioMuted ? (
            <span className="kds-audio-unlock-hint" title="Az első kattintás után engedélyezzük a hangot.">
              kattints a hang engedélyezéséhez
            </span>
          ) : null}
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
          const columnTickets = ticketsByStatus[status] || []
          return (
            <div key={status} className={`kds-column ${colClass}`}>
              <div className="kds-column-header">
                <span>{label}</span>
                <span>{columnTickets.length}</span>
              </div>

              <div className="kds-column-body">
                {columnTickets.map((ticket) => {
                  const order = ticket.order
                  const ticketStatus = ticket.status || status || FOOD_ORDER_STATUSES.new
                  const minutesOpen = getMinutesOpen(order.createdAt)
                  const nextStatus = nextStatusMap[ticketStatus]
                  const late = isLate(ticketStatus, minutesOpen)
                  const stationColor = KITCHEN_STATION_COLORS[ticket.station]
                  const stationLabel = KITCHEN_STATION_LABELS[ticket.station]
                  const isSplitOrder = ticket.totalCount > 1
                  // For multi-station orders, tell the chef which OTHER stations
                  // the same customer is waiting on (hover/long-press tooltip).
                  const siblingStations = isSplitOrder
                    ? (order.foodStatusByStation
                        ? Object.keys(order.foodStatusByStation)
                        : Array.from(new Set((order.lines || []).map((l) => {
                            const text = `${l.productName || ''} ${l.modifierTemplateId || ''}`
                            if (/\b(?:ham)?burger\b/i.test(text)) return KITCHEN_STATIONS.burger
                            if (/\bgyros\b/i.test(text)) return KITCHEN_STATIONS.gyros
                            if (/\bpizza\b/i.test(text)) return KITCHEN_STATIONS.pizza
                            return KITCHEN_STATIONS.other
                          }))))
                          .map((s) => KITCHEN_STATION_LABELS[s] || s).join(', ')
                    : ''

                  return (
                    <article
                      key={ticket.id}
                      data-ticket-id={ticket.id}
                      className={`kds-ticket receipt-container kds-ticket--${ticket.station}${late ? ' tone-late' : ''} tone-${ticketStatus === FOOD_ORDER_STATUSES.delivered ? 'delivered' : ticketStatus === FOOD_ORDER_STATUSES.ready ? 'ready' : ticketStatus === FOOD_ORDER_STATUSES.preparing ? 'preparing' : 'new'}${selectedOrderId === ticket.id ? ' selected' : ''}`}
                      style={{ borderLeft: `5px solid ${stationColor}` }}
                      onClick={() => { userInteractedRef.current = true; setSelectedOrderId(ticket.id) }}
                    >
                      <div className="kds-ticket-header receipt-header">
                        <div className="kds-ticket-header-row">
                          <span
                            className={`kds-station-badge kds-station-badge--${ticket.station}`}
                            style={{ background: stationColor }}
                          >
                            {stationLabel}
                          </span>
                          {isSplitOrder ? (
                            <span
                              className="kds-ticket-split-hint"
                              title={`Megosztott rendelés: ${siblingStations}`}
                            >
                              {ticket.index + 1}/{ticket.totalCount}
                            </span>
                          ) : null}
                          <span className="kds-ticket-name">{order.personDisplayName}</span>
                          <span className="kds-ticket-id">#{order.personDisplayId || order.personInternalId}</span>
                        </div>
                        <div className="kds-ticket-meta">
                          <span className="kds-ticket-time">{formatTimestamp(order.createdAt)}</span>
                          <div className="kds-ticket-meta-right">
                            <span className={`kds-status-badge ${ticketStatus}${late ? ' late' : ''}`}>
                              {late ? 'KÉSÉS' : statusLabelMap[ticketStatus]}
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
                        {ticket.lines.map((line) => (
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
                          <span>{ticket.lines.reduce((sum, line) => sum + (line.quantity || 0), 0)}</span>
                        </div>
                        {nextStatus ? (
                          <button
                            type="button"
                            className="primary-button"
                            style={{ width: '100%', padding: '10px', fontWeight: 800, fontSize: '0.85rem' }}
                            onClick={(event) => { event.stopPropagation(); handleStatusChange(ticket, nextStatus) }}
                            disabled={pendingOrderId === ticket.id || !actorUid}
                          >
                            {pendingOrderId === ticket.id ? '...' : actionLabelMap[ticketStatus]}
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

                {columnTickets.length === 0 && (
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
