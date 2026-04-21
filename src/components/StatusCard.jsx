export function StatusCard({ title, body, tone = 'warning', children }) {
  return (
    <section className="status-card" data-tone={tone}>
      <h2 className="card-title">{title}</h2>
      {body ? <p className="helper-text">{body}</p> : null}
      {children}
    </section>
  )
}
