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
          <h3 className="card-title">Sales and outcome</h3>
          <p className="helper-text">
            Metrics are computed from immutable orders plus event ledger entries. Historical views do not depend on current product documents.
          </p>
        </div>
        <div className="pill-row">
          <span className="event-pill">{event?.status || 'No event selected'}</span>
          {event?.startsOn ? <span className="event-pill">{event.startsOn}</span> : null}
        </div>
      </div>

      {loading ? <p className="helper-text">Loading statistics...</p> : null}

      {!loading ? (
        <div className="stack-block">
          <div className="metric-grid">
            <MetricCard label="Total top-ups" value={formatHuf(stats.totalTopups)} />
            <MetricCard label="Total spent" value={formatHuf(stats.totalSpent)} />
            <MetricCard label="Refunded amount" value={formatHuf(stats.refundedAmount)} />
            <MetricCard label="Net sales" value={formatHuf(stats.netSales)} />
            <MetricCard label="Orders" value={String(stats.totalOrders)} helper={`${stats.foodOrderCount} food orders`} />
            <MetricCard
              label="Outstanding negative balances"
              value={formatHuf(stats.outstandingNegativeBalanceTotal)}
              helper={`${stats.outstandingNegativeBalanceCount} people`}
            />
          </div>

          <div className="two-column-grid">
            <section className="panel nested-panel">
              <h4 className="card-title">Top-selling products</h4>
              <div className="record-list">
                {stats.topSellingProducts.map((product) => (
                  <div key={product.key} className="record-row">
                    <span>
                      <strong>{product.productName}</strong>
                      <small>
                        {product.category} | Refunded {product.refundedQuantity}
                      </small>
                    </span>
                    <span>
                      <strong>{product.netQuantity} sold</strong>
                      <small>{formatHuf(product.netRevenue)}</small>
                    </span>
                  </div>
                ))}
                {stats.topSellingProducts.length === 0 ? (
                  <p className="helper-text">No finalized orders for this event yet.</p>
                ) : null}
              </div>
            </section>

            <section className="panel nested-panel">
              <h4 className="card-title">Sales by category</h4>
              <div className="record-list">
                {stats.salesByCategory.map((category) => (
                  <div key={category.category} className="record-row">
                    <span>
                      <strong>{category.category}</strong>
                      <small>{category.netQuantity} net items</small>
                    </span>
                    <span>
                      <strong>{formatHuf(category.netRevenue)}</strong>
                      <small>Refunded {formatHuf(category.refundedRevenue)}</small>
                    </span>
                  </div>
                ))}
                {stats.salesByCategory.length === 0 ? (
                  <p className="helper-text">No category totals yet.</p>
                ) : null}
              </div>
            </section>
          </div>
        </div>
      ) : null}
    </section>
  )
}
