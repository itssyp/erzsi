import assert from 'node:assert/strict'
import { countStationTicketsAhead } from '../src/features/kitchen/foodQueuePosition.js'

const at = (ms) => ({ toMillis: () => ms })
const ticket = (id, station, status, time, index = 0) => ({
  id: `${id}::${station}`,
  station,
  status,
  index,
  order: { id, createdAt: at(time) },
})

const ownBurger = ticket('own', 'burger', 'new', 30)
const ownPizza = ticket('own', 'pizza', 'preparing', 30, 1)
const queue = [
  ownBurger,
  ownPizza,
  ticket('older-burger', 'burger', 'new', 10),
  ticket('working-burger', 'burger', 'preparing', 40),
  ticket('ready-burger', 'burger', 'ready', 5),
  ticket('older-pizza', 'pizza', 'new', 10),
  ticket('working-pizza', 'pizza', 'preparing', 20),
  ticket('older-gyros', 'gyros', 'new', 1),
]

assert.equal(countStationTicketsAhead(ownBurger, queue), 2, 'burger counts only active burger tickets, with preparing first')
assert.equal(countStationTicketsAhead(ownPizza, queue), 1, 'pizza ignores new tickets when own ticket is preparing')
assert.equal(countStationTicketsAhead(ticket('own', 'pizza', 'ready', 30), queue), null, 'ready has no queue position')
assert.equal(countStationTicketsAhead(ticket('own', 'burger', 'delivered', 30), queue), null, 'delivered has no queue position')
assert.equal(countStationTicketsAhead(ticket('b', 'gyros', 'new', 50), [ticket('a', 'gyros', 'new', 50)]), 1, 'equal timestamps use order ID as tie-breaker')
assert.equal(countStationTicketsAhead(ticket('a', 'gyros', 'new', 50), [ticket('b', 'gyros', 'new', 50)]), 0)

console.log('Food queue position tests passed')
