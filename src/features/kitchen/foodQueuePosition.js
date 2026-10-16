// A station ticket is one order in that station's queue, even if it contains
// multiple food items. Preparing tickets take priority over new tickets.
const STATUS_RANK = { preparing: 0, new: 1 }

function orderTime(ticket) {
  return ticket.order?.createdAt?.toMillis?.() ?? 0
}

export function compareKitchenTickets(a, b) {
  const timeDifference = orderTime(a) - orderTime(b)
  if (timeDifference) return timeDifference
  const idDifference = String(a.order?.id || '').localeCompare(String(b.order?.id || ''))
  if (idDifference) return idDifference
  return a.index - b.index
}

export function countStationTicketsAhead(ownTicket, allTickets) {
  if (!ownTicket || !(ownTicket.status in STATUS_RANK)) return null

  return allTickets.filter((ticket) => {
    if (ticket.station !== ownTicket.station || ticket.id === ownTicket.id) return false
    if (!(ticket.status in STATUS_RANK)) return false

    const rankDifference = STATUS_RANK[ticket.status] - STATUS_RANK[ownTicket.status]
    return rankDifference < 0 || (rankDifference === 0 && compareKitchenTickets(ticket, ownTicket) < 0)
  }).length
}
