import { useMemo, useState } from 'react'
import { formatHuf } from '../../lib/money'
import { getAttendeeTypeLabel } from '../people/personModels'

const ARROW_UP = '▲'
const ARROW_DOWN = '▼'

function useSortable(rows, defaultKey, defaultDir = 'desc') {
  const [sortKey, setSortKey] = useState(defaultKey)
  const [sortDir, setSortDir] = useState(defaultDir)

  const sorted = useMemo(() => {
    const arr = [...rows]
    arr.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc'
          ? av.localeCompare(bv, 'hu')
          : bv.localeCompare(av, 'hu')
      }
      const an = typeof av === 'number' ? av : Number(av) || 0
      const bn = typeof bv === 'number' ? bv : Number(bv) || 0
      return sortDir === 'asc' ? an - bn : bn - an
    })
    return arr
  }, [rows, sortKey, sortDir])

  function onSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      // Strings default to asc; numbers default to desc — what people expect.
      const sample = rows.find((r) => r[key] !== undefined)?.[key]
      setSortDir(typeof sample === 'string' ? 'asc' : 'desc')
    }
  }

  return { sorted, sortKey, sortDir, onSort }
}

function SortHeader({ label, sortKey, currentKey, currentDir, onSort, align = 'left' }) {
  const active = sortKey === currentKey
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{
        cursor: 'pointer',
        userSelect: 'none',
        textAlign: align,
        padding: '8px 10px',
        fontSize: '0.78rem',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: active ? 'var(--primary)' : 'var(--muted)',
        whiteSpace: 'nowrap',
      }}
    >
      {label} {active ? (currentDir === 'asc' ? ARROW_UP : ARROW_DOWN) : ''}
    </th>
  )
}

// ── Top spenders ─────────────────────────────────────────────────────────────

export function TopSpendersTable({ spendByCustomer, limit = 20 }) {
  const rows = useMemo(() => {
    const all = Array.from(spendByCustomer.values()).map((r) => ({
      ...r,
      avg: r.count > 0 ? Math.round(r.total / r.count) : 0,
    }))
    return all
  }, [spendByCustomer])

  const { sorted, sortKey, sortDir, onSort } = useSortable(rows, 'total', 'desc')
  const visible = sorted.slice(0, limit)

  if (!rows.length) {
    return <p className="helper-text">Még nincs vendég-szintű adat.</p>
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <SortHeader label="Név" sortKey="name" currentKey={sortKey} currentDir={sortDir} onSort={onSort} />
            <SortHeader label="Csapat" sortKey="team" currentKey={sortKey} currentDir={sortDir} onSort={onSort} />
            <SortHeader label="Típus" sortKey="attendeeType" currentKey={sortKey} currentDir={sortDir} onSort={onSort} />
            <SortHeader label="Rendelés" sortKey="count" currentKey={sortKey} currentDir={sortDir} onSort={onSort} align="right" />
            <SortHeader label="Átlag" sortKey="avg" currentKey={sortKey} currentDir={sortDir} onSort={onSort} align="right" />
            <SortHeader label="Összesen" sortKey="total" currentKey={sortKey} currentDir={sortDir} onSort={onSort} align="right" />
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <tr key={row.personId} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '8px 10px' }}>
                <strong>{row.name}</strong>
                {row.displayId ? (
                  <small style={{ display: 'block', color: 'var(--muted)' }}>#{row.displayId}</small>
                ) : null}
              </td>
              <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{row.team || '—'}</td>
              <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>
                {row.attendeeType ? getAttendeeTypeLabel(row.attendeeType) : '—'}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{row.count}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{formatHuf(row.avg)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>
                {formatHuf(row.total)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > limit ? (
        <p className="helper-text" style={{ marginTop: '8px' }}>
          Top {limit} látszik a {sorted.length} vendég közül.
        </p>
      ) : null}
    </div>
  )
}

// ── Staff activity ──────────────────────────────────────────────────────────

export function StaffActivityTable({ ordersByStaff }) {
  const rows = useMemo(() => Array.from(ordersByStaff.values()).map((r) => ({
    ...r,
    avg: r.count > 0 ? Math.round(r.revenue / r.count) : 0,
  })), [ordersByStaff])

  const { sorted, sortKey, sortDir, onSort } = useSortable(rows, 'revenue', 'desc')

  if (!rows.length) {
    return <p className="helper-text">Még nincs személyzet-szintű adat.</p>
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <SortHeader label="Név" sortKey="name" currentKey={sortKey} currentDir={sortDir} onSort={onSort} />
            <SortHeader label="Rendelés" sortKey="count" currentKey={sortKey} currentDir={sortDir} onSort={onSort} align="right" />
            <SortHeader label="Átlag kosár" sortKey="avg" currentKey={sortKey} currentDir={sortDir} onSort={onSort} align="right" />
            <SortHeader label="Bevétel" sortKey="revenue" currentKey={sortKey} currentDir={sortDir} onSort={onSort} align="right" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.uid} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '8px 10px' }}>
                <strong>{row.name}</strong>
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{row.count}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{formatHuf(row.avg)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>
                {formatHuf(row.revenue)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Most-refunded products ──────────────────────────────────────────────────

export function RefundedProductsTable({ productStats }) {
  const rows = useMemo(() => Array.from(productStats.values())
    .filter((p) => p.refundedQty > 0)
    .map((p) => ({
      key: p.key,
      name: p.name,
      category: p.category,
      refundedQty: p.refundedQty,
      qty: p.qty,
    })), [productStats])

  const { sorted, sortKey, sortDir, onSort } = useSortable(rows, 'refundedQty', 'desc')

  if (!rows.length) {
    return <p className="helper-text">Nem történt visszatérítés.</p>
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <SortHeader label="Termék" sortKey="name" currentKey={sortKey} currentDir={sortDir} onSort={onSort} />
            <SortHeader label="Kategória" sortKey="category" currentKey={sortKey} currentDir={sortDir} onSort={onSort} />
            <SortHeader label="Visszatérítve (db)" sortKey="refundedQty" currentKey={sortKey} currentDir={sortDir} onSort={onSort} align="right" />
            <SortHeader label="Nettó eladva (db)" sortKey="qty" currentKey={sortKey} currentDir={sortDir} onSort={onSort} align="right" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.key} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '8px 10px' }}><strong>{row.name}</strong></td>
              <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{row.category}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--danger)', fontWeight: 700 }}>
                {row.refundedQty}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{row.qty}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
