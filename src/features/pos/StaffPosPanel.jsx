import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { formatHuf } from '../../lib/money'
import { getStaffSessionId } from '../../lib/session'
import { useAuth } from '../auth/useAuth'
import { subscribeToModifierTemplates } from '../modifiers/modifierTemplateService'
import { PERSON_RECORD_STATUSES, subscribeToPeople } from '../people/personService'
import { QR_CODE_LENGTH, normalizeQrInput } from '../qr/qrLinks'
import { useQrScanner } from '../qr/useQrScanner'
import { usePosSession } from './usePosSession'
import { PRODUCT_CATEGORIES, subscribeToProducts, updateProductTemporaryAvailability } from '../products/productService'
import { isFoodCategory, normalizeProductCategory } from '../products/productModels'
import { tryNormalizeProductBarcode } from '../products/productBarcodes'
import { getPersonDisplayId } from '../people/personModels'
import {
  acquireBasketLock,
  cancelBasket,
  finalizeBasket,
  findPersonByQr,
  refreshBasketLock,
  saveBasketItems,
} from './posService'
import {
  DRS_RETURN_PRODUCT_ID,
  REUSABLE_CUP_RETURN_AMOUNT,
  REUSABLE_CUP_RETURN_PRODUCT_ID,
  buildBasketLine,
  buildBasketLineMergeKey,
  buildDrsLine,
  buildDrsReturnLine,
  buildReusableCupReturnLine,
  countReusableCupsInBasket,
  countReusableCupsOutstanding,
  summarizeBasketItems,
} from './basketModels'
import { subscribeOrdersForPerson } from '../orders/orderService'
import { DRS_DEPOSIT_AMOUNT } from '../drs/drsModels'
import { useKitchenWorkload } from '../kitchen/useKitchenWorkload'
import {
  BURGER_TRIGGER_PATTERN,
  GYROS_TRIGGER_PATTERN,
  PIZZA_TRIGGER_PATTERN,
} from '../kitchen/kitchenStations'
import { useActiveEvent } from '../events/useActiveEvent'
import { BurgerCatchGame } from './BurgerCatchGame'

const MISC_CATEGORY = 'Egyéb'
const PRODUCT_AVAILABILITY_LONG_PRESS_MS = 650
const DRS_RETURN_PRODUCT = Object.freeze({
  id: DRS_RETURN_PRODUCT_ID,
  name: 'Palack visszaváltás',
  category: MISC_CATEGORY,
  price: -DRS_DEPOSIT_AMOUNT,
  isActive: true,
  isDrsReturn: true,
  isCreditReturn: true,
})
const REUSABLE_CUP_RETURN_PRODUCT = Object.freeze({
  id: REUSABLE_CUP_RETURN_PRODUCT_ID,
  name: 'Repohár visszaváltás',
  category: MISC_CATEGORY,
  price: -REUSABLE_CUP_RETURN_AMOUNT,
  isActive: true,
  isReusableCupReturn: true,
  isCreditReturn: true,
})
// PRODUCT_CATEGORIES already includes MISC_CATEGORY ('Egyéb'); dedupe defensively
// so this list remains correct even if either constant is reordered later.
const allCategories = ['all', ...PRODUCT_CATEGORIES.filter((c) => c !== MISC_CATEGORY), MISC_CATEGORY]
const BASKET_ABANDON_CANCEL_MS = 60 * 1000
const BASKET_HEARTBEAT_MS = 15 * 1000
const BASKET_SYNC_DEBOUNCE_MS = 220
const KEYBOARD_SCANNER_MAX_GAP_MS = 350
const KEYBOARD_SCANNER_FLUSH_MS = 500
const EMPTY_BASKET_SUMMARY = Object.freeze({
  items: [],
  itemCount: 0,
  totalAmount: 0,
})
const SPRITZER_GUIDE = Object.freeze([
  { name: 'Kisfröccs', ratio: '1:1', wineDl: 1, sodaDl: 1 },
  { name: 'Nagyfröccs', ratio: '2:1', wineDl: 2, sodaDl: 1 },
  { name: 'Hosszúlépés', ratio: '1:2', wineDl: 1, sodaDl: 2 },
  { name: 'Házmester', ratio: '3:2', wineDl: 3, sodaDl: 2 },
  { name: 'Sportfröccs', ratio: '1:4', wineDl: 1, sodaDl: 4 },
  { name: 'Viceházmester', ratio: '2:3', wineDl: 2, sodaDl: 3 },
])
const LONG_DRINK_RULES = Object.freeze([
  '4 cl alkohol',
  '2,5 dl mixer',
  'Jég opcionális',
  'Pohárba töltve, nem shakerben',
])
const LONG_DRINK_GUIDE = Object.freeze([
  { name: 'Gin-fizz', spirit: '4 cl gin', mixer: '2,5 dl fizz / szóda', tone: 'gin' },
  { name: 'Gin-tonic', spirit: '4 cl gin', mixer: '2,5 dl tonic', tone: 'gin' },
  { name: 'Pink gin-fizz', spirit: '4 cl pink gin', mixer: '2,5 dl fizz / szóda', tone: 'pink' },
  { name: 'Pink gin-tonic', spirit: '4 cl pink gin', mixer: '2,5 dl tonic', tone: 'pink' },
  { name: 'Jager-hell', spirit: '4 cl Jager', mixer: '2,5 dl Hell', tone: 'energy' },
  { name: 'Jager-üdcsi', spirit: '4 cl Jager', mixer: '2,5 dl üdcsi', tone: 'soft' },
  { name: 'Malibu-üdcsi', spirit: '4 cl Malibu', mixer: '2,5 dl üdcsi', tone: 'tropical' },
  { name: 'Rum-kóla', spirit: '4 cl rum', mixer: '2,5 dl kóla', tone: 'cola' },
  { name: 'Vodka-hell', spirit: '4 cl vodka', mixer: '2,5 dl Hell', tone: 'energy' },
  { name: 'Vodka-szóda', spirit: '4 cl vodka', mixer: '2,5 dl szóda', tone: 'clear' },
  { name: 'Vodka-üdcsi', spirit: '4 cl vodka', mixer: '2,5 dl üdcsi', tone: 'soft' },
  { name: 'Whiskey-hell', spirit: '4 cl whiskey', mixer: '2,5 dl Hell', tone: 'energy' },
  { name: 'Whiskey-üdcsi', spirit: '4 cl whiskey', mixer: '2,5 dl üdcsi', tone: 'soft' },
  { name: 'Pina colada', spirit: '4 cl Malibu / alap', mixer: '2,5 dl ananász / üdcsi', tone: 'tropical' },
  { name: 'Partylong', spirit: '4 cl alap', mixer: '2,5 dl mixer', tone: 'house' },
  { name: 'Vadászpilk', spirit: '4 cl alap', mixer: '2,5 dl mixer', tone: 'house' },
])
// BURGER_TRIGGER_PATTERN / GYROS_TRIGGER_PATTERN now imported from kitchenStations
// (single source of truth — also drives kitchen-side ticket splitting).
const BURGER_SPRITE_KEYWORDS = Object.freeze([
  { kind: 'patty', keywords: ['hus', 'hús', 'pogi', 'pogacsa', 'pogácsa', 'patty', 'meat'] },
  { kind: 'cheese', keywords: ['sajt', 'cheese', 'cheddar'] },
  { kind: 'lettuce', keywords: ['salata', 'saláta', 'lettuce'] },
  { kind: 'tomato', keywords: ['paradicsom', 'tomato'] },
  { kind: 'onion', keywords: ['hagyma', 'onion'] },
  { kind: 'bacon', keywords: ['bacon', 'szalonna'] },
  { kind: 'ketchup', keywords: ['szosz', 'szósz', 'sauce', 'ketchup'] },
  { kind: 'mustard', keywords: ['mustar', 'mustár', 'mustard'] },
  { kind: 'mayo',    keywords: ['majonez', 'majonéz', 'mayo', 'majonaise'] },
])
const BURGER_LAYER_ORDER = Object.freeze({
  ketchup: 5,
  mustard: 5,
  mayo: 5,
  tomato: 10,
  lettuce: 20,
  onion: 25,
  bacon: 28,
  'cheese:extra': 30,
  'patty:extra': 40,
  cheese: 50,
  patty: 60,
})

const GYROS_SPRITE_KEYWORDS = Object.freeze([
  { kind: 'gyrosmeat', keywords: ['hus', 'hús', 'pogi', 'pogacsa', 'pogácsa', 'patty', 'meat'] },
  { kind: 'yogurt',    keywords: ['joghurt', 'joghurtos'] },
  { kind: 'spicy',     keywords: ['csipos', 'csípős', 'csipős', 'spicy', 'eros', 'erős'] },
  { kind: 'cucumber',  keywords: ['uborka', 'uborkás', 'cucumber'] },
  { kind: 'onion',     keywords: ['hagyma', 'onion'] },
  { kind: 'lettuce',   keywords: ['salata', 'saláta', 'lettuce'] },
  { kind: 'tomato',    keywords: ['paradicsom', 'tomato'] },
])

const GYROS_LAYER_ORDER = Object.freeze({
  spicy: 3,
  yogurt: 5,
  tomato: 10,
  cucumber: 12,
  lettuce: 15,
  onion: 20,
  'gyrosmeat:extra': 25,
  gyrosmeat: 30,
})

// PIZZA_TRIGGER_PATTERN now imported from kitchenStations (see above).
const PIZZA_SPRITE_KEYWORDS = Object.freeze([
  { kind: 'pizzasauce', keywords: ['paradicsomszosz', 'paradicsomszósz', 'pizza szosz', 'alap szosz', 'szosz', 'szósz', 'sauce'] },
  { kind: 'mozzarella', keywords: ['mozzarella', 'sajt', 'cheese'] },
  { kind: 'pepperoni',  keywords: ['pepperoni', 'szalami', 'szalámi'] },
  { kind: 'ham',        keywords: ['sonka', 'ham'] },
  { kind: 'mushroom',   keywords: ['gomba', 'mushroom'] },
  { kind: 'corn',       keywords: ['kukorica', 'corn'] },
])
// Lower = rendered first = appears underneath; mozzarella last = renders on top of all toppings
const PIZZA_LAYER_ORDER = Object.freeze({
  pizzasauce: 1,
  mozzarella: 2,
  pepperoni:  3,
  ham:        4,
  mushroom:   5,
  corn:       6,
  generic:    8,
})
const PIZZA_GENERIC_TOPPING_POSITIONS = Object.freeze([
  { left: '38%', top: '27%' },
  { left: '58%', top: '30%' },
  { left: '30%', top: '47%' },
  { left: '67%', top: '51%' },
  { left: '48%', top: '63%' },
  { left: '42%', top: '42%' },
  { left: '58%', top: '66%' },
  { left: '68%', top: '38%' },
  { left: '29%', top: '62%' },
])
const PIZZA_GENERIC_TOPPING_COLORS = Object.freeze([
  '#b91c1c',
  '#eab308',
  '#15803d',
  '#c2410c',
  '#7c2d12',
  '#be185d',
  '#4d7c0f',
])

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="camera-icon">
      <path
        d="M8 6h2l1-2h2l1 2h2a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h2zm4 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0-2.2a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6z"
        fill="currentColor"
      />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path
        d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 7h2v8h-2v-8zm4 0h2v8h-2v-8zM7 10h2v8H7v-8zm1 10h8a2 2 0 0 0 2-2V8H6v10a2 2 0 0 0 2 2z"
        fill="currentColor"
      />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path
        d="M9.2 16.6 4.9 12.3l1.4-1.4 2.9 2.9 8.5-8.5 1.4 1.4-9.9 9.9z"
        fill="currentColor"
      />
    </svg>
  )
}

function HelpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="action-icon">
      <path
        d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 17.2a1.15 1.15 0 1 1 0-2.3 1.15 1.15 0 0 1 0 2.3zm1.1-5.35v1.05h-2.2v-1.35c0-1.1.66-1.78 1.58-2.34.78-.48 1.22-.84 1.22-1.55 0-.84-.67-1.38-1.64-1.38-.95 0-1.68.5-2.18 1.48L8 8.7c.77-1.62 2.2-2.52 4.18-2.52 2.33 0 3.9 1.28 3.9 3.34 0 1.53-.84 2.33-1.95 3.02-.72.44-1.03.74-1.03 1.31z"
        fill="currentColor"
      />
    </svg>
  )
}

function SpritzerGlass({ wineDl, sodaDl }) {
  const totalDl = wineDl + sodaDl
  const winePercent = `${(wineDl / totalDl) * 100}%`
  const sodaPercent = `${(sodaDl / totalDl) * 100}%`

  return (
    <div className="spritzer-glass" aria-hidden="true">
      <div className="spritzer-fill spritzer-soda" style={{ height: sodaPercent, bottom: winePercent }} />
      <div className="spritzer-fill spritzer-wine" style={{ height: winePercent }} />
    </div>
  )
}

function LongDrinkGlass({ tone }) {
  return (
    <div className={`longdrink-glass longdrink-glass--${tone || 'soft'}`} aria-hidden="true">
      <div className="longdrink-cup-rim" />
      <div className="longdrink-cup-band" />
      <div className="longdrink-fill longdrink-fill-spirit" />
      <div className="longdrink-fill longdrink-fill-mixer" />
      {[4, 3, 2, 1].map((dl) => (
        <div key={dl} className={`longdrink-measure longdrink-measure-${dl}`}>
          <span />
          <strong>{dl} dl</strong>
        </div>
      ))}
    </div>
  )
}

function normalizeIngredientLabel(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function isBurgerVisualTemplate(product, template) {
  return BURGER_TRIGGER_PATTERN.test(`${product?.name || ''} ${template?.name || ''}`)
}

function isGyrosVisualTemplate(product, template) {
  return GYROS_TRIGGER_PATTERN.test(`${product?.name || ''} ${template?.name || ''}`)
}

function isPizzaVisualTemplate(product, template) {
  return PIZZA_TRIGGER_PATTERN.test(`${product?.name || ''} ${template?.name || ''}`)
}

function getBurgerSpriteKind(label) {
  const normalizedLabel = normalizeIngredientLabel(label)
  const match = BURGER_SPRITE_KEYWORDS.find((entry) =>
    entry.keywords.some((keyword) => normalizedLabel.includes(normalizeIngredientLabel(keyword))),
  )

  return match?.kind || null
}

function getBurgerLayerOrder(layer) {
  const sourceKey = layer.source === 'extra' ? `${layer.spriteKind}:extra` : layer.spriteKind
  return BURGER_LAYER_ORDER[sourceKey] ?? BURGER_LAYER_ORDER[layer.spriteKind] ?? 90
}

function getGyrosSpriteKind(label) {
  const normalizedLabel = normalizeIngredientLabel(label)
  const match = GYROS_SPRITE_KEYWORDS.find((entry) =>
    entry.keywords.some((keyword) => normalizedLabel.includes(normalizeIngredientLabel(keyword))),
  )
  return match?.kind || null
}

function getGyrosLayerOrder(layer) {
  const sourceKey = layer.source === 'extra' ? `${layer.spriteKind}:extra` : layer.spriteKind
  return GYROS_LAYER_ORDER[sourceKey] ?? GYROS_LAYER_ORDER[layer.spriteKind] ?? 90
}

function getPizzaSpriteKind(label) {
  const normalizedLabel = normalizeIngredientLabel(label)
  const match = PIZZA_SPRITE_KEYWORDS.find((entry) =>
    entry.keywords.some((keyword) => normalizedLabel.includes(normalizeIngredientLabel(keyword))),
  )
  return match?.kind || null
}

function getPizzaGenericToppingStyle(label, index) {
  const normalizedLabel = normalizeIngredientLabel(label)
  const hash = Array.from(normalizedLabel).reduce(
    (sum, character) => sum + character.charCodeAt(0),
    index,
  )
  const position = PIZZA_GENERIC_TOPPING_POSITIONS[index % PIZZA_GENERIC_TOPPING_POSITIONS.length]
  const background = PIZZA_GENERIC_TOPPING_COLORS[hash % PIZZA_GENERIC_TOPPING_COLORS.length]

  return { ...position, background }
}

function getPizzaLayerOrder(layer) {
  const baseOrder = PIZZA_LAYER_ORDER[layer.spriteKind] ?? 99
  return layer.source === 'extra' ? baseOrder + 0.5 : baseOrder
}

function getPizzaLayerState(template, customizationState) {
  const visualToppings = []
  const knownToppings = []
  const unknownIngredients = []

  ;(template.defaultIncludedIngredients || []).forEach((ingredient, index) => {
    const spriteKind = getPizzaSpriteKind(ingredient.label)
    const entry = {
      ...ingredient,
      spriteKind: spriteKind || 'generic',
      source: 'default',
      included: customizationState?.includedIngredientIds.has(ingredient.id) || false,
    }
    if (spriteKind) {
      knownToppings.push(entry)
      visualToppings.push(entry)
    } else {
      const fallbackEntry = {
        ...entry,
        genericStyle: getPizzaGenericToppingStyle(ingredient.label, index),
      }
      unknownIngredients.push(fallbackEntry)
      visualToppings.push(fallbackEntry)
    }
  })

  ;(customizationState?.extras || []).forEach((extra, extraIndex) => {
    if (extra.quantity <= 0) return

    const spriteKind = getPizzaSpriteKind(extra.label)
    for (let index = 0; index < extra.quantity; index += 1) {
      const visualIndex = (template.defaultIncludedIngredients || []).length + extraIndex + index
      visualToppings.push({
        ...extra,
        id: `${extra.id}-${index}`,
        originalId: extra.id,
        quantity: 1,
        spriteKind: spriteKind || 'generic',
        genericStyle: spriteKind ? undefined : getPizzaGenericToppingStyle(extra.label, visualIndex),
        source: 'extra',
        included: true,
      })
    }
  })

  visualToppings.sort((a, b) => getPizzaLayerOrder(a) - getPizzaLayerOrder(b))

  return { visualToppings, knownToppings, unknownIngredients }
}

function getGyrosLayerState(template, customizationState) {
  const knownIngredients = []
  const unknownIngredients = []
  const visualExtras = []

  ;(template.defaultIncludedIngredients || []).forEach((ingredient) => {
    const spriteKind = getGyrosSpriteKind(ingredient.label)
    const entry = {
      ...ingredient,
      spriteKind,
      source: 'default',
      included: customizationState?.includedIngredientIds.has(ingredient.id) || false,
    }
    if (spriteKind) knownIngredients.push(entry)
    else unknownIngredients.push(entry)
  })

  ;(customizationState?.extras || []).forEach((extra) => {
    if (extra.quantity <= 0) return
    const spriteKind = getGyrosSpriteKind(extra.label)
    if (!spriteKind) return
    for (let index = 0; index < extra.quantity; index += 1) {
      visualExtras.push({
        ...extra,
        id: `${extra.id}-${index}`,
        originalId: extra.id,
        quantity: 1,
        spriteKind,
        source: 'extra',
        included: true,
      })
    }
  })

  return { knownIngredients, unknownIngredients, visualExtras }
}

function getBurgerLayerState(template, customizationState) {
  const knownIngredients = []
  const unknownIngredients = []
  const visualExtras = []

  ;(template.defaultIncludedIngredients || []).forEach((ingredient) => {
    const spriteKind = getBurgerSpriteKind(ingredient.label)
    const entry = {
      ...ingredient,
      spriteKind,
      source: 'default',
      included: customizationState?.includedIngredientIds.has(ingredient.id) || false,
    }

    if (spriteKind) knownIngredients.push(entry)
    else unknownIngredients.push(entry)
  })

  ;(customizationState?.extras || []).forEach((extra) => {
    if (extra.quantity <= 0) return
    const spriteKind = getBurgerSpriteKind(extra.label)
    if (!spriteKind) return
    for (let index = 0; index < extra.quantity; index += 1) {
      visualExtras.push({
        ...extra,
        id: `${extra.id}-${index}`,
        originalId: extra.id,
        quantity: 1,
        spriteKind,
        source: 'extra',
        included: true,
      })
    }
  })

  return { knownIngredients, unknownIngredients, visualExtras }
}

function BurgerLayer({ layer, onToggle }) {
  const interactive = typeof onToggle === 'function'
  const className = [
    'burger-layer',
    `burger-layer--${layer.spriteKind}`,
    layer.included ? '' : 'is-removed',
    interactive ? 'is-interactive' : '',
  ].filter(Boolean).join(' ')

  return (
    <button
      type="button"
      className={className}
      onClick={interactive ? onToggle : undefined}
      disabled={!interactive}
      aria-pressed={interactive ? layer.included : undefined}
      title={layer.label}
    >
      <span className="burger-layer-sprite" />
    </button>
  )
}

function IngredientToggleChip({ ingredient, onToggle }) {
  return (
    <button
      type="button"
      className={`ingredient-toggle-chip${ingredient.included ? ' is-included' : ' is-removed'}`}
      onClick={onToggle}
      aria-pressed={ingredient.included}
    >
      {ingredient.included ? ingredient.label : `Nincs ${ingredient.label}`}
    </button>
  )
}

function CustomizationExtras({ extras, onAdjustQuantity, onUpdateQuantity }) {
  if (!extras?.length) return null

  return (
    <div className="stack-block customization-extra-list" style={{ gap: '8px' }}>
      <h5 className="card-title" style={{ marginBottom: '4px' }}>Extrák</h5>
      {extras.map((extra) => (
        <div
          key={extra.id}
          className="customization-extra-row"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
        >
          <div style={{ flex: 1, minWidth: 0, paddingRight: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>{extra.label}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>+{formatHuf(extra.price)} each</div>
          </div>
          <div className="customization-extra-stepper" aria-label={`${extra.label} mennyiseg`}>
            <button
              type="button"
              className="customization-extra-stepper-btn"
              onClick={() => onAdjustQuantity(extra.id, -1)}
              disabled={extra.quantity <= 0}
              aria-label={`${extra.label} csokkentese`}
            >
              -
            </button>
            <input
              type="number"
              min="0"
              max={extra.maxQuantity}
              value={extra.quantity}
              className="customization-extra-input"
              onChange={(event) => onUpdateQuantity(extra.id, event.target.value)}
              aria-label={`${extra.label} mennyisege`}
            />
            <button
              type="button"
              className="customization-extra-stepper-btn"
              onClick={() => onAdjustQuantity(extra.id, 1)}
              disabled={extra.quantity >= extra.maxQuantity}
              aria-label={`${extra.label} novelese`}
            >
              +
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function BurgerCustomizer({ template, customizationState, onToggleIngredient, onRemoveExtraLayer, extrasContent }) {
  const { knownIngredients, unknownIngredients, visualExtras } = getBurgerLayerState(template, customizationState)
  const visibleLayers = [...knownIngredients, ...visualExtras]
    .sort((left, right) => getBurgerLayerOrder(left) - getBurgerLayerOrder(right))

  return (
    <div className="burger-customizer">
      <div className="burger-stage" aria-label="Burger összetevők">
        <div className="burger-bun burger-bun--top" aria-hidden="true">
          <span />
        </div>

        <div className="burger-stack">
          {visibleLayers.length ? (
            visibleLayers.map((layer) => (
              <BurgerLayer
                key={`${layer.id}-${layer.quantity || 0}`}
                layer={layer}
                onToggle={
                  layer.source === 'extra'
                    ? () => onRemoveExtraLayer(layer.originalId)
                    : () => onToggleIngredient(layer.id)
                }
              />
            ))
          ) : (
            <div className="burger-empty-layer">Nincs vizuális összetevő</div>
          )}
        </div>

        <div className="burger-bun burger-bun--bottom" aria-hidden="true">
          <span />
        </div>
      </div>

      <div className="burger-chip-panel">
        <span className="burger-chip-panel-title">Összetevők</span>
        <div className="burger-chip-row">
          {[...knownIngredients, ...unknownIngredients].map((ingredient) => (
            <IngredientToggleChip
              key={ingredient.id}
              ingredient={ingredient}
              onToggle={() => onToggleIngredient(ingredient.id)}
            />
          ))}
        </div>
        {extrasContent}
      </div>
    </div>
  )
}

function GyrosCustomizer({ template, customizationState, onToggleIngredient, onRemoveExtraLayer, extrasContent }) {
  const { knownIngredients, unknownIngredients, visualExtras } = getGyrosLayerState(template, customizationState)
  const visibleLayers = [...knownIngredients, ...visualExtras]
    .sort((left, right) => getGyrosLayerOrder(left) - getGyrosLayerOrder(right))

  return (
    <div className="burger-customizer">
      <div className="gyros-stage" aria-label="Gyros összetevők">

        <div className="burger-stack">
          {visibleLayers.length ? (
            visibleLayers.map((layer) => (
              <BurgerLayer
                key={`${layer.id}-${layer.quantity || 0}`}
                layer={layer}
                onToggle={
                  layer.source === 'extra'
                    ? () => onRemoveExtraLayer(layer.originalId)
                    : () => onToggleIngredient(layer.id)
                }
              />
            ))
          ) : (
            <div className="burger-empty-layer">Nincs vizuális összetevő</div>
          )}
        </div>

        <div className="gyros-wrap gyros-wrap--bottom" aria-hidden="true" />
      </div>

      <div className="burger-chip-panel">
        <span className="burger-chip-panel-title">Összetevők</span>
        <div className="burger-chip-row">
          {[...knownIngredients, ...unknownIngredients].map((ingredient) => (
            <IngredientToggleChip
              key={ingredient.id}
              ingredient={ingredient}
              onToggle={() => onToggleIngredient(ingredient.id)}
            />
          ))}
        </div>
        {extrasContent}
      </div>
    </div>
  )
}

function PizzaCustomizer({ template, customizationState, onToggleIngredient, onRemoveExtraLayer, extrasContent }) {
  const { visualToppings, knownToppings, unknownIngredients } = getPizzaLayerState(template, customizationState)

  return (
    <div className="pizza-customizer">
      <div className="pizza-stage" aria-label="Pizza összetevők">
        <div className="pizza-visual">
          {visualToppings.map((topping) => (
            <div
              key={topping.id}
              className={`pizza-topping pizza-topping--${topping.spriteKind}${topping.included ? '' : ' is-removed'}`}
              role="button"
              tabIndex={0}
              aria-label={`${topping.label} ${topping.source === 'extra' ? 'extra eltávolítása' : 'ki- vagy bekapcsolása'}`}
              onClick={() => {
                if (topping.source === 'extra') onRemoveExtraLayer(topping.originalId)
                else onToggleIngredient(topping.id)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                if (topping.source === 'extra') onRemoveExtraLayer(topping.originalId)
                else onToggleIngredient(topping.id)
              }}
              style={topping.genericStyle || undefined}
            />
          ))}
        </div>
      </div>

      <div className="pizza-chip-panel burger-chip-panel">
        <span className="burger-chip-panel-title">Feltétek</span>
        <div className="burger-chip-row">
          {[...knownToppings, ...unknownIngredients].map((ingredient) => (
            <IngredientToggleChip
              key={ingredient.id}
              ingredient={ingredient}
              onToggle={() => onToggleIngredient(ingredient.id)}
            />
          ))}
        </div>
        {extrasContent}
      </div>
    </div>
  )
}

function createCustomizationState(template) {
  return {
    includedIngredientIds: new Set((template.defaultIncludedIngredients || []).map((item) => item.id)),
    extras: (template.optionalExtras || []).map((item) => ({
      id: item.id,
      label: item.label,
      price: item.price,
      maxQuantity: item.maxQuantity,
      quantity: 0,
    })),
  }
}

function buildCustomizationPayload(template, customizationState) {
  const includedIngredients = (template.defaultIncludedIngredients || []).filter((item) =>
    customizationState.includedIngredientIds.has(item.id),
  )
  const removedIngredients = (template.defaultIncludedIngredients || []).filter(
    (item) => !customizationState.includedIngredientIds.has(item.id),
  )
  const extras = customizationState.extras
    .filter((item) => item.quantity > 0)
    .map((item) => ({
      id: item.id,
      label: item.label,
      price: item.price,
      quantity: item.quantity,
    }))

  return { includedIngredients, removedIngredients, extras }
}

function buildPersonSearchText(person) {
  return [
    person.displayName,
    person.internalId,
    person.team,
    person.shibboleth,
    person.assignedQrId,
    person.qrCodeId,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

const ProductTile = memo(({ product, onClick, onLongPress, disabled, clickDisabled }) => {
  const longPressTimerRef = useRef(null)
  const longPressTriggeredRef = useRef(false)
  const supportsAvailabilityToggle = !product.isCreditReturn && !product.isDrsReturn && !product.isReusableCupReturn

  function clearLongPressTimer() {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  function handlePointerDown(event) {
    if (disabled || !supportsAvailabilityToggle) return
    longPressTriggeredRef.current = false
    clearLongPressTimer()
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true
      onLongPress(product, { x: event.clientX, y: event.clientY })
    }, PRODUCT_AVAILABILITY_LONG_PRESS_MS)
  }

  function handlePointerEnd() {
    clearLongPressTimer()
  }

  function handleClick(event) {
    if (longPressTriggeredRef.current) {
      event.preventDefault()
      longPressTriggeredRef.current = false
      return
    }
    if (clickDisabled || product.isTemporarilyUnavailable) {
      event.preventDefault()
      return
    }
    onClick(product)
  }

  return (
    <button
      type="button"
      className={`product-tile${product.isTemporarilyUnavailable ? ' unavailable' : ''}${product.isCreditReturn ? ' credit' : ''}`}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerLeave={handlePointerEnd}
      disabled={disabled}
      aria-disabled={clickDisabled || product.isTemporarilyUnavailable}
    >
      <strong style={{ fontSize: '0.9rem', fontWeight: 700 }}>{product.name}</strong>
      <span style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
        {product.category}
      </span>
      {product.isTemporarilyUnavailable ? (
        <span className="product-tile-status">TNA</span>
      ) : null}
      <span style={{ fontWeight: 800, color: 'var(--primary)', fontSize: '0.95rem', marginTop: 'auto' }}>
        {formatHuf(product.price)}
      </span>
    </button>
  )
})

export function StaffPosPanel({ eventId }) {
  const { user, account } = useAuth()
  const { registerActiveBasket, clearActiveBasket } = usePosSession()
  const { activeEvent } = useActiveEvent()
  const { workloadError, ...workload } = useKitchenWorkload(eventId)
  const [people, setPeople] = useState([])
  const [products, setProducts] = useState([])
  const [modifierTemplates, setModifierTemplates] = useState([])
  const [selectedPerson, setSelectedPerson] = useState(null)
  const [selectedPersonOrders, setSelectedPersonOrders] = useState([])
  const [switchTargetPerson, setSwitchTargetPerson] = useState(null)
  const [basketItems, setBasketItems] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [customizingProduct, setCustomizingProduct] = useState(null)
  const [customizationState, setCustomizationState] = useState(null)
  const [funModeActive, setFunModeActive] = useState(false)
  const [burgerGameProduct, setBurgerGameProduct] = useState(null)
  const [gyrosGameProduct, setGyrosGameProduct] = useState(null)
  const [pizzaGameProduct, setPizzaGameProduct] = useState(null)
  const funLongPressRef = useRef(null)
  const [spritzerGuideOpen, setSpritzerGuideOpen] = useState(false)
  const [longDrinkGuideOpen, setLongDrinkGuideOpen] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [availabilityProduct, setAvailabilityProduct] = useState(null)
  const [availabilityAnchor, setAvailabilityAnchor] = useState(null)
  const [availabilityPending, setAvailabilityPending] = useState(false)
  const availabilityModalRef = useRef(null)
  const [selectionPending, setSelectionPending] = useState(false)
  const [finalizePending, setFinalizePending] = useState(false)
  const [cancelPending, setCancelPending] = useState(false)
  const [basketSyncing, setBasketSyncing] = useState(false)
  const performSwitchToPersonRef = useRef(async () => {})
  const cancelBasketHandlerRef = useRef(async () => {})
  const finalizeBasketHandlerRef = useRef(async () => {})
  const abandonmentCancelRef = useRef(async () => {})
  const abandonmentTimeoutRef = useRef(null)
  const shouldCancelAfterReturnRef = useRef(false)
  const basketSyncTimerRef = useRef(null)
  const basketDirtyRef = useRef(false)
  const latestBasketItemsRef = useRef([])
  const committedBasketItemsRef = useRef([])
  const activeBasketSaveRef = useRef(null)
  const typedQrAutoSelectRef = useRef('')
  const keyboardScannerBufferRef = useRef('')
  const keyboardScannerLastKeyAtRef = useRef(0)
  const keyboardScannerFlushTimerRef = useRef(null)
  const hiddenScannerFlushTimerRef = useRef(null)
  const hiddenScannerInputRef = useRef(null)
  const selectedPersonRef = useRef(null)
  const startCustomizationRef = useRef(() => {})
  const flushBasketDraftRef = useRef(async () => {})
  const activeBasketSnapshotRef = useRef({
    personDisplayName: '',
    itemCount: 0,
    canFinalize: false,
    isSyncing: false,
  })

  useEffect(() => {
    if (!availabilityProduct || availabilityPending) return () => {}

    function handlePointerDown(event) {
      if (availabilityModalRef.current?.contains(event.target)) return
      closeAvailabilityPopover()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [availabilityPending, availabilityProduct])

  const deferredSearchQuery = useDeferredValue(searchQuery)
  const sessionId = useMemo(() => getStaffSessionId(), [])
  const peopleSearchIndex = useMemo(() => (
    people.map((person) => ({
      person,
      searchText: buildPersonSearchText(person),
    }))
  ), [people])
  const peopleByQrCode = useMemo(() => {
    const index = new Map()

    people.forEach((person) => {
      if (person.assignedQrId) {
        index.set(person.assignedQrId, person)
      }

      if (person.qrCodeId) {
        index.set(person.qrCodeId, person)
      }
    })

    return index
  }, [people])
  const staffName = account?.displayName || user?.displayName || user?.email || 'Staff eszköz'

  useEffect(() => {
    return subscribeToPeople(eventId, (nextPeople) => {
      setPeople(nextPeople.filter((person) => person.recordStatus !== PERSON_RECORD_STATUSES.deleted))
    }, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    return subscribeToProducts(eventId, setProducts, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    return subscribeToModifierTemplates(eventId, setModifierTemplates, (error) => setErrorMessage(error.message))
  }, [eventId])

  // Live feed of the currently selected person's finalized orders. Used to cap
  // Repohár returns at "max cups they still owe back" — preventing accidental
  // refund-fraud where staff click the visszaváltás tile more than the person
  // has cups in hand.
  useEffect(() => {
    if (!selectedPerson?.id) {
      setSelectedPersonOrders([])
      return undefined
    }
    return subscribeOrdersForPerson(
      eventId,
      selectedPerson.id,
      setSelectedPersonOrders,
      () => {}, /* swallow — POS keeps working without history */
    )
  }, [eventId, selectedPerson?.id])

  useEffect(() => {
    if (!spritzerGuideOpen && !longDrinkGuideOpen) return undefined

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setSpritzerGuideOpen(false)
        setLongDrinkGuideOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [longDrinkGuideOpen, spritzerGuideOpen])

  const displayedPerson = switchTargetPerson || selectedPerson
  const isSwitchingPerson = Boolean(switchTargetPerson)

  const filteredPeople = useMemo(() => {
    const normalizedQuery = deferredSearchQuery.trim().toLowerCase()
    if (!normalizedQuery) return []
    return peopleSearchIndex.filter(({ person, searchText }) => {
      if (displayedPerson?.id === person.id) return false
      return searchText.includes(normalizedQuery)
    }).map(({ person }) => person).slice(0, 20)
  }, [deferredSearchQuery, displayedPerson, peopleSearchIndex])

  const availableProducts = useMemo(() => {
    const visibleProducts = products
      .filter((product) => {
        if (!product.isActive) return false
        const normalizedCategory = normalizeProductCategory(product.category)
        return selectedCategory === 'all' ? true : normalizedCategory === selectedCategory
      })
      .map((product) => {
        const normalizedCategory = normalizeProductCategory(product.category)
        const isFood = isFoodCategory(normalizedCategory)
        const catalogTemporarilyUnavailable = Boolean(product.isTemporarilyUnavailable)
        if (isFood && activeEvent?.isKitchenClosed) {
          return {
            ...product,
            category: normalizedCategory,
            catalogTemporarilyUnavailable,
            isTemporarilyUnavailable: true,
          }
        }
        return { ...product, category: normalizedCategory, catalogTemporarilyUnavailable }
      })
      .sort((left, right) => {
        const leftCategoryIndex = PRODUCT_CATEGORIES.indexOf(left.category)
        const rightCategoryIndex = PRODUCT_CATEGORIES.indexOf(right.category)
        const categoryComparison = (leftCategoryIndex === -1 ? PRODUCT_CATEGORIES.length : leftCategoryIndex)
          - (rightCategoryIndex === -1 ? PRODUCT_CATEGORIES.length : rightCategoryIndex)

        if (categoryComparison !== 0) {
          return categoryComparison
        }

        return left.name.localeCompare(right.name, 'hu')
      })
    if (selectedCategory === 'all' || selectedCategory === MISC_CATEGORY) {
      // Insert the DRS return at the very start of the Egyéb group so it
      // always appears first, with any user-defined Egyéb products after it.
      // If no Egyéb products exist yet, this falls back to appending at the end.
      const firstMiscIdx = visibleProducts.findIndex(
        (p) => normalizeProductCategory(p.category) === MISC_CATEGORY,
      )
      if (firstMiscIdx >= 0) {
        return [
          ...visibleProducts.slice(0, firstMiscIdx),
          DRS_RETURN_PRODUCT,
          REUSABLE_CUP_RETURN_PRODUCT,
          ...visibleProducts.slice(firstMiscIdx),
        ]
      }
      return [...visibleProducts, DRS_RETURN_PRODUCT, REUSABLE_CUP_RETURN_PRODUCT]
    }
    return visibleProducts
  }, [products, selectedCategory, activeEvent?.isKitchenClosed])

  const groupedProducts = useMemo(() => {
    const groups = new Map()

    availableProducts.forEach((product) => {
      if (!groups.has(product.category)) {
        groups.set(product.category, [])
      }

      groups.get(product.category).push(product)
    })

    return Array.from(groups, ([category, items]) => ({ category, items }))
  }, [availableProducts])
  const productsByBarcode = useMemo(() => {
    const index = new Map()

    products
      .filter((product) => product.isActive)
      .forEach((product) => {
        const normalizedCategory = normalizeProductCategory(product.category)
        const catalogTemporarilyUnavailable = Boolean(product.isTemporarilyUnavailable)
        const isUnavailable = Boolean(product.isTemporarilyUnavailable)
          || (isFoodCategory(normalizedCategory) && activeEvent?.isKitchenClosed)
        const normalizedProduct = {
          ...product,
          category: normalizedCategory,
          catalogTemporarilyUnavailable,
          isTemporarilyUnavailable: isUnavailable,
        }

        ;(product.barcodes || []).forEach((barcode) => {
          index.set(barcode, normalizedProduct)
        })
      })

    return index
  }, [activeEvent?.isKitchenClosed, products])

  const showProductCategoryHeadings = selectedCategory === 'all'

  const basketSummary = useMemo(() => summarizeBasketItems(basketItems), [basketItems])
  const shouldShowSearchResults = searchQuery.trim().length >= 2
  const displayedBasketSummary = isSwitchingPerson ? EMPTY_BASKET_SUMMARY : basketSummary
  const blockingBasketAction = selectionPending || finalizePending || cancelPending
  const blockingTypedQrAutoSelect = finalizePending || cancelPending
  const productsDisabled = !selectedPerson || blockingBasketAction
  const selectedPersonBalance = Number.isFinite(selectedPerson?.balance) ? selectedPerson.balance : 0
  const negativePurchaseEnabled = Boolean(activeEvent?.allowSingleNegativePurchase)
  const shouldWarnDoNotServe = Boolean(
    selectedPerson
    && (
      (!negativePurchaseEnabled && selectedPersonBalance <= 0)
      || (negativePurchaseEnabled && selectedPersonBalance < 0)
    ),
  )
  const productsPaymentBlocked = shouldWarnDoNotServe

  // Repohár return cap: finalized cups outstanding for this person, MINUS the
  // returns already staged in the open basket. Also adds back any Repohár
  // buys staged in the same basket so a buy + return in one go still works.
  const repoharOutstandingFinalized = useMemo(
    () => countReusableCupsOutstanding(selectedPersonOrders),
    [selectedPersonOrders],
  )
  const repoharLimit = useMemo(() => {
    const inBasketBought = countReusableCupsInBasket(basketItems)
    const inBasketReturned = basketItems
      .filter((item) => item.lineType === 'reusableCupReturn')
      .reduce((sum, item) => sum + (item.quantity || 0), 0)
    // Max additional return units that can still be added.
    return Math.max(0, repoharOutstandingFinalized + inBasketBought - inBasketReturned)
  }, [basketItems, repoharOutstandingFinalized])

  const customizationIsBurgerVisual = Boolean(
    customizingProduct
    && customizationState
    && isBurgerVisualTemplate(customizingProduct.product, customizingProduct.template),
  )
  const customizationIsGyrosVisual = Boolean(
    customizingProduct
    && customizationState
    && isGyrosVisualTemplate(customizingProduct.product, customizingProduct.template),
  )
  const customizationIsPizzaVisual = Boolean(
    customizingProduct
    && customizationState
    && isPizzaVisualTemplate(customizingProduct.product, customizingProduct.template),
  )
  const customizationIsWideVisual = customizationIsBurgerVisual || customizationIsGyrosVisual || customizationIsPizzaVisual

  selectedPersonRef.current = selectedPerson
  activeBasketSnapshotRef.current = {
    personDisplayName: selectedPerson?.displayName || '',
    itemCount: basketSummary.itemCount,
    canFinalize: basketSummary.itemCount > 0,
    isSyncing: basketSyncing,
  }

  const resolvePersonFromQr = useCallback(async (rawValue) => {
    let normalizedQr = ''

    try {
      normalizedQr = normalizeQrInput(rawValue)
    } catch {
      return findPersonByQr(eventId, rawValue)
    }

    const cachedPerson = peopleByQrCode.get(normalizedQr)
    if (cachedPerson) {
      return cachedPerson
    }

    return findPersonByQr(eventId, normalizedQr)
  }, [eventId, peopleByQrCode])

  const focusHiddenScannerInput = useCallback((force = false) => {
    if (cameraOpen || customizingProduct) {
      return
    }

    const activeElement = document.activeElement
    const hiddenInput = hiddenScannerInputRef.current
    const tagName = activeElement?.tagName?.toLowerCase()
    const activeElementIsTextEntry = tagName === 'input' || tagName === 'textarea' || tagName === 'select' || activeElement?.isContentEditable

    if (!hiddenInput || activeElement === hiddenInput || (!force && activeElementIsTextEntry)) {
      return
    }

    hiddenInput.focus({ preventScroll: true })
  }, [cameraOpen, customizingProduct])

  const { videoRef, scannerSupported } = useQrScanner({
    active: cameraOpen,
    onDetected: async (rawValue) => {
      const normalizedQr = rawValue.trim()

      if (!normalizedQr) {
        return
      }

      setCameraOpen(false)
      setSelectionPending(true)
      setErrorMessage('')

      try {
        const person = await resolvePersonFromQr(normalizedQr)
        await performSwitchToPersonRef.current(person)
      } catch (error) {
        setErrorMessage(error.message)
      } finally {
        setSelectionPending(false)
      }
    },
    onError: (error) => {
      setCameraOpen(false)
      setErrorMessage(error.message || 'A kamerás QR-beolvasás nem érhető el ezen az eszközön.')
    },
  })

  const tryAutoSelectQr = useCallback((rawValue) => {
    const trimmedValue = String(rawValue || '').trim()

    if (!trimmedValue || blockingTypedQrAutoSelect) {
      return false
    }

    let normalizedQr = ''

    try {
      normalizedQr = normalizeQrInput(trimmedValue)
    } catch {
      return false
    }

    if (typedQrAutoSelectRef.current === normalizedQr) {
      return true
    }

    typedQrAutoSelectRef.current = normalizedQr
    setSelectionPending(true)
    setErrorMessage('')

    ;(async () => {
      try {
        const person = await resolvePersonFromQr(normalizedQr)
        await performSwitchToPersonRef.current(person)
        setSearchQuery('')
      } catch (error) {
        typedQrAutoSelectRef.current = ''
        setErrorMessage(error.message)
      } finally {
        typedQrAutoSelectRef.current = ''
        setSelectionPending(false)
        window.setTimeout(() => focusHiddenScannerInput(true), 0)
      }
    })()

    return true
  }, [blockingTypedQrAutoSelect, focusHiddenScannerInput, resolvePersonFromQr])

  const handleCompletedScannerInput = useCallback((rawValue) => {
    const trimmedValue = String(rawValue || '').trim()

    if (!trimmedValue) {
      return false
    }

    if (tryAutoSelectQr(trimmedValue)) {
      return true
    }

    const barcode = tryNormalizeProductBarcode(trimmedValue)
    if (!barcode) {
      return false
    }

    const product = productsByBarcode.get(barcode)
    if (!product) {
      setErrorMessage(`Nincs termek ehhez a vonalkodhoz: ${barcode}`)
      return true
    }

    if (!selectedPersonRef.current) {
      setErrorMessage('Elobb valassz vendeget.')
      return true
    }

    if (blockingBasketAction) {
      return true
    }

    if (product.isTemporarilyUnavailable) {
      setErrorMessage(`A(z) ${product.name} most nem elerheto.`)
      return true
    }

    if (productsPaymentBlocked && !product.isCreditReturn && (product.price || 0) > 0) {
      setErrorMessage('Ne szolgald ki: a vendeg egyenlege nem engedi a vasarlast.')
      return true
    }

    setErrorMessage('')
    startCustomizationRef.current(product)
    return true
  }, [blockingBasketAction, productsByBarcode, productsPaymentBlocked, tryAutoSelectQr])

  useEffect(() => {
    tryAutoSelectQr(searchQuery)
  }, [searchQuery, tryAutoSelectQr])

  useEffect(() => {
    function clearKeyboardScannerFlushTimer() {
      if (keyboardScannerFlushTimerRef.current) {
        window.clearTimeout(keyboardScannerFlushTimerRef.current)
        keyboardScannerFlushTimerRef.current = null
      }
    }

    function flushKeyboardScannerBuffer() {
      clearKeyboardScannerFlushTimer()
      const bufferedValue = keyboardScannerBufferRef.current
      keyboardScannerBufferRef.current = ''

      if (bufferedValue.length >= QR_CODE_LENGTH) {
        handleCompletedScannerInput(bufferedValue)
      }
    }

    function isTextEntryElement(element) {
      const tagName = element?.tagName?.toLowerCase()
      return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || element?.isContentEditable
    }

    function handleGlobalKeyDown(event) {
      if (event.ctrlKey || event.altKey || event.metaKey || cameraOpen || customizingProduct) {
        return
      }

      if (isTextEntryElement(document.activeElement)) {
        return
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        if (keyboardScannerBufferRef.current) {
          event.preventDefault()
          flushKeyboardScannerBuffer()
        } else {
          keyboardScannerLastKeyAtRef.current = 0
        }
        return
      }

      if (event.key.length !== 1) {
        return
      }

      const now = Date.now()
      if (now - keyboardScannerLastKeyAtRef.current > KEYBOARD_SCANNER_MAX_GAP_MS) {
        keyboardScannerBufferRef.current = ''
      }

      keyboardScannerLastKeyAtRef.current = now
      keyboardScannerBufferRef.current += event.key

      if (keyboardScannerBufferRef.current.length >= 2) {
        event.preventDefault()
      }

      clearKeyboardScannerFlushTimer()
      keyboardScannerFlushTimerRef.current = window.setTimeout(
        flushKeyboardScannerBuffer,
        KEYBOARD_SCANNER_FLUSH_MS,
      )
    }

    function handleGlobalPaste(event) {
      if (cameraOpen || customizingProduct || isTextEntryElement(document.activeElement)) {
        return
      }

      const pastedValue = event.clipboardData?.getData('text') || ''
      if (pastedValue && handleCompletedScannerInput(pastedValue)) {
        event.preventDefault()
      }
    }

    window.addEventListener('keydown', handleGlobalKeyDown, true)
    window.addEventListener('paste', handleGlobalPaste, true)
    return () => {
      clearKeyboardScannerFlushTimer()
      window.removeEventListener('keydown', handleGlobalKeyDown, true)
      window.removeEventListener('paste', handleGlobalPaste, true)
    }
  }, [cameraOpen, customizingProduct, handleCompletedScannerInput])

  useEffect(() => {
    const focusTimer = window.setTimeout(focusHiddenScannerInput, 0)
    const scheduleScannerFocus = () => window.setTimeout(focusHiddenScannerInput, 0)

    window.addEventListener('pointerup', scheduleScannerFocus)
    window.addEventListener('focus', scheduleScannerFocus)

    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('pointerup', scheduleScannerFocus)
      window.removeEventListener('focus', scheduleScannerFocus)
    }
  }, [focusHiddenScannerInput, selectionPending, selectedPerson])

  useEffect(() => () => {
    if (hiddenScannerFlushTimerRef.current) {
      window.clearTimeout(hiddenScannerFlushTimerRef.current)
      hiddenScannerFlushTimerRef.current = null
    }
  }, [])

  function handleHiddenScannerInputBlur() {
    window.setTimeout(focusHiddenScannerInput, 0)
  }

  function clearHiddenScannerInputFlushTimer() {
    if (hiddenScannerFlushTimerRef.current) {
      window.clearTimeout(hiddenScannerFlushTimerRef.current)
      hiddenScannerFlushTimerRef.current = null
    }
  }

  function flushHiddenScannerInput(input) {
    clearHiddenScannerInputFlushTimer()
    if (!input.value) {
      return
    }

    if (handleCompletedScannerInput(input.value)) {
      input.value = ''
    } else if (input.value.length > 512) {
      input.value = input.value.slice(-512)
    }
  }

  function handleHiddenScannerInputChange(event) {
    const input = event.target
    clearHiddenScannerInputFlushTimer()
    hiddenScannerFlushTimerRef.current = window.setTimeout(() => flushHiddenScannerInput(input), KEYBOARD_SCANNER_FLUSH_MS)
  }

  function handleHiddenScannerInputKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== 'Tab') {
      return
    }

    const input = event.currentTarget
    if (input.value && handleCompletedScannerInput(input.value)) {
      event.preventDefault()
      input.value = ''
    }
  }

  const clearBasketSyncTimer = useCallback(() => {
    if (basketSyncTimerRef.current) {
      window.clearTimeout(basketSyncTimerRef.current)
      basketSyncTimerRef.current = null
    }
  }, [])

  function resetBasketDraft(items = []) {
    clearBasketSyncTimer()
    basketDirtyRef.current = false
    latestBasketItemsRef.current = items
    committedBasketItemsRef.current = items
    setBasketSyncing(false)
  }

  function clearSelectedBasketState() {
    resetBasketDraft([])
    setSelectedPerson(null)
    setBasketItems([])
  }

  function loadSelectedBasket(person, items) {
    const nextItems = items || []
    resetBasketDraft(nextItems)
    setSelectedPerson(person)
    setBasketItems(nextItems)
  }

  function getCurrentBasketSnapshot() {
    return {
      person: selectedPersonRef.current,
      items: latestBasketItemsRef.current,
      committedItems: committedBasketItemsRef.current,
      dirty: basketDirtyRef.current,
      syncing: basketSyncing,
    }
  }

  function restoreBasketSnapshot(snapshot) {
    clearBasketSyncTimer()
    basketDirtyRef.current = snapshot.dirty
    latestBasketItemsRef.current = snapshot.items
    committedBasketItemsRef.current = snapshot.committedItems
    setSelectedPerson(snapshot.person)
    setBasketItems(snapshot.items)
    setBasketSyncing(snapshot.syncing)

    if (snapshot.dirty) {
      scheduleBasketSync()
    }
  }

  async function flushBasketDraft(targetPerson = selectedPersonRef.current) {
    clearBasketSyncTimer()

    const person = targetPerson

    if (!person || !basketDirtyRef.current) {
      return
    }

    if (activeBasketSaveRef.current) {
      await activeBasketSaveRef.current
      return flushBasketDraft(person)
    }

    const itemsToPersist = latestBasketItemsRef.current
    basketDirtyRef.current = false
    setBasketSyncing(true)

    const savePromise = saveBasketItems({
      eventId,
      personId: person.id,
      items: itemsToPersist,
      staffUid: user.uid,
      sessionId,
      staffName,
    })

    activeBasketSaveRef.current = savePromise

    try {
      await savePromise
      committedBasketItemsRef.current = itemsToPersist

      if (selectedPersonRef.current?.id === person.id && latestBasketItemsRef.current !== itemsToPersist) {
        basketDirtyRef.current = true
        scheduleBasketSync()
      }
    } catch (error) {
      if (selectedPersonRef.current?.id === person.id) {
        latestBasketItemsRef.current = committedBasketItemsRef.current
        setBasketItems(committedBasketItemsRef.current)
      }

      basketDirtyRef.current = false
      setErrorMessage(error.message)
      throw error
    } finally {
      if (activeBasketSaveRef.current === savePromise) {
        activeBasketSaveRef.current = null
      }

      if (!basketDirtyRef.current) {
        setBasketSyncing(false)
      }
    }
  }

  flushBasketDraftRef.current = flushBasketDraft

  const scheduleBasketSync = useCallback(() => {
    clearBasketSyncTimer()

    basketSyncTimerRef.current = window.setTimeout(() => {
      flushBasketDraftRef.current().catch(() => {})
    }, BASKET_SYNC_DEBOUNCE_MS)
  }, [clearBasketSyncTimer])

  const applyOptimisticBasketItems = useCallback((nextItems) => {
    basketDirtyRef.current = true
    latestBasketItemsRef.current = nextItems
    setBasketItems(nextItems)
    setBasketSyncing(true)
    scheduleBasketSync()
  }, [scheduleBasketSync])

  async function performSwitchToPerson(nextPerson) {
    const previousPerson = selectedPersonRef.current
    const currentItemCount = latestBasketItemsRef.current.reduce((sum, item) => sum + item.quantity, 0)
    const previousSnapshot = getCurrentBasketSnapshot()
    let previousResolved = false

    setSwitchTargetPerson(nextPerson)
    setSearchQuery('')
    setErrorMessage('')

    try {
      if (previousPerson) {
        if (currentItemCount > 0) {
          await flushBasketDraft()
          await finalizeBasket({ eventId, personId: previousPerson.id, staffUid: user.uid, sessionId, staffName })
        } else {
          clearBasketSyncTimer()
          if (activeBasketSaveRef.current) {
            await activeBasketSaveRef.current.catch(() => {})
          }
          await cancelBasket({ eventId, personId: previousPerson.id, staffUid: user.uid, sessionId })
        }

        clearSelectedBasketState()
        previousResolved = true
      }

      const lockedBasket = await acquireBasketLock({ eventId, person: nextPerson, staffUid: user.uid, sessionId, staffName })
      loadSelectedBasket(nextPerson, lockedBasket.items || [])
    } catch (error) {
      if (previousResolved) {
        clearSelectedBasketState()
      } else {
        restoreBasketSnapshot(previousSnapshot)
      }
      throw error
    } finally {
      setSwitchTargetPerson(null)
    }
  }

  performSwitchToPersonRef.current = performSwitchToPerson

  async function switchToPerson(nextPerson) {
    if (displayedPerson?.id === nextPerson.id) return
    setSelectionPending(true)
    setSearchQuery('')

    try {
      await performSwitchToPerson(nextPerson)
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setSelectionPending(false)
    }
  }

  async function handleFinalizeCurrentBasket() {
    const person = selectedPersonRef.current
    const snapshot = getCurrentBasketSnapshot()
    const snapshotSummary = summarizeBasketItems(snapshot.items)

    if (!person || snapshotSummary.itemCount === 0 || finalizePending) return

    setFinalizePending(true)
    setErrorMessage('')
    setSelectedPerson(null)
    setBasketItems([])
    setBasketSyncing(false)

    try {
      await flushBasketDraft(person)
      await finalizeBasket({ eventId, personId: person.id, staffUid: user.uid, sessionId, staffName })
      resetBasketDraft([])
    } catch (error) {
      restoreBasketSnapshot(snapshot)
      setErrorMessage(error.message)
      throw error
    } finally {
      setFinalizePending(false)
    }
  }

  async function handleCancelCurrentBasket() {
    const person = selectedPersonRef.current

    if (!person || cancelPending) return

    setCancelPending(true)
    setErrorMessage('')

    try {
      clearBasketSyncTimer()
      if (activeBasketSaveRef.current) {
        await activeBasketSaveRef.current.catch(() => {})
      }
      await cancelBasket({ eventId, personId: person.id, staffUid: user.uid, sessionId })
      clearSelectedBasketState()
    } catch (error) {
      setErrorMessage(error.message)
      throw error
    } finally {
      setCancelPending(false)
    }
  }

  async function cancelCurrentBasketForAbandonment(message) {
    if (!selectedPerson) {
      return
    }

    try {
      await cancelBasket({ eventId, personId: selectedPerson.id, staffUid: user.uid, sessionId })
      clearSelectedBasketState()
      setErrorMessage(message)
    } catch (error) {
      setErrorMessage(error.message)
    }
  }

  cancelBasketHandlerRef.current = handleCancelCurrentBasket
  finalizeBasketHandlerRef.current = handleFinalizeCurrentBasket
  abandonmentCancelRef.current = cancelCurrentBasketForAbandonment

  const addItemToBasket = useCallback((product, customization) => {
    if (!selectedPersonRef.current) {
      setErrorMessage('Tétel hozzáadása előtt válassz ki egy személyt.')
      return
    }

    const currentItems = latestBasketItemsRef.current
    if (product.isDrsReturn || product.isReusableCupReturn) {
      // For Repohár returns: refuse to add more than the person actually owes.
      if (product.isReusableCupReturn && repoharLimit <= 0) {
        setErrorMessage(
          repoharOutstandingFinalized === 0
            ? 'Ez a vendég nem vett repohárt — nincs mit visszaváltani.'
            : 'Minden repohárt visszaváltottak már — nem váltható vissza több.',
        )
        return
      }

      const targetLineType = product.isReusableCupReturn ? 'reusableCupReturn' : 'drsReturn'
      const existingReturnIndex = currentItems.findIndex((item) => item.lineType === targetLineType)
      const nextItems = existingReturnIndex >= 0
        ? currentItems.map((item, index) => (
            index === existingReturnIndex ? { ...item, quantity: item.quantity + 1 } : item
          ))
        : [
            ...currentItems,
            product.isReusableCupReturn ? buildReusableCupReturnLine() : buildDrsReturnLine(),
          ]

      applyOptimisticBasketItems(nextItems)
      return
    }

    const mergeKey = buildBasketLineMergeKey(product.id, customization)
    const existingIndex = currentItems.findIndex(
      (item) => item.lineType !== 'drs'
        && (item.mergeKey || buildBasketLineMergeKey(item.productId, item.customization)) === mergeKey,
    )

    if (existingIndex >= 0) {
      const parentLine = currentItems[existingIndex]
      let drsFound = false
      const nextItems = currentItems.map((item) => {
        if (item.lineId === parentLine.lineId) return { ...item, quantity: item.quantity + 1 }
        if (item.lineType === 'drs' && item.parentLineId === parentLine.lineId) {
          drsFound = true
          return { ...item, quantity: item.quantity + 1 }
        }
        return item
      })

      if (!drsFound && product.isDRS) {
        nextItems.push(buildDrsLine({ parentLineId: parentLine.lineId }))
      }

      applyOptimisticBasketItems(nextItems)
    } else {
      const newLine = buildBasketLine({ product, customization })
      const nextItems = [...currentItems, newLine]
      if (product.isDRS) {
        nextItems.push(buildDrsLine({ parentLineId: newLine.lineId }))
      }
      applyOptimisticBasketItems(nextItems)
    }
  }, [applyOptimisticBasketItems, repoharLimit, repoharOutstandingFinalized])

  const startCustomization = useCallback((product) => {
    if (productsPaymentBlocked && !product.isCreditReturn && (product.price || 0) > 0) {
      return
    }

    const template = modifierTemplates.find((entry) => entry.id === product.modifierTemplateId)

    // Fun mode: burger/gyros products launch the catch game instead of the modal
    if (funModeActive && template && isBurgerVisualTemplate(product, template)) {
      setBurgerGameProduct({ product, template })
      return
    }

    if (funModeActive && template && isGyrosVisualTemplate(product, template)) {
      setGyrosGameProduct({ product, template })
      return
    }

    if (funModeActive && template && isPizzaVisualTemplate(product, template)) {
      setPizzaGameProduct({ product, template })
      return
    }

    if (!template) {
      addItemToBasket(product, null)
      return
    }
    setCustomizingProduct({ product, template })
    setCustomizationState(createCustomizationState(template))
  }, [modifierTemplates, addItemToBasket, funModeActive, productsPaymentBlocked])

  startCustomizationRef.current = startCustomization

  function openAvailabilityPopover(product, point) {
    setAvailabilityProduct(product)
    setAvailabilityAnchor(point || null)
  }

  function closeAvailabilityPopover() {
    setAvailabilityProduct(null)
    setAvailabilityAnchor(null)
  }

  function getAvailabilityPopoverStyle() {
    if (!availabilityAnchor || typeof window === 'undefined') return undefined
    const modalWidth = Math.min(300, window.innerWidth - 28)
    const halfWidth = modalWidth / 2
    const minX = halfWidth + 14
    const maxX = window.innerWidth - halfWidth - 14
    const minY = 70
    const maxY = window.innerHeight - 70
    const x = minX <= maxX
      ? Math.min(Math.max(minX, availabilityAnchor.x), maxX)
      : window.innerWidth / 2
    const y = minY <= maxY
      ? Math.min(Math.max(minY, availabilityAnchor.y), maxY)
      : window.innerHeight / 2
    return { left: x, top: y }
  }

  async function handleSetAvailability(isTemporarilyUnavailable) {
    if (!availabilityProduct || !user?.uid) return
    setAvailabilityPending(true)
    setErrorMessage('')
    try {
      await updateProductTemporaryAvailability({
        eventId,
        actorUid: user.uid,
        productId: availabilityProduct.id,
        productName: availabilityProduct.name,
        isTemporarilyUnavailable,
      })
      closeAvailabilityPopover()
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setAvailabilityPending(false)
    }
  }

  function handleConfirmCustomization() {
    if (!customizingProduct || !customizationState) return
    const customization = buildCustomizationPayload(customizingProduct.template, customizationState)
    const targetProduct = customizingProduct.product
    setCustomizingProduct(null)
    setCustomizationState(null)
    addItemToBasket(targetProduct, customization)
  }

  function toggleCustomizationIngredient(ingredientId) {
    setCustomizationState((current) => {
      if (!current) return current
      const nextIds = new Set(current.includedIngredientIds)
      if (nextIds.has(ingredientId)) nextIds.delete(ingredientId)
      else nextIds.add(ingredientId)
      return { ...current, includedIngredientIds: nextIds }
    })
  }

  function updateCustomizationExtraQuantity(extraId, rawValue) {
    const nextValue = Number.parseInt(rawValue || '0', 10)
    setCustomizationState((current) => {
      if (!current) return current
      return {
        ...current,
        extras: current.extras.map((entry) =>
          entry.id === extraId
            ? { ...entry, quantity: Math.max(0, Math.min(entry.maxQuantity, Number.isInteger(nextValue) ? nextValue : 0)) }
            : entry
        ),
      }
    })
  }

  function adjustCustomizationExtraQuantity(extraId, delta) {
    setCustomizationState((current) => {
      if (!current) return current
      return {
        ...current,
        extras: current.extras.map((entry) =>
          entry.id === extraId
            ? { ...entry, quantity: Math.max(0, Math.min(entry.maxQuantity, entry.quantity + delta)) }
            : entry
        ),
      }
    })
  }

  function updateBasketLine(lineId, updater) {
    if (!selectedPersonRef.current) return
    const currentItems = latestBasketItemsRef.current
    const nextItems = currentItems
      .map((item) => {
        if (item.lineId !== lineId) {
          return item
        }
        const updated = updater(item)
        let nextQuantity = Math.max(0, updated.quantity)
        // Repohár return line: never let it exceed the person's outstanding
        // cup balance (finalized buys − finalized returns + any in-basket buys).
        if (item.lineType === 'reusableCupReturn' && nextQuantity > item.quantity) {
          const currentReturn = item.quantity || 0
          const headroom = repoharLimit /* additional units allowed beyond current */
          const cap = currentReturn + headroom
          if (nextQuantity > cap) {
            nextQuantity = cap
            setErrorMessage(
              repoharOutstandingFinalized === 0
                ? 'Ez a vendég nem vett repohárt — nincs mit visszaváltani.'
                : 'Minden repohárt visszaváltottak már — nem váltható vissza több.',
            )
          }
        }
        return { ...updated, quantity: nextQuantity }
      })
      .map((item, _, allItems) => {
        if (item.lineType === 'drs') {
          const parentLine = allItems.find((candidate) => candidate.lineId === item.parentLineId)
          if (!parentLine || parentLine.quantity <= 0) {
            return { ...item, quantity: 0 }
          }

          // If we manually updated the DRS line, respect the change but cap it at the parent's quantity
          if (item.lineId === lineId) {
            return { ...item, quantity: Math.min(item.quantity, parentLine.quantity) }
          }

          // If the parent line was the one updated, sync the DRS line to match the parent's new quantity
          if (parentLine.lineId === lineId) {
            return { ...item, quantity: parentLine.quantity }
          }
        }
        return item
      })
      .filter((item, _, allItems) => {
        if (item.lineType === 'drs') {
          return allItems.some((p) => p.lineId === item.parentLineId && p.quantity > 0)
        }
        return item.quantity > 0
      })
    applyOptimisticBasketItems(nextItems)
  }

  function closeCustomization() {
    setCustomizingProduct(null)
    setCustomizationState(null)
  }

  function handleFunLongPressStart() {
    funLongPressRef.current = setTimeout(() => {
      funLongPressRef.current = null
      setFunModeActive((prev) => {
        if (prev) setBurgerGameProduct(null)
        return !prev
      })
    }, 1500)
  }

  function handleFunLongPressEnd() {
    if (funLongPressRef.current) {
      clearTimeout(funLongPressRef.current)
      funLongPressRef.current = null
    }
  }

  useEffect(() => {
    return () => {
      clearBasketSyncTimer()
    }
  }, [clearBasketSyncTimer])

  useEffect(() => {
    if (!selectedPerson) {
      clearActiveBasket()
      return
    }

    registerActiveBasket({
      personId: selectedPerson.id,
      getSnapshot: () => activeBasketSnapshotRef.current,
      cancelBasket: () => cancelBasketHandlerRef.current(),
      finalizeBasket: () => finalizeBasketHandlerRef.current(),
    })

    return () => {
      clearActiveBasket()
    }
  }, [
    clearActiveBasket,
    registerActiveBasket,
    selectedPerson,
  ])

  useEffect(() => {
    if (!selectedPerson || typeof document === 'undefined') {
      return () => {}
    }

    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || navigator.onLine === false) {
        return
      }

      refreshBasketLock({
        eventId,
        personId: selectedPerson.id,
        staffUid: user.uid,
        sessionId,
        staffName,
      }).catch((error) => {
        setErrorMessage(error.message)
      })
    }, BASKET_HEARTBEAT_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [eventId, selectedPerson, sessionId, staffName, user.uid])

  useEffect(() => {
    function clearAbandonmentTimer() {
      if (abandonmentTimeoutRef.current) {
        window.clearTimeout(abandonmentTimeoutRef.current)
        abandonmentTimeoutRef.current = null
      }
    }

    if (!selectedPerson || typeof document === 'undefined') {
      clearAbandonmentTimer()
      shouldCancelAfterReturnRef.current = false
      return () => {}
    }

    const scheduleAbandonmentCheck = () => {
      clearAbandonmentTimer()

      abandonmentTimeoutRef.current = window.setTimeout(() => {
        const isHidden = document.visibilityState === 'hidden'
        const isOffline = navigator.onLine === false

        if (!isHidden && !isOffline) {
          return
        }

      if (isOffline) {
          shouldCancelAfterReturnRef.current = true
          setErrorMessage('Túl sokáig megszakadt a kapcsolat. A kosár a kapcsolat helyreállásakor törlődni fog.')
          return
        }

        abandonmentCancelRef.current('A kosár törölve lett, mert az oldal túl sokáig inaktív volt.')
      }, BASKET_ABANDON_CANCEL_MS)
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        scheduleAbandonmentCheck()
        return
      }

      clearAbandonmentTimer()

      if (shouldCancelAfterReturnRef.current && navigator.onLine !== false) {
        shouldCancelAfterReturnRef.current = false
        abandonmentCancelRef.current('A kosár törölve lett, mert az eszköz túl sokáig offline volt.')
      }
    }

    const handleOffline = () => {
      scheduleAbandonmentCheck()
    }

    const handleOnline = () => {
      clearAbandonmentTimer()

      if (shouldCancelAfterReturnRef.current && document.visibilityState === 'visible') {
        shouldCancelAfterReturnRef.current = false
        abandonmentCancelRef.current('A kosár törölve lett, mert az eszköz túl sokáig offline volt.')
      }
    }

    const handlePageHide = () => {
      // Tab is closing or navigating away. The server-side STALE_BASKET_LOCK_MS 
      // will release the lock after 2.5 minutes of inactivity, but we clear local state now.
      clearActiveBasket()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    window.addEventListener('pagehide', handlePageHide)

    return () => {
      clearAbandonmentTimer()
      shouldCancelAfterReturnRef.current = false
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [clearActiveBasket, eventId, selectedPerson, sessionId, user.uid])

  return (
    <div className={`pos-screen-layout${funModeActive ? ' fun-mode' : ''}`}>
      <input
        ref={hiddenScannerInputRef}
        className="pos-hidden-scanner-input"
        type="text"
        autoComplete="off"
        inputMode="none"
        aria-hidden="true"
        tabIndex={-1}
        onBlur={handleHiddenScannerInputBlur}
        onChange={handleHiddenScannerInputChange}
        onKeyDown={handleHiddenScannerInputKeyDown}
      />
      {/* LEFT COLUMN: Lookup + Basket */}
      <div className="pos-basket-area">
        <div className="pos-toolbar-area">
          {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

          <div className="lookup-toolbar">
            <input
              id="personSearch"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Keresés név vagy 4 számjegyű kód alapján..."
              autoComplete="off"
            />
            <button
              type="button"
              className={`icon-button${cameraOpen ? ' active' : ''}`}
              onClick={() => {
                if (!scannerSupported) { setErrorMessage('A kamerás QR-beolvasás nem támogatott.'); return }
                setCameraOpen((current) => !current)
              }}
              aria-label={cameraOpen ? 'Kamera bezárása' : 'QR beolvasása'}
              title={cameraOpen ? 'Kamera bezárása' : 'QR-kód beolvasása'}
            >
              <CameraIcon />
            </button>
          </div>

          {cameraOpen && (
            <div className="camera-panel">
              <video ref={videoRef} className="camera-preview" playsInline muted />
            </div>
          )}

          {shouldShowSearchResults && (
            <div className="record-list compact pos-search-results panel">
              {filteredPeople.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  className={`record-row${displayedPerson?.id === person.id ? ' selected' : ''}`}
                  onClick={() => switchToPerson(person)}
                  disabled={selectionPending || finalizePending || cancelPending}
                >
                  <span>
                    <strong>{person.displayName}</strong>
                    <small>{getPersonDisplayId(person)}{person.team ? ` · ${person.team}` : ''}</small>
                  </span>
                  <span style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--primary)', flexShrink: 0 }}>
                    {formatHuf(person.balance || 0)}
                  </span>
                </button>
              ))}
              {filteredPeople.length === 0 && <p className="helper-text" style={{ padding: '8px' }}>Nincs találat.</p>}
            </div>
          )}
        </div>

        {/* Receipt */}
        <div className="receipt-container">
          <div className="receipt-header">
            {displayedPerson ? (
              <>
                <div style={{ fontWeight: 800, fontSize: '1rem' }}>{displayedPerson.displayName}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '2px' }}>
                  #{getPersonDisplayId(displayedPerson)}
                </div>
                <div style={{ borderTop: '1px dashed var(--border)', marginTop: '8px', paddingTop: '8px', fontSize: '0.85rem' }}>
                  Egyenleg: {formatHuf(displayedPerson.balance || 0)}
                </div>
                {isSwitchingPerson ? (
                  <p className="helper-text" style={{ marginTop: '8px' }}>
                    Vendég betöltése...
                  </p>
                ) : null}
              </>
            ) : (
              <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>Nincs kiválasztott vendég</p>
            )}
          </div>

          <div className="receipt-body">
            {displayedBasketSummary.items.map((item) => {
              const isDrsLine = item.lineType === 'drs'
              const isDrsReturnLine = item.lineType === 'drsReturn'
              const isReusableCupReturnLine = item.lineType === 'reusableCupReturn'
              const isCreditReturnLine = isDrsReturnLine || isReusableCupReturnLine
              const removedIngredients = item.customization?.removedIngredients || []
              const extraIngredients = (item.customization?.extras || []).filter((e) => e.quantity > 0)
              const hasCustomization = removedIngredients.length > 0 || extraIngredients.length > 0
              return (
                <div key={item.lineId} className="receipt-line-group">
                  <div
                    className={`receipt-line${isDrsLine ? ' receipt-line-drs' : ''}${isCreditReturnLine ? ' receipt-line-credit' : ''}`}
                  >
                    <span
                      className="receipt-item-name"
                      style={isDrsLine ? { color: 'var(--muted)', fontSize: '0.8em', paddingLeft: '10px' } : {}}
                    >
                      {item.productName}
                    </span>
                    <span className="receipt-dots" />
                    <span className="receipt-qty-price">{item.quantity}x</span>
                    <span className="receipt-line-price">{formatHuf(item.lineTotal)}</span>
                    <div className="receipt-controls">
                      <button
                        type="button"
                        className="receipt-btn"
                        onClick={() => updateBasketLine(item.lineId, (entry) => ({ ...entry, quantity: entry.quantity - 1 }))}
                        aria-label="Remove one"
                      >
                        -
                      </button>
                      {!(isDrsLine && item.quantity >= (displayedBasketSummary.items.find((p) => p.lineId === item.parentLineId)?.quantity || 0)) && (
                        <button
                          type="button"
                          className="receipt-btn"
                          onClick={() => updateBasketLine(item.lineId, (entry) => ({ ...entry, quantity: entry.quantity + 1 }))}
                          aria-label="Add one"
                        >
                          +
                        </button>
                      )}
                    </div>
                  </div>
                  {hasCustomization ? (
                    <div className="receipt-custom-row">
                      {removedIngredients.length > 0 && (
                        <span className="basket-mod basket-mod--removed">
                          – {removedIngredients.map((i) => i.label).join(', ')}
                        </span>
                      )}
                      {extraIngredients.length > 0 && (
                        <span className="basket-mod basket-mod--extra">
                          + {extraIngredients.map((e) => `${e.label}${e.quantity > 1 ? ` ×${e.quantity}` : ''}`).join(', ')}
                        </span>
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })}
            {displayedBasketSummary.items.length === 0 && (
              <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: '0.85rem', padding: '20px 0' }}>
                - Üres kosár -
              </p>
            )}
          </div>

          <div className="receipt-footer">
            {basketSyncing && selectedPerson ? (
              <p className="helper-text" style={{ marginBottom: '10px' }}>
                Kosár szinkronizálása...
              </p>
            ) : null}
            {isSwitchingPerson ? (
              <p className="helper-text" style={{ marginBottom: '10px' }}>
                Vendég kiválasztása folyamatban...
              </p>
            ) : null}
            <div className="receipt-subtotal">
              <span>Tételek</span>
              <span className="receipt-dots" />
              <span>{displayedBasketSummary.itemCount}</span>
            </div>
            {displayedPerson && displayedBasketSummary.totalAmount !== 0 && (
              <div className="receipt-subtotal">
                <span>{displayedBasketSummary.totalAmount > 0 ? 'Maradék' : 'Jóváírás után'}</span>
                <span className="receipt-dots" />
                <span>{formatHuf((displayedPerson.balance || 0) - displayedBasketSummary.totalAmount)}</span>
              </div>
            )}
            <div className="receipt-total">
              <span>TOTAL</span>
              <span className="receipt-dots" />
              <span>{formatHuf(displayedBasketSummary.totalAmount)}</span>
            </div>

            <div className="receipt-action-row pos-cart-action-row">
              <button
                type="button"
                className="secondary-button pos-cart-delete-btn"
                onClick={() => handleCancelCurrentBasket().catch(() => {})}
                disabled={cancelPending || finalizePending || selectionPending || !selectedPerson}
              >
                Törlés
              </button>
              <button
                type="button"
                className="primary-button pos-cart-finalize-btn"
                onClick={() => handleFinalizeCurrentBasket().catch(() => {})}
                disabled={finalizePending || cancelPending || selectionPending || displayedBasketSummary.itemCount === 0}
              >
                {finalizePending ? 'Folyamatban...' : 'Lezárás'}
              </button>
            </div>
          </div>
        </div>

      </div>

      {/* RIGHT COLUMN: Product catalog */}
      <div className="pos-products-area panel">
        <div className="pos-catalog-header">
          <div className="category-row">
            {allCategories.map((category) => (
              <div key={category}>
                <button
                  type="button"
                  className={`category-btn${selectedCategory === category ? ' active' : ''}`}
                  onClick={() => setSelectedCategory(category)}
                >
                  {category}
                </button>
              </div>
            ))}
          </div>

          <div
            className={`pos-workload-mini ${workloadError ? 'workload-error-state' : workload.barClass}`}
            onPointerDown={handleFunLongPressStart}
            onPointerUp={handleFunLongPressEnd}
            onPointerLeave={handleFunLongPressEnd}
            onContextMenu={(e) => e.preventDefault()}
            style={{ userSelect: 'none', touchAction: 'none' }}
          >
            <div className="workload-mini-left">
              <span className="workload-tag">Konyha</span>
              <span className="workload-level">{workloadError ? 'Hiba' : workload.label}</span>
            </div>
            <div className="workload-mini-center">
              <span className="workload-wait-label">Várható várakozás</span>
              <span className="workload-wait-value">{workloadError ? '—' : workload.formattedWait}</span>
            </div>
            <div className="workload-mini-right">
              <span className="workload-count">{workloadError ? 'Nem elérhető' : `${workload.itemCount} tétel`}</span>
            </div>
          </div>
        </div>

        {!displayedPerson && (
          <p className="helper-text" style={{ textAlign: 'center', paddingTop: '8px' }}>
            Rendelés indításához olvass be vagy keress rá egy vendégre.
          </p>
        )}

        <div className={`product-grid-blocker-shell${productsPaymentBlocked ? ' payment-blocked' : ''}`}>
          {productsPaymentBlocked ? (
            <div className="products-do-not-serve-overlay" role="alert">
              <span className="product-warning-triangle">!</span>
              <strong>NE SZOLGÁLD KI</strong>
              <span>Le van gatyásodva az öreg</span>
            </div>
          ) : null}
          <div className="product-grid-scroll">
          <div
            className="product-category-list"
            style={{ opacity: productsDisabled ? 0.45 : 1 }}
          >
            {groupedProducts.map((group) => (
              <section key={group.category} className="product-category-section">
                {showProductCategoryHeadings || group.category === 'Bor' || group.category === 'Hosszúital' ? (
                  <div className="product-category-title-row">
                    <h4 className="product-category-title">{group.category}</h4>
                    {group.category === 'Bor' ? (
                      <button
                        type="button"
                        className="spritzer-help-button"
                        onClick={() => setSpritzerGuideOpen(true)}
                        aria-label="Fröccs útmutató megnyitása"
                        title="Fröccs útmutató"
                      >
                        <HelpIcon />
                      </button>
                    ) : null}
                    {group.category === 'Hosszúital' ? (
                      <button
                        type="button"
                        className="spritzer-help-button longdrink-help-button"
                        onClick={() => setLongDrinkGuideOpen(true)}
                        aria-label="Hosszúital útmutató megnyitása"
                        title="Hosszúital útmutató"
                      >
                        <HelpIcon />
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <div className="product-grid">
                  {group.items.map((product) => (
                    <ProductTile
                      key={product.id}
                      product={product}
                      onClick={startCustomization}
                      onLongPress={openAvailabilityPopover}
                      disabled={blockingBasketAction}
                      /* Repohár visszaváltás at limit stays clickable on purpose
                         — the tap fires the error banner via addItemToBasket. */
                      clickDisabled={
                        productsDisabled
                        || (productsPaymentBlocked && !product.isCreditReturn && (product.price || 0) > 0)
                      }
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
          </div>
        </div>

        {availabilityProduct ? (
          <>
            <div
              className="modal-backdrop pos-availability-backdrop"
              onClick={() => {
                if (!availabilityPending) closeAvailabilityPopover()
              }}
            />
            <div
              ref={availabilityModalRef}
              className="pos-availability-modal floating-overlay"
              style={getAvailabilityPopoverStyle()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="posAvailabilityTitle"
            >
              <h4 id="posAvailabilityTitle">{availabilityProduct.name}</h4>
              <div className="pos-availability-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => handleSetAvailability(false)}
                  disabled={availabilityPending}
                >
                  Elérhető
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => handleSetAvailability(true)}
                  disabled={availabilityPending}
                >
                  {availabilityPending ? 'Mentés...' : 'Elfogyott'}
                </button>
              </div>
            </div>
          </>
        ) : null}

        {spritzerGuideOpen && (
          <>
            <div className="modal-backdrop spritzer-guide-backdrop" onClick={() => setSpritzerGuideOpen(false)} />
            <div className="spritzer-guide-modal floating-overlay" role="dialog" aria-modal="true" aria-labelledby="spritzerGuideTitle">
              <div className="spritzer-guide-header">
                <div>
                  <div className="spritzer-guide-eyebrow">Bor + szóda</div>
                  <h4 id="spritzerGuideTitle">Fröccs útmutató</h4>
                </div>
                <button type="button" className="secondary-button" onClick={() => setSpritzerGuideOpen(false)}>
                  Bezárás
                </button>
              </div>

              <div className="spritzer-guide-grid">
                {SPRITZER_GUIDE.map((spritzer) => (
                  <article key={spritzer.name} className="spritzer-card">
                    <SpritzerGlass wineDl={spritzer.wineDl} sodaDl={spritzer.sodaDl} />
                    <div className="spritzer-card-body">
                      <div className="spritzer-card-title-row">
                        <h5>{spritzer.name}</h5>
                        <span>{spritzer.ratio}</span>
                      </div>
                      <div className="spritzer-recipe-row">
                        <span className="spritzer-recipe-pill spritzer-recipe-wine">{spritzer.wineDl} dl bor</span>
                        <span className="spritzer-recipe-plus">+</span>
                        <span className="spritzer-recipe-pill spritzer-recipe-soda">{spritzer.sodaDl} dl szóda</span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </>
        )}

        {longDrinkGuideOpen && (
          <>
            <div className="modal-backdrop spritzer-guide-backdrop" onClick={() => setLongDrinkGuideOpen(false)} />
            <div className="spritzer-guide-modal longdrink-guide-modal floating-overlay" role="dialog" aria-modal="true" aria-labelledby="longDrinkGuideTitle">
              <div className="spritzer-guide-header longdrink-guide-header">
                <div>
                  <div className="spritzer-guide-eyebrow">Alkohol + mixer</div>
                  <h4 id="longDrinkGuideTitle">Hosszúital útmutató</h4>
                </div>
                <button type="button" className="secondary-button" onClick={() => setLongDrinkGuideOpen(false)}>
                  Bezárás
                </button>
              </div>

              <div className="longdrink-guide-body">
                <section className="longdrink-rule-panel" aria-label="Általános hosszúital szabályok">
                  {LONG_DRINK_RULES.map((rule) => (
                    <span key={rule}>{rule}</span>
                  ))}
                </section>

                <div className="longdrink-guide-grid">
                  {LONG_DRINK_GUIDE.map((drink) => (
                    <article key={drink.name} className="longdrink-card">
                      <LongDrinkGlass tone={drink.tone} />
                      <div className="longdrink-card-body">
                        <div className="longdrink-card-title-row">
                          <h5>{drink.name}</h5>
                          <span>4 cl + 2,5 dl</span>
                        </div>
                        <div className="longdrink-recipe-row">
                          <span className="longdrink-recipe-pill longdrink-recipe-spirit">{drink.spirit}</span>
                          <span className="spritzer-recipe-plus">+</span>
                          <span className="longdrink-recipe-pill longdrink-recipe-mixer">{drink.mixer}</span>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {/* Customization modal */}
        {customizingProduct && (
          <>
            <div
              className="modal-backdrop"
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)', zIndex: 999 }}
              onClick={closeCustomization}
            />
            <div
              className="customization-modal floating-overlay"
              style={{
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                /*
                 * Pizza modal: size exactly = pizza + chip panel + chrome,
                 * with a 24px breathing margin on every side of the screen.
                 *   vertical chrome (margins 48 + header 60 + bodyPad 16 + footer 56) = 180px
                 *   horizontal chrome (margins 48 + bodyPad 24 + gap 22 + chip 260)   = 354px
                 */
                width: customizationIsPizzaVisual
                  ? 'calc(min(calc(100vh - 180px), calc(100vw - 354px)) + 306px)'
                  : customizationIsWideVisual ? 'min(860px, calc(100vw - 40px))' : 'min(680px, calc(100vw - 40px))',
                height: customizationIsPizzaVisual
                  ? 'calc(min(calc(100vh - 180px), calc(100vw - 354px)) + 132px)'
                  : undefined,
                maxHeight: customizationIsPizzaVisual ? 'calc(100vh - 48px)' : 'calc(100vh - 40px)',
                zIndex: 1000,
                background: 'white',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-lg)',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              {/* Modal header */}
              <div className="customization-modal-header" style={{ padding: customizationIsPizzaVisual ? '12px 20px' : '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                <div>
                  <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: '3px' }}>
                    Testreszabás
                  </div>
                  <h4 style={{ fontSize: '1.15rem', fontWeight: 800 }}>
                    {customizingProduct.product.name}
                  </h4>
                </div>
                <button type="button" className="secondary-button" onClick={closeCustomization}>
                  Bezárás
                </button>
              </div>

              {/* Modal body */}
              <div className={`customization-modal-body${customizationIsWideVisual ? ' is-burger' : ''}`} style={{ flex: 1, padding: customizationIsPizzaVisual ? '8px 12px' : '20px 24px', display: 'flex', flexDirection: 'column' }}>
                <div className={`dashboard-grid${customizationIsWideVisual ? ' customization-grid--burger' : ''}`} style={{ flex: 1, minHeight: 0 }}>
                  {customizationIsPizzaVisual ? (
                    <PizzaCustomizer
                      template={customizingProduct.template}
                      customizationState={customizationState}
                      onToggleIngredient={toggleCustomizationIngredient}
                      onRemoveExtraLayer={(extraId) => adjustCustomizationExtraQuantity(extraId, -1)}
                      extrasContent={(
                        <CustomizationExtras
                          extras={customizationState?.extras}
                          onAdjustQuantity={adjustCustomizationExtraQuantity}
                          onUpdateQuantity={updateCustomizationExtraQuantity}
                        />
                      )}
                    />
                  ) : customizationIsGyrosVisual ? (
                    <GyrosCustomizer
                      template={customizingProduct.template}
                      customizationState={customizationState}
                      onToggleIngredient={toggleCustomizationIngredient}
                      onRemoveExtraLayer={(extraId) => adjustCustomizationExtraQuantity(extraId, -1)}
                      extrasContent={(
                        <CustomizationExtras
                          extras={customizationState?.extras}
                          onAdjustQuantity={adjustCustomizationExtraQuantity}
                          onUpdateQuantity={updateCustomizationExtraQuantity}
                        />
                      )}
                    />
                  ) : customizationIsBurgerVisual ? (
                    <BurgerCustomizer
                      template={customizingProduct.template}
                      customizationState={customizationState}
                      onToggleIngredient={toggleCustomizationIngredient}
                      onRemoveExtraLayer={(extraId) => adjustCustomizationExtraQuantity(extraId, -1)}
                      extrasContent={(
                        <CustomizationExtras
                          extras={customizationState?.extras || []}
                          onAdjustQuantity={adjustCustomizationExtraQuantity}
                          onUpdateQuantity={updateCustomizationExtraQuantity}
                        />
                      )}
                    />
                  ) : (customizingProduct.template.defaultIncludedIngredients || []).length > 0 && (
                    <div className="stack-block" style={{ gap: '8px' }}>
                      <h5 className="card-title" style={{ marginBottom: '4px' }}>Hozzávalók</h5>
                      {customizingProduct.template.defaultIncludedIngredients.map((ingredient) => (
                        <label key={ingredient.id} className="checkbox-row" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                          <input
                            type="checkbox"
                            checked={customizationState?.includedIngredientIds.has(ingredient.id) || false}
                            onChange={() => toggleCustomizationIngredient(ingredient.id)}
                          />
                          <span style={{ fontWeight: 500, fontSize: '0.875rem' }}>{ingredient.label}</span>
                        </label>
                      ))}
                    </div>
                  )}

                  {!customizationIsBurgerVisual && !customizationIsGyrosVisual && !customizationIsPizzaVisual && (customizationState?.extras || []).length > 0 && (
                    <div className="stack-block" style={{ gap: '8px' }}>
                      <h5 className="card-title" style={{ marginBottom: '4px' }}>Extrák</h5>
                      {customizationState.extras.map((extra) => (
                        <div
                          key={extra.id}
                          className="customization-extra-row"
                          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
                        >
                          <div style={{ flex: 1, minWidth: 0, paddingRight: '12px' }}>
                            <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>{extra.label}</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>+{formatHuf(extra.price)} each</div>
                          </div>
                          <div className="customization-extra-stepper" aria-label={`${extra.label} mennyiseg`}>
                            <button
                              type="button"
                              className="customization-extra-stepper-btn"
                              onClick={() => adjustCustomizationExtraQuantity(extra.id, -1)}
                              disabled={extra.quantity <= 0}
                              aria-label={`${extra.label} csokkentese`}
                            >
                              -
                            </button>
                            <input
                              type="number"
                              min="0"
                              max={extra.maxQuantity}
                              value={extra.quantity}
                              className="customization-extra-input"
                              onChange={(event) => updateCustomizationExtraQuantity(extra.id, event.target.value)}
                              aria-label={`${extra.label} mennyisege`}
                            />
                            <button
                              type="button"
                              className="customization-extra-stepper-btn"
                              onClick={() => adjustCustomizationExtraQuantity(extra.id, 1)}
                              disabled={extra.quantity >= extra.maxQuantity}
                              aria-label={`${extra.label} novelese`}
                            >
                              +
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Modal footer */}
              <div className="customization-modal-footer" style={{ padding: customizationIsPizzaVisual ? '10px 20px' : '16px 24px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
                <button
                  type="button"
                  className="primary-button"
                  style={{ width: '100%', padding: '12px' }}
                  onClick={handleConfirmCustomization}
                >
                  Kosárba
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {burgerGameProduct ? (
        <BurgerCatchGame
          product={burgerGameProduct.product}
          template={burgerGameProduct.template}
          onComplete={(customization) => {
            const { product } = burgerGameProduct
            setBurgerGameProduct(null)
            addItemToBasket(product, customization)
          }}
          onCancel={() => setBurgerGameProduct(null)}
        />
      ) : null}

      {gyrosGameProduct ? (
        <BurgerCatchGame
          variant="gyros"
          product={gyrosGameProduct.product}
          template={gyrosGameProduct.template}
          onComplete={(customization) => {
            const { product } = gyrosGameProduct
            setGyrosGameProduct(null)
            addItemToBasket(product, customization)
          }}
          onCancel={() => setGyrosGameProduct(null)}
        />
      ) : null}

      {pizzaGameProduct ? (
        <BurgerCatchGame
          variant="pizza"
          product={pizzaGameProduct.product}
          template={pizzaGameProduct.template}
          onComplete={(customization) => {
            const { product } = pizzaGameProduct
            setPizzaGameProduct(null)
            addItemToBasket(product, customization)
          }}
          onCancel={() => setPizzaGameProduct(null)}
        />
      ) : null}
    </div>
  )
}
