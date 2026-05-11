import { formatHuf } from '../../lib/money'

function MetricCard({ label, value, helper }) {
  return (
    <article className="metric-card">
      <strong>{value}</strong>
      <span>{label}</span>
      {helper ? <small>{helper}</small> : null}
    </article>
  )
}

export function EventStatisticsPanel({ event, loading, stats }) {
  return (
    <section className="panel">
      <div className="split-header">
        <div>
          <h3 className="card-title">Eladások és eredmény</h3>
          <p className="helper-text">
            A mutatók a lezárt rendelésekből és az esemény ledger bejegyzéseiből készülnek. A történeti nézet nem függ az aktuális termékdokumentumoktól.
          </p>
        </div>
        <div className="pill-row">
          <span className="event-pill">{event?.status || 'Nincs kiválasztott esemény'}</span>
          {event?.startsOn ? <span className="event-pill">{event.startsOn}</span> : null}
        </div>
      </div>

      {loading ? <p className="helper-text">Statisztikák betöltése...</p> : null}

      {!loading ? (
        <div className="stack-block">
          <div className="metric-grid">
            <MetricCard label="Összes feltöltés" value={formatHuf(stats.totalTopups)} />
            <MetricCard label="Összes költés" value={formatHuf(stats.totalSpent)} />
            <MetricCard label="Visszatérített összeg" value={formatHuf(stats.refundedAmount)} />
            <MetricCard label="Nettó eladás" value={formatHuf(stats.netSales)} />
            <MetricCard label="Rendelések" value={String(stats.totalOrders)} helper={`${stats.foodOrderCount} ételrendelés`} />
            <MetricCard
              label="Fennálló negatív egyenlegek"
              value={formatHuf(stats.outstandingNegativeBalanceTotal)}
              helper={`${stats.outstandingNegativeBalanceCount} fő`}
            />
          </div>

          <div className="two-column-grid">
            <section className="panel nested-panel">
              <h4 className="card-title">Legkelendőbb termékek</h4>
              <div className="record-list">
                {stats.topSellingProducts.map((product) => (
                  <div key={product.key} className="record-row">
                    <span>
                      <strong>{product.productName}</strong>
                      <small>
                         {product.category} | Visszatérítve {product.refundedQuantity}
                      </small>
                    </span>
                    <span>
                      <strong>{product.netQuantity} eladva</strong>
                      <small>{formatHuf(product.netRevenue)}</small>
                    </span>
                  </div>
                ))}
                {stats.topSellingProducts.length === 0 ? (
                  <p className="helper-text">Ehhez az eseményhez még nincs lezárt rendelés.</p>
                ) : null}
              </div>
            </section>

            <section className="panel nested-panel">
              <h4 className="card-title">Eladások kategóriánként</h4>
              <div className="record-list">
                {stats.salesByCategory.map((category) => (
                  <div key={category.category} className="record-row">
                    <span>
                      <strong>{category.category}</strong>
                      <small>{category.netQuantity} nettó tétel</small>
                    </span>
                    <span>
                      <strong>{formatHuf(category.netRevenue)}</strong>
                      <small>Visszatérítve {formatHuf(category.refundedRevenue)}</small>
                    </span>
                  </div>
                ))}
                {stats.salesByCategory.length === 0 ? (
                  <p className="helper-text">Még nincs kategóriaösszesítő.</p>
                ) : null}
              </div>
            </section>
          </div>
        </div>
      ) : null}
    </section>
  )
}
