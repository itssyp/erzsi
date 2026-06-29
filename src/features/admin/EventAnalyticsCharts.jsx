// ───────────────────────────────────────────────────────────────────────────────
// Recharts wrappers for the Statisztika tab. Each chart is responsible for its
// own ResponsiveContainer + sensible defaults so the panel file stays terse.
// All datasets coming in are already shaped + sorted by eventAnalyticsHelpers.
// ───────────────────────────────────────────────────────────────────────────────
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatHuf } from '../../lib/money'
import { colorForCategory, formatDayLabel } from './eventAnalyticsHelpers'

const AXIS_TICK = { fontSize: 11, fill: 'var(--muted)' }
const GRID_COLOR = 'rgba(120,120,120,0.18)'

function tooltipFormatterHuf(value) {
  return formatHuf(value)
}
function tooltipFormatterPlain(value) {
  return value
}

// ── Category donut ──────────────────────────────────────────────────────────

export function CategoryDonut({ data, valueLabel = 'érték', huf = false, height = 240 }) {
  if (!data?.length) return <EmptyChartHint />
  const total = data.reduce((s, d) => s + d.value, 0)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius="55%"
          outerRadius="85%"
          paddingAngle={2}
          stroke="var(--surface)"
        >
          {data.map((entry, idx) => (
            <Cell key={entry.name} fill={entry.fill || colorForCategory(entry.name, idx)} />
          ))}
        </Pie>
        <Tooltip
          formatter={(value, name) => {
            const pct = total > 0 ? Math.round((value / total) * 100) : 0
            const formatted = huf ? formatHuf(value) : value
            return [`${formatted} (${pct}%)`, name]
          }}
          contentStyle={{ borderRadius: 6, fontSize: 12 }}
        />
        <Legend
          verticalAlign="bottom"
          height={36}
          wrapperStyle={{ fontSize: 12 }}
          formatter={(value) => value}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}

// ── Horizontal bar: top products by qty or revenue ──────────────────────────

export function TopProductsBar({ data, valueKey = 'qty', huf = false, height = 320 }) {
  if (!data?.length) return <EmptyChartHint />
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 16, left: 12, bottom: 4 }}
        barCategoryGap={6}
      >
        <CartesianGrid stroke={GRID_COLOR} horizontal={false} />
        <XAxis
          type="number"
          tick={AXIS_TICK}
          tickFormatter={huf ? (v) => formatHuf(v) : undefined}
        />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ ...AXIS_TICK, fontSize: 12 }}
          width={140}
          interval={0}
        />
        <Tooltip
          formatter={huf ? tooltipFormatterHuf : tooltipFormatterPlain}
          contentStyle={{ borderRadius: 6, fontSize: 12 }}
        />
        <Bar dataKey={valueKey} radius={[0, 4, 4, 0]}>
          {data.map((entry, idx) => (
            <Cell key={entry.name + idx} fill={colorForCategory(entry.category, idx)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Vertical bar: items per category (or any name → value) ──────────────────

export function CategoryBar({ data, valueLabel = 'érték', huf = false, height = 240 }) {
  if (!data?.length) return <EmptyChartHint />
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 12, left: 12, bottom: 4 }} barCategoryGap={10}>
        <CartesianGrid stroke={GRID_COLOR} vertical={false} />
        <XAxis
          dataKey="name"
          tick={{ ...AXIS_TICK, fontSize: 11 }}
          interval={0}
          angle={-25}
          textAnchor="end"
          height={56}
        />
        <YAxis
          tick={AXIS_TICK}
          tickFormatter={huf ? (v) => formatHuf(v) : undefined}
          width={huf ? 64 : 36}
        />
        <Tooltip
          formatter={huf ? tooltipFormatterHuf : tooltipFormatterPlain}
          contentStyle={{ borderRadius: 6, fontSize: 12 }}
        />
        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
          {data.map((entry, idx) => (
            <Cell key={entry.name} fill={entry.fill || colorForCategory(entry.name, idx)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Daily revenue + orders combo (click to select day) ──────────────────────

export function DailyRevenueChart({ data, onSelectDay, selectedDay, height = 280 }) {
  if (!data?.length) return <EmptyChartHint />

  // Recharts onClick handler — fires with the bar's datum.
  const handleBarClick = (datum) => {
    if (!onSelectDay || !datum?.date) return
    onSelectDay(datum.date)
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, left: 12, bottom: 4 }}>
        <CartesianGrid stroke={GRID_COLOR} vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ ...AXIS_TICK, fontSize: 10 }}
          tickFormatter={(d) => d.slice(5)} /* show MM-DD */
          interval={0}
        />
        <YAxis
          yAxisId="left"
          tick={AXIS_TICK}
          tickFormatter={(v) => formatHuf(v)}
          width={72}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={AXIS_TICK}
          width={32}
        />
        <Tooltip
          contentStyle={{ borderRadius: 6, fontSize: 12 }}
          labelFormatter={(d) => formatDayLabel(d)}
          formatter={(value, name) => {
            if (name === 'Bevétel') return [formatHuf(value), name]
            return [value, name]
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar
          yAxisId="left"
          dataKey="revenue"
          name="Bevétel"
          radius={[4, 4, 0, 0]}
          onClick={handleBarClick}
          cursor={onSelectDay ? 'pointer' : 'default'}
        >
          {data.map((d) => (
            <Cell
              key={d.date}
              fill={d.date === selectedDay ? 'var(--primary)' : '#94a3b8'}
            />
          ))}
        </Bar>
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="orders"
          name="Rendelések"
          stroke="#dc2626"
          strokeWidth={2}
          dot={{ r: 3 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// ── Cumulative revenue area ─────────────────────────────────────────────────

export function CumulativeRevenueChart({ data, height = 200 }) {
  if (!data?.length) return <EmptyChartHint />
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 16, left: 12, bottom: 4 }}>
        <defs>
          <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.45} />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID_COLOR} vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ ...AXIS_TICK, fontSize: 10 }}
          tickFormatter={(d) => d.slice(5)}
          interval={0}
        />
        <YAxis tick={AXIS_TICK} tickFormatter={(v) => formatHuf(v)} width={72} />
        <Tooltip
          contentStyle={{ borderRadius: 6, fontSize: 12 }}
          labelFormatter={(d) => formatDayLabel(d)}
          formatter={(value) => [formatHuf(value), 'Halmozott']}
        />
        <Area
          type="monotone"
          dataKey="cumulative"
          stroke="var(--primary)"
          strokeWidth={2}
          fill="url(#cumGrad)"
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

// ── Hour-of-day bar (0..23) ──────────────────────────────────────────────────

export function HourBarChart({ data, huf = false, height = 220 }) {
  // data: [{ hour: 0..23, value: number }]
  const hasAny = data.some((d) => d.value > 0)
  if (!hasAny) return <EmptyChartHint />

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 12, left: 12, bottom: 4 }} barCategoryGap={2}>
        <CartesianGrid stroke={GRID_COLOR} vertical={false} />
        <XAxis
          dataKey="hour"
          tick={AXIS_TICK}
          tickFormatter={(h) => `${String(h).padStart(2, '0')}h`}
          interval={1}
        />
        <YAxis
          tick={AXIS_TICK}
          tickFormatter={huf ? (v) => formatHuf(v) : undefined}
          width={huf ? 64 : 36}
        />
        <Tooltip
          contentStyle={{ borderRadius: 6, fontSize: 12 }}
          labelFormatter={(h) => `${String(h).padStart(2, '0')}:00`}
          formatter={huf ? tooltipFormatterHuf : tooltipFormatterPlain}
        />
        <Bar dataKey="value" fill="var(--primary)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Day × hour heatmap (CSS grid — recharts has no native heatmap) ─────────

export function DayHourHeatmap({ matrix, days, max, onSelectCell }) {
  // matrix: number[days][24] (revenue or order count)
  // days: ISO date strings, matching matrix rows
  // max: numeric scale top
  if (!days?.length) return <EmptyChartHint />

  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          borderCollapse: 'separate',
          borderSpacing: 2,
          fontSize: '0.72rem',
          color: 'var(--muted)',
        }}
      >
        <thead>
          <tr>
            <th style={{ padding: '0 6px 4px 0', textAlign: 'left' }}></th>
            {Array.from({ length: 24 }, (_, h) => (
              <th key={h} style={{ width: 22, textAlign: 'center', fontWeight: 500 }}>
                {String(h).padStart(2, '0')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((day, rowIdx) => {
            const row = matrix[rowIdx] || []
            return (
              <tr key={day}>
                <th
                  scope="row"
                  style={{ padding: '0 8px 0 0', textAlign: 'right', fontWeight: 500, whiteSpace: 'nowrap' }}
                >
                  {day.slice(5)}
                </th>
                {Array.from({ length: 24 }, (_, hour) => {
                  const value = row[hour] || 0
                  const intensity = max > 0 ? Math.min(1, value / max) : 0
                  const bg = value > 0
                    ? `rgba(220, 38, 38, ${0.10 + intensity * 0.78})`
                    : 'rgba(120,120,120,0.05)'
                  return (
                    <td
                      key={hour}
                      onClick={() => onSelectCell?.(day, hour, value)}
                      title={`${formatDayLabel(day)} · ${String(hour).padStart(2, '0')}:00 — ${value}`}
                      style={{
                        width: 22,
                        height: 22,
                        background: bg,
                        borderRadius: 3,
                        cursor: onSelectCell ? 'pointer' : 'default',
                        textAlign: 'center',
                        color: intensity > 0.55 ? '#fff' : 'inherit',
                      }}
                    >
                      {value > 0 ? value : ''}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Sold vs returned dual area (DRS / Repohár) ──────────────────────────────

export function SoldReturnedAreaChart({
  data,
  soldLabel = 'Eladva',
  returnedLabel = 'Visszahozva',
  outstandingLabel = 'Forgalomban',
  height = 240,
}) {
  if (!data?.length) return <EmptyChartHint />
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, left: 12, bottom: 4 }}>
        <defs>
          <linearGradient id="soldGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.45} />
            <stop offset="100%" stopColor="#0ea5e9" stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="retGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity={0.45} />
            <stop offset="100%" stopColor="#22c55e" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID_COLOR} vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ ...AXIS_TICK, fontSize: 10 }}
          tickFormatter={(d) => d.slice(5)}
          interval={0}
        />
        <YAxis tick={AXIS_TICK} width={36} />
        <Tooltip
          contentStyle={{ borderRadius: 6, fontSize: 12 }}
          labelFormatter={(d) => formatDayLabel(d)}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area
          type="monotone"
          dataKey="sold"
          name={soldLabel}
          stroke="#0ea5e9"
          strokeWidth={2}
          fill="url(#soldGrad)"
        />
        <Area
          type="monotone"
          dataKey="returned"
          name={returnedLabel}
          stroke="#22c55e"
          strokeWidth={2}
          fill="url(#retGrad)"
        />
        <Line
          type="monotone"
          dataKey="outstanding"
          name={outstandingLabel}
          stroke="var(--primary)"
          strokeWidth={2}
          strokeDasharray="4 3"
          dot={{ r: 2 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// ── Staff revenue bar (horizontal, single colour) ───────────────────────────

export function StaffRevenueBar({ data, height = 280 }) {
  if (!data?.length) return <EmptyChartHint />
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 16, left: 12, bottom: 4 }}
        barCategoryGap={6}
      >
        <CartesianGrid stroke={GRID_COLOR} horizontal={false} />
        <XAxis type="number" tick={AXIS_TICK} tickFormatter={(v) => formatHuf(v)} />
        <YAxis type="category" dataKey="name" tick={{ ...AXIS_TICK, fontSize: 12 }} width={140} interval={0} />
        <Tooltip
          formatter={tooltipFormatterHuf}
          contentStyle={{ borderRadius: 6, fontSize: 12 }}
        />
        <Bar dataKey="revenue" fill="var(--primary)" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Refund timeline (line / bar combo of refunds per day) ───────────────────

export function RefundTimelineChart({ data, height = 220 }) {
  const hasAny = data.some((d) => d.refund > 0)
  if (!hasAny) return <EmptyChartHint />

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 16, left: 12, bottom: 4 }} barCategoryGap={4}>
        <CartesianGrid stroke={GRID_COLOR} vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ ...AXIS_TICK, fontSize: 10 }}
          tickFormatter={(d) => d.slice(5)}
          interval={0}
        />
        <YAxis tick={AXIS_TICK} tickFormatter={(v) => formatHuf(v)} width={72} />
        <Tooltip
          formatter={(v) => [formatHuf(v), 'Refund']}
          contentStyle={{ borderRadius: 6, fontSize: 12 }}
          labelFormatter={(d) => formatDayLabel(d)}
        />
        <Bar dataKey="refund" fill="var(--danger)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Empty-state hint ────────────────────────────────────────────────────────

export function EmptyChartHint() {
  return (
    <p className="helper-text" style={{ padding: '24px 0', textAlign: 'center' }}>
      Nincs megjeleníthető adat.
    </p>
  )
}
