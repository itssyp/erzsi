import { useEffect, useMemo, useState } from 'react'
import { formatHuf } from '../../lib/money'
import { getAttendeeTypeLabel } from '../people/personModels'
import { subscribeToEventsList } from '../events/eventService'
import { useEventStatistics } from './useEventStatistics'
import {
  buildCustomerCsv,
  buildDailyCsv,
  buildProductCsv,
  bucketRevenueNet,
  categoryDataset,
  downloadCsv,
  emptyBucket,
  formatDayLabel,
  topRows,
} from './eventAnalyticsHelpers'
import {
  CategoryBar,
  CategoryDonut,
  CumulativeRevenueChart,
  DailyRevenueChart,
  DayHourHeatmap,
  HourBarChart,
  RefundTimelineChart,
  SoldReturnedAreaChart,
  StaffRevenueBar,
  TopProductsBar,
} from './EventAnalyticsCharts'
import { RefundedProductsTable, StaffActivityTable, TopSpendersTable } from './EventAnalyticsTables'

const MODE = { aggregate: 'aggregate', daily: 'daily' }

function KpiCard({ label, value, sub, tone }) {
  const valueColor = tone === 'danger'
    ? 'var(--danger)'
    : tone === 'primary'
      ? 'var(--primary)'
      : tone === 'muted'
        ? 'var(--muted)'
        : undefined
  return (
    <div className="catalog-summary-card">
      <span className="catalog-summary-label">{label}</span>
      <strong style={{ fontSize: '1.5rem', color: valueColor }}>{value}</strong>
      {sub ? <p className="helper-text">{sub}</p> : null}
    </div>
  )
}

function EventPicker({ events, value, onChange, activeEventId }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}>
      Esemény
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ padding: '6px 8px', minWidth: '220px' }}
      >
        {events.map((event) => {
          const isActive = event.id === activeEventId
          return (
            <option key={event.id} value={event.id}>
              {event.name || event.code || event.id}{isActive ? '  •  aktív' : ''}
              {event.startsOn ? `  (${event.startsOn})` : ''}
            </option>
          )
        })}
      </select>
    </label>
  )
}

function safeFilename(name) {
  return String(name || 'esemeny')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    || 'esemeny'
}

function ExportMenu({ stats, aggregate, eventName, disabled }) {
  function handleExport(kind) {
    const base = safeFilename(eventName)
    if (kind === 'daily') {
      downloadCsv(`${base}-napi.csv`, buildDailyCsv(stats.daily))
    } else if (kind === 'products') {
      downloadCsv(`${base}-termekek.csv`, buildProductCsv(aggregate.productStats))
    } else if (kind === 'customers') {
      downloadCsv(`${base}-vendegek.csv`, buildCustomerCsv(aggregate.spendByCustomer))
    }
  }

  return (
    <label
      style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}
      title={disabled ? 'Nincs adat az exporthoz' : 'CSV letöltése'}
    >
      Export
      <select
        defaultValue=""
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value
          e.target.value = '' /* reset so the same export can be re-triggered */
          if (v) handleExport(v)
        }}
        style={{ padding: '6px 8px', minWidth: '170px' }}
      >
        <option value="" disabled>Válassz exportot…</option>
        <option value="daily">Napi összesítés</option>
        <option value="products">Termékenként</option>
        <option value="customers">Vendégenként</option>
      </select>
    </label>
  )
}

function ModeToggle({ value, onChange }) {
  return (
    <div className="category-row" style={{ marginBottom: 0 }}>
      <button
        type="button"
        className={`category-btn${value === MODE.aggregate ? ' active' : ''}`}
        onClick={() => onChange(MODE.aggregate)}
      >
        Összesen
      </button>
      <button
        type="button"
        className={`category-btn${value === MODE.daily ? ' active' : ''}`}
        onClick={() => onChange(MODE.daily)}
      >
        Napi bontás
      </button>
    </div>
  )
}

function DayPicker({ eventDays, value, onChange }) {
  if (!eventDays.length) {
    return <span className="helper-text">Nincs naphoz rendelhető rendelés.</span>
  }
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}>
      Nap
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        style={{ padding: '6px 8px', minWidth: '200px' }}
      >
        {eventDays.map((iso) => (
          <option key={iso} value={iso}>
            {formatDayLabel(iso)}
          </option>
        ))}
      </select>
    </label>
  )
}

export function EventAnalyticsPanel({ activeEventId }) {
  const [events, setEvents] = useState([])
  const [eventListError, setEventListError] = useState('')
  const [selectedEventId, setSelectedEventId] = useState(activeEventId || '')
  const [mode, setMode] = useState(MODE.aggregate)
  const [selectedDay, setSelectedDay] = useState(null)

  useEffect(() => {
    return subscribeToEventsList(setEvents, (error) => setEventListError(error.message))
  }, [])

  // Default to the active event whenever it becomes available and nothing is picked.
  useEffect(() => {
    if (!selectedEventId && activeEventId) {
      setSelectedEventId(activeEventId)
    }
  }, [activeEventId, selectedEventId])

  // If the picked event was deleted / no longer exists, fall back to active.
  useEffect(() => {
    if (!selectedEventId || !events.length) return
    const exists = events.some((e) => e.id === selectedEventId)
    if (!exists) setSelectedEventId(activeEventId || events[0]?.id || '')
  }, [events, selectedEventId, activeEventId])

  const stats = useEventStatistics(selectedEventId)

  // Default-select the last day with data the first time we enter daily mode.
  useEffect(() => {
    if (mode !== MODE.daily) return
    if (selectedDay && stats.byDate.has(selectedDay)) return
    if (stats.eventDays.length > 0) {
      setSelectedDay(stats.eventDays[stats.eventDays.length - 1])
    }
  }, [mode, selectedDay, stats.eventDays, stats.byDate])

  // Reset day selection when switching events
  useEffect(() => {
    setSelectedDay(null)
  }, [selectedEventId])

  const selectedEvent = useMemo(
    () => events.find((e) => e.id === selectedEventId) || null,
    [events, selectedEventId],
  )

  const bucket = useMemo(() => {
    if (mode === MODE.aggregate) return stats.aggregate
    if (selectedDay) return stats.byDate.get(selectedDay) || emptyBucket()
    return emptyBucket()
  }, [mode, selectedDay, stats.aggregate, stats.byDate])

  const subLabel = mode === MODE.aggregate
    ? 'Teljes esemény'
    : (selectedDay ? formatDayLabel(selectedDay) : 'Válassz napot')

  return (
    <div className="admin-section">
      <section className="page-heading">
        <span className="eyebrow">Statisztika</span>
        <h3>Esemény statisztika</h3>
        <p className="muted">
          Bevétel, tételek, vendégek és személyzet bontása — élő, az adatok automatikusan frissülnek.
        </p>
      </section>

      {eventListError ? <div className="error-banner">{eventListError}</div> : null}
      {Object.entries(stats.errors).map(([k, msg]) => (
        <div key={k} className="error-banner">
          <strong>{k}:</strong> {msg}
        </div>
      ))}

      {/* Toolbar */}
      <section
        className="panel"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '14px 22px',
          marginBottom: '16px',
        }}
      >
        <EventPicker
          events={events}
          value={selectedEventId}
          onChange={setSelectedEventId}
          activeEventId={activeEventId}
        />
        <ModeToggle value={mode} onChange={setMode} />
        {mode === MODE.daily ? (
          <DayPicker
            eventDays={stats.eventDays}
            value={selectedDay}
            onChange={setSelectedDay}
          />
        ) : null}
        <ExportMenu
          stats={stats}
          aggregate={stats.aggregate}
          eventName={selectedEvent?.name || selectedEventId || 'esemeny'}
          disabled={stats.loading || stats.aggregate.orderCount === 0}
        />
        <span style={{ marginLeft: 'auto', fontSize: '0.78rem', color: 'var(--muted)' }}>
          {subLabel}{selectedEvent ? ` · ${selectedEvent.name}` : ''}
        </span>
      </section>

      {/* KPI strip */}
      <div className="catalog-summary-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <KpiCard
          label="Bevétel"
          value={formatHuf(bucket.revenueGross)}
          sub={bucket.creditReturnsTotal > 0
            ? `−${formatHuf(bucket.creditReturnsTotal)} visszaváltás`
            : '—'}
        />
        <KpiCard
          label="Visszatérítés"
          value={formatHuf(bucket.refundsTotal)}
          tone={bucket.refundsTotal > 0 ? 'danger' : 'muted'}
          sub={bucket.refundsTotal > 0 ? 'Refund összesen' : 'Nincs refund'}
        />
        <KpiCard
          label="Nettó"
          value={formatHuf(bucketRevenueNet(bucket))}
          tone="primary"
          sub="Bevétel − refund"
        />
        <KpiCard
          label="Rendelések"
          value={bucket.orderCount}
          sub={bucket.avgOrderValue
            ? `Átlag kosár: ${formatHuf(bucket.avgOrderValue)}`
            : '—'}
        />
        <KpiCard
          label="Tételek"
          value={bucket.itemCount}
          sub="Eladott darabszám"
        />
        <KpiCard
          label="Egyedi vendégek"
          value={bucket.uniqueCustomers.size}
          sub={bucket.topupsTotal > 0
            ? `Feltöltés: ${formatHuf(bucket.topupsTotal)}`
            : '—'}
        />
      </div>

      {stats.loading ? (
        <p className="helper-text" style={{ marginTop: '14px' }}>Adatok betöltése…</p>
      ) : null}

      {/* Empty-state for events with no data yet */}
      {!stats.loading && bucket.orderCount === 0 ? (
        <p className="helper-text" style={{ marginTop: '14px' }}>
          {mode === MODE.daily
            ? 'Ezen a napon nem történt rendelés.'
            : 'Ebben az eseményben még nincs rendelés.'}
        </p>
      ) : null}

      {/* Time-series always shows whole-event scope and offers click-to-select-day */}
      {stats.daily.length > 0 ? (
        <TimeSeriesSection
          daily={stats.daily}
          aggregate={stats.aggregate}
          dayBucket={mode === MODE.daily && selectedDay ? stats.byDate.get(selectedDay) : null}
          selectedDay={mode === MODE.daily ? selectedDay : null}
          onSelectDay={(d) => {
            setMode(MODE.daily)
            setSelectedDay(d)
          }}
        />
      ) : null}

      {bucket.orderCount > 0 ? (
        <>
          <CompositionSection bucket={bucket} />
          <PeopleSection bucket={bucket} />
          <StaffSection bucket={bucket} />
          <RefundsSection bucket={bucket} daily={stats.daily} mode={mode} />
          <SpecialsSection
            daily={stats.daily}
            aggregate={stats.aggregate}
            activeBucket={bucket}
            mode={mode}
          />
        </>
      ) : null}

      {/* Phase 6 (CSV export) will mount here. */}
    </div>
  )
}

// ── Phase 5: staff ──────────────────────────────────────────────────────────

function StaffSection({ bucket }) {
  const barData = useMemo(() => {
    return Array.from(bucket.ordersByStaff.values())
      .filter((r) => r.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 12)
      .map((r) => ({ name: r.name, revenue: r.revenue }))
  }, [bucket.ordersByStaff])

  if (!bucket.ordersByStaff.size) return null

  return (
    <section style={{ marginTop: '20px' }}>
      <h4 className="card-title" style={{ marginBottom: '12px' }}>Személyzet</h4>
      <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        <div className="panel">
          <h5 className="card-title" style={{ marginBottom: '8px' }}>Rendelések és bevétel</h5>
          <StaffActivityTable ordersByStaff={bucket.ordersByStaff} />
        </div>
        <div className="panel">
          <h5 className="card-title" style={{ marginBottom: '6px' }}>Top 12 bevétel szerint</h5>
          <StaffRevenueBar data={barData} />
        </div>
      </div>
    </section>
  )
}

// ── Phase 5: refunds ────────────────────────────────────────────────────────

function RefundsSection({ bucket, daily, mode }) {
  const refundTimelineData = useMemo(
    () => daily.map((d) => ({ date: d.date, refund: d.refundsTotal || 0 })),
    [daily],
  )
  const hasAnyRefund = mode === MODE.daily
    ? bucket.refundsTotal > 0
    : daily.some((d) => (d.refundsTotal || 0) > 0)

  if (!hasAnyRefund) return null

  return (
    <section style={{ marginTop: '20px' }}>
      <h4 className="card-title" style={{ marginBottom: '12px' }}>Visszatérítések</h4>

      <div className="catalog-summary-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: '14px' }}>
        <div className="catalog-summary-card">
          <span className="catalog-summary-label">Visszatérítve</span>
          <strong style={{ fontSize: '1.5rem', color: 'var(--danger)' }}>
            {formatHuf(bucket.refundsTotal)}
          </strong>
          <p className="helper-text">
            {mode === MODE.daily ? 'Kiválasztott napon' : 'Esemény összesen'}
          </p>
        </div>
      </div>

      <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        <div className="panel">
          <h5 className="card-title" style={{ marginBottom: '6px' }}>Visszatérítések napi idővonalon</h5>
          <p className="helper-text" style={{ marginBottom: '4px' }}>Mindig esemény-szintű nézet.</p>
          <RefundTimelineChart data={refundTimelineData} />
        </div>
        <div className="panel">
          <h5 className="card-title" style={{ marginBottom: '8px' }}>Leginkább visszatérített termékek</h5>
          <RefundedProductsTable productStats={bucket.productStats} />
        </div>
      </div>
    </section>
  )
}

// ── Phase 4: DRS + Repohár ──────────────────────────────────────────────────

function buildSpecialsSeries(daily, soldKey, returnedKey) {
  let cumulativeSold = 0
  let cumulativeReturned = 0
  return daily.map((d) => {
    cumulativeSold += d[soldKey] || 0
    cumulativeReturned += d[returnedKey] || 0
    return {
      date: d.date,
      sold: d[soldKey] || 0,
      returned: d[returnedKey] || 0,
      outstanding: cumulativeSold - cumulativeReturned,
    }
  })
}

function StatTriplet({ sold, returned, outstanding, unit }) {
  const net = sold - returned
  return (
    <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', marginBottom: '10px' }}>
      <span>
        <strong style={{ fontSize: '1.25rem', display: 'block' }}>{sold}</strong>
        <small style={{ color: 'var(--muted)' }}>kiadott {unit}</small>
      </span>
      <span>
        <strong style={{ fontSize: '1.25rem', display: 'block' }}>{returned}</strong>
        <small style={{ color: 'var(--muted)' }}>visszahozott {unit}</small>
      </span>
      <span>
        <strong
          style={{
            fontSize: '1.25rem',
            display: 'block',
            color: outstanding > 0 ? 'var(--primary)' : net < 0 ? 'var(--danger)' : undefined,
          }}
        >
          {outstanding}
        </strong>
        <small style={{ color: 'var(--muted)' }}>forgalomban {unit}</small>
      </span>
    </div>
  )
}

function SpecialsSection({ daily, aggregate, activeBucket, mode }) {
  const drsSeries = useMemo(
    () => buildSpecialsSeries(daily, 'drsBottlesSold', 'drsBottlesReturned'),
    [daily],
  )
  const cupSeries = useMemo(
    () => buildSpecialsSeries(daily, 'reusableCupsSold', 'reusableCupsReturned'),
    [daily],
  )

  // The sold/returned numbers respect the mode (selected day in daily mode,
  // event total in aggregate mode). The outstanding number is always
  // event-wide because that's the only number that physically makes sense.
  const drsSold = activeBucket.drsBottlesSold
  const drsReturned = activeBucket.drsBottlesReturned
  const drsOutstanding = aggregate.drsBottlesSold - aggregate.drsBottlesReturned
  const cupSold = activeBucket.reusableCupsSold
  const cupReturned = activeBucket.reusableCupsReturned
  const cupOutstanding = aggregate.reusableCupsSold - aggregate.reusableCupsReturned

  const hasDrs = aggregate.drsBottlesSold > 0 || aggregate.drsBottlesReturned > 0
  const hasCups = aggregate.reusableCupsSold > 0 || aggregate.reusableCupsReturned > 0
  if (!hasDrs && !hasCups) return null

  const scopeNote = mode === MODE.daily
    ? 'A "kiadott" és "visszahozott" számok a kiválasztott napra vonatkoznak. A "forgalomban" mindig az esemény teljes egyenlege.'
    : 'Esemény-szintű összesítés.'

  return (
    <section style={{ marginTop: '20px' }}>
      <h4 className="card-title" style={{ marginBottom: '4px' }}>Speciális tételek</h4>
      <p className="helper-text" style={{ marginBottom: '12px' }}>{scopeNote}</p>

      <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}>
        {hasDrs ? (
          <div className="panel">
            <h5 className="card-title" style={{ marginBottom: '6px' }}>DRS palackok</h5>
            <StatTriplet
              sold={drsSold}
              returned={drsReturned}
              outstanding={drsOutstanding}
              unit="palack"
            />
            <SoldReturnedAreaChart
              data={drsSeries}
              soldLabel="Eladva"
              returnedLabel="Visszahozva"
              outstandingLabel="Halmozott forgalom"
            />
          </div>
        ) : null}
        {hasCups ? (
          <div className="panel">
            <h5 className="card-title" style={{ marginBottom: '6px' }}>Repohár</h5>
            <StatTriplet
              sold={cupSold}
              returned={cupReturned}
              outstanding={cupOutstanding}
              unit="pohár"
            />
            <SoldReturnedAreaChart
              data={cupSeries}
              soldLabel="Eladva"
              returnedLabel="Visszahozva"
              outstandingLabel="Halmozott forgalom"
            />
          </div>
        ) : null}
      </div>
    </section>
  )
}

// ── Phase 3: time series ────────────────────────────────────────────────────

function TimeSeriesSection({ daily, aggregate, dayBucket, selectedDay, onSelectDay }) {
  // Daily revenue dataset (with running total for the cumulative chart).
  const dailyData = useMemo(() => {
    let running = 0
    return daily.map((d) => {
      running += d.revenueGross
      return {
        date: d.date,
        revenue: d.revenueGross,
        orders: d.orderCount,
        cumulative: running,
      }
    })
  }, [daily])

  // Per-hour dataset: when a day is selected, show that day; otherwise show the
  // event-wide hourly totals from the aggregate bucket.
  const hourSource = dayBucket || aggregate
  const hourData = useMemo(
    () => hourSource.ordersByHour.map((count, hour) => ({
      hour,
      value: count,
      revenue: hourSource.revenueByHour[hour] || 0,
    })),
    [hourSource],
  )
  const hourRevenueData = useMemo(
    () => hourSource.revenueByHour.map((revenue, hour) => ({ hour, value: revenue })),
    [hourSource],
  )

  // Heatmap matrix only makes sense when there are ≥2 days with data.
  const heatmap = useMemo(() => {
    if (daily.length < 2) return null
    const days = daily.map((d) => d.date)
    const matrix = daily.map((d) => d.revenueByHour.slice())
    let max = 0
    for (const row of matrix) {
      for (const v of row) if (v > max) max = v
    }
    return { days, matrix, max }
  }, [daily])

  const hourScopeLabel = dayBucket
    ? `${formatDayLabel(dayBucket.date)} órás bontás`
    : 'Esemény teljes órás bontása'

  return (
    <section style={{ marginTop: '20px' }}>
      <h4 className="card-title" style={{ marginBottom: '12px' }}>Időrend</h4>

      <div className="panel" style={{ marginBottom: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px', gap: '10px' }}>
          <h5 className="card-title" style={{ margin: 0 }}>Napi bevétel</h5>
          <small style={{ color: 'var(--muted)' }}>
            Kattints egy oszlopra a napi nézethez
          </small>
        </div>
        <DailyRevenueChart
          data={dailyData}
          onSelectDay={onSelectDay}
          selectedDay={selectedDay}
        />
      </div>

      <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}>
        <div className="panel">
          <h5 className="card-title" style={{ marginBottom: '6px' }}>Halmozott bevétel</h5>
          <CumulativeRevenueChart data={dailyData} />
        </div>
        <div className="panel">
          <h5 className="card-title" style={{ marginBottom: '6px' }}>Rendelések óránként</h5>
          <p className="helper-text" style={{ marginBottom: '4px' }}>{hourScopeLabel}</p>
          <HourBarChart data={hourData} />
        </div>
      </div>

      <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', marginTop: '14px' }}>
        <div className="panel">
          <h5 className="card-title" style={{ marginBottom: '6px' }}>Bevétel óránként</h5>
          <p className="helper-text" style={{ marginBottom: '4px' }}>{hourScopeLabel}</p>
          <HourBarChart data={hourRevenueData} huf />
        </div>

        {heatmap ? (
          <div className="panel">
            <h5 className="card-title" style={{ marginBottom: '6px' }}>Bevétel hőtérkép (nap × óra)</h5>
            <p className="helper-text" style={{ marginBottom: '8px' }}>
              Kattints egy cellára egy nap kiválasztásához
            </p>
            <DayHourHeatmap
              days={heatmap.days}
              matrix={heatmap.matrix}
              max={heatmap.max}
              onSelectCell={(day) => onSelectDay?.(day)}
            />
          </div>
        ) : null}
      </div>
    </section>
  )
}

// ── Phase 2: composition ─────────────────────────────────────────────────────

function CompositionSection({ bucket }) {
  const revenueByCategory = useMemo(
    () => categoryDataset(bucket.revenueByCategory),
    [bucket.revenueByCategory],
  )
  const itemsByCategory = useMemo(
    () => categoryDataset(bucket.itemsByCategory),
    [bucket.itemsByCategory],
  )
  const topProductsByQty = useMemo(
    () => topRows(bucket.productStats, 'qty', 10).map((p) => ({ ...p, name: p.name })),
    [bucket.productStats],
  )
  const topProductsByRevenue = useMemo(
    () => topRows(bucket.productStats, 'revenue', 10).map((p) => ({ ...p, name: p.name })),
    [bucket.productStats],
  )

  return (
    <section style={{ marginTop: '20px' }}>
      <h4 className="card-title" style={{ marginBottom: '12px' }}>Termékösszetétel</h4>
      <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <div className="panel">
          <h5 className="card-title" style={{ marginBottom: '6px' }}>Bevétel kategóriánként</h5>
          <CategoryDonut data={revenueByCategory} huf />
        </div>
        <div className="panel">
          <h5 className="card-title" style={{ marginBottom: '6px' }}>Eladott tételek kategóriánként</h5>
          <CategoryBar data={itemsByCategory} />
        </div>
      </div>

      <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', marginTop: '16px' }}>
        <div className="panel">
          <h5 className="card-title" style={{ marginBottom: '6px' }}>Top 10 termék (darab)</h5>
          <TopProductsBar data={topProductsByQty} valueKey="qty" />
        </div>
        <div className="panel">
          <h5 className="card-title" style={{ marginBottom: '6px' }}>Top 10 termék (bevétel)</h5>
          <TopProductsBar data={topProductsByRevenue} valueKey="revenue" huf />
        </div>
      </div>
    </section>
  )
}

// ── Phase 2: people ──────────────────────────────────────────────────────────

function PeopleSection({ bucket }) {
  // Roll up the spendByCustomer map into team / attendee-type aggregates.
  const { byTeamDataset, byAttendeeDataset } = useMemo(() => {
    const teams = new Map()
    const types = new Map()
    bucket.spendByCustomer.forEach((row) => {
      const teamKey = row.team || '— ismeretlen —'
      teams.set(teamKey, (teams.get(teamKey) || 0) + row.total)
      const typeKey = row.attendeeType
        ? getAttendeeTypeLabel(row.attendeeType)
        : '— ismeretlen —'
      types.set(typeKey, (types.get(typeKey) || 0) + row.total)
    })
    return {
      byTeamDataset: categoryDataset(teams),
      byAttendeeDataset: categoryDataset(types),
    }
  }, [bucket.spendByCustomer])

  return (
    <section style={{ marginTop: '20px' }}>
      <h4 className="card-title" style={{ marginBottom: '12px' }}>Vendégek</h4>

      <div className="panel" style={{ marginBottom: '16px' }}>
        <h5 className="card-title" style={{ marginBottom: '8px' }}>Top költők</h5>
        <TopSpendersTable spendByCustomer={bucket.spendByCustomer} />
      </div>

      <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <div className="panel">
          <h5 className="card-title" style={{ marginBottom: '6px' }}>Bevétel csapatonként</h5>
          <CategoryDonut data={byTeamDataset} huf />
        </div>
        <div className="panel">
          <h5 className="card-title" style={{ marginBottom: '6px' }}>Bevétel résztvevő-típus szerint</h5>
          <CategoryBar data={byAttendeeDataset} huf />
        </div>
      </div>
    </section>
  )
}
