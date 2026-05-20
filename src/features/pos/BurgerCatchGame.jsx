import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// ── Ingredient classification (mirrors StaffPosPanel) ─────────────────────
const SPRITE_KEYWORDS_BURGER = [
  { kind: 'patty',   keywords: ['hus', 'hús', 'pogi', 'pogacsa', 'pogácsa', 'patty', 'meat'] },
  { kind: 'cheese',  keywords: ['sajt', 'cheese', 'cheddar'] },
  { kind: 'lettuce', keywords: ['salata', 'saláta', 'lettuce'] },
  { kind: 'tomato',  keywords: ['paradicsom', 'tomato'] },
  { kind: 'onion',   keywords: ['hagyma', 'onion'] },
  { kind: 'bacon',   keywords: ['bacon', 'szalonna'] },
  { kind: 'ketchup', keywords: ['szosz', 'szósz', 'sauce', 'ketchup'] },
  { kind: 'mustard', keywords: ['mustar', 'mustár', 'mustard'] },
  { kind: 'mayo',    keywords: ['majonez', 'majonéz', 'mayo', 'majonaise'] },
]

const SPRITE_KEYWORDS_PIZZA = [
  { kind: 'pizzasauce', keywords: ['paradicsomszosz', 'paradicsomszósz', 'pizza szosz', 'alap szosz', 'szosz', 'szósz', 'sauce'] },
  { kind: 'mozzarella', keywords: ['mozzarella', 'sajt', 'cheese'] },
  { kind: 'pepperoni',  keywords: ['pepperoni', 'szalami', 'szalámi'] },
  { kind: 'ham',        keywords: ['sonka', 'ham'] },
  { kind: 'mushroom',   keywords: ['gomba', 'mushroom'] },
  { kind: 'corn',       keywords: ['kukorica', 'corn'] },
]

const SPRITE_KEYWORDS_GYROS = [
  { kind: 'gyrosmeat', keywords: ['hus', 'hús', 'pogi', 'pogacsa', 'pogácsa', 'patty', 'meat'] },
  { kind: 'yogurt',    keywords: ['joghurt', 'joghurtos'] },
  { kind: 'spicy',     keywords: ['csipos', 'csípős', 'csipős', 'spicy', 'eros', 'erős'] },
  { kind: 'cucumber',  keywords: ['uborka', 'uborkás', 'cucumber'] },
  { kind: 'onion',     keywords: ['hagyma', 'onion'] },
  { kind: 'lettuce',   keywords: ['salata', 'saláta', 'lettuce'] },
  { kind: 'tomato',    keywords: ['paradicsom', 'tomato'] },
  { kind: 'ketchup',   keywords: ['szosz', 'szósz', 'sauce', 'ketchup'] },
]

function normalizeLabel(label) {
  return String(label || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}
function getSpriteKind(label, variant = 'burger') {
  const table = variant === 'gyros' ? SPRITE_KEYWORDS_GYROS
    : variant === 'pizza' ? SPRITE_KEYWORDS_PIZZA
    : SPRITE_KEYWORDS_BURGER
  const n = normalizeLabel(label)
  return table.find((e) => e.keywords.some((k) => n.includes(normalizeLabel(k))))?.kind || 'default'
}

// ── Game constants ────────────────────────────────────────────────────────
const PHASE        = { COUNTDOWN: 'countdown', PLAYING: 'playing', COMPLETE: 'complete' }
const PADDLE_HALF  = 10    // % of field width — half the paddle (matches 20% CSS width)
const SPAWN_MS     = 1600  // ms between ingredient spawns
const TOP_BUN_MS   = 12000 // ms between top-bun spawns
const SPEED_BASE   = 9     // % per second
const SPEED_JITTER = 5     // max extra % per second

// ── Component ─────────────────────────────────────────────────────────────
export function BurgerCatchGame({ product, template, variant = 'burger', onComplete, onCancel }) {
  const isGyros = variant === 'gyros'
  const isPizza = variant === 'pizza'
  // Default included ingredients
  const ingredients = useMemo(
    () => template?.defaultIncludedIngredients || [],
    [template],
  )

  // Optional extras — can also fall and be caught
  const optionalExtras = useMemo(
    () => template?.optionalExtras || [],
    [template],
  )

  const [phase, setPhase]               = useState(PHASE.COUNTDOWN)
  const [countdown, setCountdown]       = useState(3)
  // Ordered list of every catch — drives the tower (duplicates allowed, catch order preserved)
  const [caughtStack, setCaughtStack]   = useState([])
  const [complete, setComplete]         = useState(false)
  const [topBunCaught, setTopBunCaught] = useState(false)

  // Refs — mutated in the RAF loop without triggering re-renders
  const gameFieldRef   = useRef(null)
  const paddleRef      = useRef(null)
  const itemsLayerRef  = useRef(null)
  const paddleXRef     = useRef(50)    // %, 0–100
  const fallingRef     = useRef([])
  const rafRef         = useRef(null)
  const caughtStackRef = useRef([])           // mutable mirror of caughtStack for use inside RAF
  const caughtSetRef   = useRef(new Set())    // unique ingredientIds — for onComplete included/removed
  // extrasAggRef: Map<id, { id, label, price, quantity }> — aggregated extras to pass to onComplete
  const extrasAggRef   = useRef(new Map())
  const spawnQueueRef  = useRef([])           // shuffled spawn queue for fair distribution
  const phaseRef       = useRef(PHASE.COUNTDOWN)
  const counterRef     = useRef(0)
  const stackCountRef  = useRef(0)            // uid counter for stack entries
  const lastFrameRef   = useRef(null)
  const lastSpawnRef   = useRef(0)
  const lastTopBunRef  = useRef(0)

  phaseRef.current = phase

  // ── Countdown ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== PHASE.COUNTDOWN) return undefined
    if (countdown <= 0) { setPhase(PHASE.PLAYING); return undefined }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, countdown])

  // ── Pointer / touch tracking ───────────────────────────────────────────
  useEffect(() => {
    const field = gameFieldRef.current
    if (!field) return undefined

    function move(clientX) {
      const rect = field.getBoundingClientRect()
      const pct  = ((clientX - rect.left) / rect.width) * 100
      paddleXRef.current = Math.max(PADDLE_HALF, Math.min(100 - PADDLE_HALF, pct))
      if (paddleRef.current) paddleRef.current.style.left = `${paddleXRef.current}%`
    }

    const onMouse = (e) => move(e.clientX)
    const onTouch = (e) => { if (e.touches[0]) move(e.touches[0].clientX) }

    field.addEventListener('mousemove', onMouse)
    field.addEventListener('touchmove', onTouch, { passive: true })
    return () => {
      field.removeEventListener('mousemove', onMouse)
      field.removeEventListener('touchmove', onTouch)
    }
  }, [])

  // ── "Kész" — submit whatever is caught right now ───────────────────────
  const handleDone = useCallback(() => {
    if (phaseRef.current !== PHASE.PLAYING) return
    cancelAnimationFrame(rafRef.current)
    fallingRef.current.forEach((item) => item.el?.remove())
    fallingRef.current = []
    phaseRef.current = PHASE.COMPLETE
    setPhase(PHASE.COMPLETE)
    setComplete(true)
  }, [])

  // ── Game loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== PHASE.PLAYING) return undefined

    const layer = itemsLayerRef.current
    if (!layer) return undefined

    const hasIngredients = ingredients.length > 0

    // Build a lookup of optionalExtras by id for quick price resolution
    const optionalExtrasById = new Map(optionalExtras.map((e) => [e.id, e]))

    // ── DOM element builders ───────────────────────────────────────────

    // Ingredient with a known sprite: show sprite, no label
    // 'default' kind (no sprite): show name pill instead
    function makeIngredientEl(item) {
      const wrapper = document.createElement('div')
      wrapper.className = 'catch-item'

      if (item.spriteKind === 'default') {
        // No sprite — show name inside a pill
        const lbl = document.createElement('span')
        lbl.className = 'catch-item-label catch-item-label--inside'
        lbl.textContent = item.label
        wrapper.appendChild(lbl)
      } else {
        // Known sprite — render burger-layer, no label text
        const burgerLayer = document.createElement('div')
        burgerLayer.className = `burger-layer burger-layer--${item.spriteKind}`
        burgerLayer.style.cssText = 'display:block;height:auto;width:100%;'

        const sprite = document.createElement('span')
        sprite.className = 'burger-layer-sprite'
        sprite.style.cssText = 'display:block;width:100%;'
        burgerLayer.appendChild(sprite)

        wrapper.appendChild(burgerLayer)
      }

      // Mark extras (optional extras falling as bonus items)
      if (item.isExtra) {
        wrapper.classList.add('catch-item--extra')
      }

      wrapper.style.cssText = `left:${item.x}%;top:${item.y}%;`
      layer.appendChild(wrapper)
      return wrapper
    }

    // Top cap: bun for burgers, tortilla for gyros
    function makeTopCapEl(item) {
      const wrapper = document.createElement('div')
      wrapper.className = `catch-item ${isGyros ? 'catch-item--top-tortilla' : 'catch-item--top-bun'}`

      if (isGyros) {
        const tortilla = document.createElement('div')
        tortilla.className = 'gyros-wrap gyros-wrap--top game-top-tortilla-cap'
        tortilla.style.cssText = 'width:100%;'
        wrapper.appendChild(tortilla)
      } else {
        const bun = document.createElement('div')
        bun.className = 'burger-bun burger-bun--top'
        bun.style.cssText = 'width:100%;display:flex;justify-content:center;'
        bun.appendChild(document.createElement('span'))
        wrapper.appendChild(bun)
      }

      const lbl = document.createElement('span')
      lbl.className = 'catch-item-label'
      lbl.textContent = isGyros ? '⬆ Csavard be!' : '⬆ Felső buci!'
      wrapper.appendChild(lbl)

      wrapper.style.cssText = `left:${item.x}%;top:${item.y}%;`
      layer.appendChild(wrapper)
      return wrapper
    }

    // ── Spawn queue ────────────────────────────────────────────────────
    // Pool = defaultIncludedIngredients + optionalExtras (tagged isExtra)
    function buildSpawnPool() {
      const pool = [
        ...ingredients.map((ing) => ({ ...ing, isExtra: false })),
        ...optionalExtras.map((ext) => ({ ...ext, isExtra: true })),
      ]
      // Fisher-Yates shuffle
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]]
      }
      return pool
    }

    function nextSpawnItem() {
      if (spawnQueueRef.current.length === 0) {
        spawnQueueRef.current = buildSpawnPool()
      }
      return spawnQueueRef.current.pop()
    }

    function spawnIngredient() {
      if (!hasIngredients && optionalExtras.length === 0) return
      const ing  = nextSpawnItem()
      const item = {
        id: ++counterRef.current,
        type: 'ingredient',
        ingredientId: ing.id,
        isExtra: ing.isExtra,
        // price: used when caught — extras use their own price, included use 0
        price: ing.isExtra ? (ing.price ?? 0) : 0,
        spriteKind: getSpriteKind(ing.label, variant),
        label: ing.label,
        x: 8 + Math.random() * 84,
        y: -12,
        speed: SPEED_BASE + Math.random() * SPEED_JITTER,
        el: null,
      }
      item.el = makeIngredientEl(item)
      fallingRef.current.push(item)
    }

    function spawnTopBun() {
      const item = {
        id: ++counterRef.current,
        type: 'topBun',
        x: 10 + Math.random() * 80,
        y: -14,
        speed: SPEED_BASE * 0.72, // a bit slower so it's catchable
        el: null,
      }
      item.el = makeTopCapEl(item)
      fallingRef.current.push(item)
    }

    function flashCatch(x) {
      const el = document.createElement('div')
      el.className = 'catch-flash'
      el.style.cssText = `left:${x}%;top:83%;`
      layer.appendChild(el)
      setTimeout(() => el.remove(), 500)
    }

    function tick(now) {
      if (phaseRef.current !== PHASE.PLAYING) return

      const elapsed = lastFrameRef.current !== null ? (now - lastFrameRef.current) / 1000 : 1 / 60
      lastFrameRef.current = now

      if (!lastSpawnRef.current)  lastSpawnRef.current  = now
      if (!lastTopBunRef.current) lastTopBunRef.current = now

      if (now - lastSpawnRef.current >= SPAWN_MS) {
        spawnIngredient()
        lastSpawnRef.current = now
      }
      if (!isPizza && now - lastTopBunRef.current >= TOP_BUN_MS) {
        spawnTopBun()
        lastTopBunRef.current = now
      }

      // ── Dynamic catch zone: the whole tower + bottom bun ──────────────
      // Convert paddle bounding rect to % of game field
      let catchTopPct = 76  // fallback
      let catchBtmPct = 94  // fallback
      const fieldEl  = gameFieldRef.current
      const paddleEl = paddleRef.current
      if (fieldEl && paddleEl) {
        const fr = fieldEl.getBoundingClientRect()
        const pr = paddleEl.getBoundingClientRect()
        if (fr.height > 0) {
          catchTopPct = ((pr.top    - fr.top) / fr.height) * 100
          catchBtmPct = ((pr.bottom - fr.top) / fr.height) * 100
        }
      }

      const px   = paddleXRef.current
      const next = []

      for (const item of fallingRef.current) {
        item.y += item.speed * elapsed
        if (item.el) item.el.style.top = `${item.y}%`

        // A bit of tolerance at top and bottom edges
        const inY = item.y + 4 >= catchTopPct && item.y <= catchBtmPct + 2
        const inX = Math.abs(item.x - px) <= PADDLE_HALF + 2

        if (inY && inX) {
          item.el?.remove()

          if (item.type === 'topBun') {
            // Top bun caught — seal the burger and finish
            next.forEach((n) => n.el?.remove())
            fallingRef.current = []
            phaseRef.current = PHASE.COMPLETE
            setTopBunCaught(true)
            setPhase(PHASE.COMPLETE)
            setComplete(true)
            return
          }

          // ── Ingredient or extra caught ─────────────────────────────
          const entry = {
            uid: ++stackCountRef.current,
            ingredientId: item.ingredientId,
            isExtra: item.isExtra,
            spriteKind: item.spriteKind,
            label: item.label,
          }
          caughtStackRef.current = [...caughtStackRef.current, entry]

          if (item.isExtra) {
            // Optional extra: aggregate into extrasAggRef
            const prev = extrasAggRef.current.get(item.ingredientId)
            if (prev) {
              extrasAggRef.current.set(item.ingredientId, { ...prev, quantity: prev.quantity + 1 })
            } else {
              extrasAggRef.current.set(item.ingredientId, {
                id: item.ingredientId,
                label: item.label,
                price: item.price ?? 0,
                quantity: 1,
              })
            }
          } else {
            // Default ingredient: first catch marks it as included
            caughtSetRef.current.add(item.ingredientId)

            // If caught more than once, treat repeats as extras with price 0
            // (unless it's also listed in optionalExtras with a known price)
            const alreadyCounted = caughtStackRef.current.filter(
              (e) => e.ingredientId === item.ingredientId && !e.isExtra,
            ).length
            if (alreadyCounted > 1) {
              const knownExt = optionalExtrasById.get(item.ingredientId)
              const extraPrice = knownExt?.price ?? 0
              const prev = extrasAggRef.current.get(item.ingredientId)
              if (prev) {
                extrasAggRef.current.set(item.ingredientId, { ...prev, quantity: prev.quantity + 1 })
              } else {
                extrasAggRef.current.set(item.ingredientId, {
                  id: item.ingredientId,
                  label: item.label,
                  price: extraPrice,
                  quantity: 1,
                })
              }
            }
          }

          setCaughtStack(caughtStackRef.current)
          flashCatch(item.x)
          continue
        }

        if (item.y > 108) { item.el?.remove(); continue }

        next.push(item)
      }

      fallingRef.current = next
      rafRef.current = requestAnimationFrame(tick)
    }

    // Kick off: spawn one ingredient immediately
    // First top bun appears after 4 s instead of full 12 s
    spawnIngredient()
    lastSpawnRef.current  = performance.now()
    lastTopBunRef.current = performance.now() - (TOP_BUN_MS - 4000)
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafRef.current)
      fallingRef.current.forEach((item) => item.el?.remove())
      fallingRef.current = []
      if (layer) layer.innerHTML = ''
    }
  }, [phase, ingredients, optionalExtras, isGyros, isPizza])

  // ── Complete → fire onComplete after a brief celebration ──────────────
  useEffect(() => {
    if (!complete) return undefined
    const t = setTimeout(() => {
      const caught = caughtSetRef.current
      const extras = Array.from(extrasAggRef.current.values())
      onComplete({
        includedIngredients: ingredients.filter((i) => caught.has(i.id)),
        removedIngredients:  ingredients.filter((i) => !caught.has(i.id)),
        extras,
      })
    }, 1400)
    return () => clearTimeout(t)
  }, [complete, ingredients, onComplete])

  // Unique ingredient IDs in the stack — used only for progress dots
  const uniqueCaughtIds = useMemo(
    () => new Set(caughtStack.map((e) => e.ingredientId)),
    [caughtStack],
  )

  const caughtCount = uniqueCaughtIds.size
  const totalCount  = ingredients.length

  return (
    <div className="game-overlay" role="dialog" aria-modal="true" aria-label={isPizza ? 'Pizza összerakós játék' : isGyros ? 'Gyros összerakós játék' : 'Burger összerakós játék'}>
      {/* Header */}
      <div className="game-header">
        <button type="button" className="game-cancel-btn" onClick={onCancel}>
          ← Bezárás
        </button>

        <div className="game-progress">
          {ingredients.map((ing) => {
            const kind = getSpriteKind(ing.label, variant)
            return (
              <span
                key={ing.id}
                className={`game-pdot game-pdot--${kind}${uniqueCaughtIds.has(ing.id) ? ' caught' : ''}`}
                title={ing.label}
              />
            )
          })}
        </div>

        <span className="game-score">{caughtCount} / {totalCount}</span>

        <button
          type="button"
          className="game-done-btn"
          disabled={phase !== PHASE.PLAYING}
          onClick={handleDone}
        >
          Kész ✓
        </button>
      </div>

      {/* Game field */}
      <div ref={gameFieldRef} className="game-field">
        {/* Falling items layer — managed imperatively by RAF loop */}
        <div ref={itemsLayerRef} className="game-items-layer" />

        {/* Countdown overlay */}
        {phase === PHASE.COUNTDOWN ? (
          <div className="game-countdown">
            <span key={countdown} className="game-countdown-num">
              {countdown === 0 ? 'GO!' : countdown}
            </span>
            <p className="game-countdown-hint">
              {product.name} — csípd el az összetevőket, majd {isPizza ? 'nyomd meg a Kész gombot amikor a pizza tele van!' : isGyros ? 'a tortilla csavarja be a gyrost!' : 'a felső buci zárja le a burgert!'}
            </p>
          </div>
        ) : null}

        {/* Celebration overlay */}
        {complete ? (
          <div className="game-celebrate">
            <span className="game-celebrate-icon">🎉</span>
            <span className="game-celebrate-text">{isPizza ? 'Pizza kész!' : isGyros ? 'Gyros kész!' : 'Burger kész!'}</span>
          </div>
        ) : null}

        {/* Paddle */}
        <div ref={paddleRef} className="game-paddle" style={{ left: '50%' }}>
          {isPizza ? (
            /* Pizza disc — circular pad that fills up with toppings */
            <div className="game-pizza-disc">
              <div className="game-pizza-disc-sauce" />
              {caughtStack.map((entry, i) => (
                <div
                  key={entry.uid}
                  className={`game-pizza-topping game-pizza-topping--${entry.spriteKind}`}
                  style={{ '--ti': i }}
                />
              ))}
            </div>
          ) : (
            <>
              {/* Tower grows upward: top bun (if caught) → ingredients → bottom bun */}
              <div className={isGyros ? 'game-gyros-tower' : 'game-burger-tower'}>
                {topBunCaught ? (
                  isGyros ? (
                    <div className="gyros-wrap gyros-wrap--top game-tower-top-tortilla" aria-hidden="true" />
                  ) : (
                    <div className="burger-bun burger-bun--top game-tower-top-bun" aria-hidden="true">
                      <span />
                    </div>
                  )
                ) : null}
                {caughtStack.map((entry) => (
                  <div
                    key={entry.uid}
                    className={`burger-layer burger-layer--${entry.spriteKind} game-caught-layer`}
                    style={{ display: 'block', height: 'auto', width: '100%' }}
                  >
                    <span className="burger-layer-sprite" style={{ display: 'block', width: '100%' }} />
                  </div>
                ))}
              </div>
              <div className={isGyros ? 'game-tortilla-bottom' : 'game-bun-bottom'} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
