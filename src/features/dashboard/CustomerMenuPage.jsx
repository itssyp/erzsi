import { useEffect, useMemo, useState } from 'react'
import { DRS_DEPOSIT_AMOUNT } from '../drs/drsModels'
import { useActiveEvent } from '../events/useActiveEvent'
import { normalizeSearchText } from '../../lib/normalize'
import { formatHuf } from '../../lib/money'
import { PRODUCT_CATEGORIES, subscribeToProducts } from '../products/productService'
import { isFoodCategory, normalizeProductCategory } from '../products/productModels'

const ALL_CATEGORIES = 'all'

function MenuPrice({ product }) {
  const basePrice = Number(product.price)
  if (!Number.isInteger(basePrice)) return <strong className="customer-menu-price">-</strong>
  if (!product.isDRS) return <strong className="customer-menu-price">{formatHuf(basePrice)}</strong>

  return (
    <div
      className="customer-menu-price customer-menu-price-breakdown"
      aria-label={`${formatHuf(basePrice)} alapár és ${formatHuf(DRS_DEPOSIT_AMOUNT)} DRS betétdíj, összesen ${formatHuf(basePrice + DRS_DEPOSIT_AMOUNT)}`}
    >
      <strong>{formatHuf(basePrice)}</strong>
      <small>+ {formatHuf(DRS_DEPOSIT_AMOUNT)} DRS</small>
    </div>
  )
}

function getAvailabilityLabel(product, isKitchenClosed) {
  if (isKitchenClosed && isFoodCategory(product.category)) return 'A konyha zárva'
  if (product.isTemporarilyUnavailable) return 'Átmenetileg nem elérhető'
  return null
}

export function CustomerMenuPage() {
  const { activeEvent, activeEventId } = useActiveEvent()
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [selectedCategory, setSelectedCategory] = useState(ALL_CATEGORIES)
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    setProducts([])
    setLoading(true)
    setErrorMessage('')
    setSelectedCategory(ALL_CATEGORIES)
    setSearchQuery('')

    return subscribeToProducts(
      activeEventId,
      (nextProducts) => {
        setProducts(nextProducts)
        setLoading(false)
        setErrorMessage('')
      },
      (error) => {
        setErrorMessage(error.message || 'Nem sikerült betölteni a kínálatot.')
        setLoading(false)
      },
    )
  }, [activeEventId])

  const activeProducts = useMemo(() => products
    .filter((product) => product.isActive)
    .map((product) => ({
      ...product,
      category: normalizeProductCategory(product.category) || 'Egyéb',
    })), [products])

  const categories = useMemo(() => {
    const available = new Set(activeProducts.map((product) => product.category))
    const standard = PRODUCT_CATEGORIES.filter((category) => available.delete(category))
    return [...standard, ...Array.from(available).sort((left, right) => left.localeCompare(right, 'hu'))]
  }, [activeProducts])

  const sections = useMemo(() => {
    const search = normalizeSearchText(searchQuery)
    const filtered = activeProducts.filter((product) => {
      if (selectedCategory !== ALL_CATEGORIES && product.category !== selectedCategory) return false
      if (!search) return true
      return normalizeSearchText(`${product.name || ''} ${product.category}`).includes(search)
    })

    return categories
      .map((category) => ({
        category,
        items: filtered
          .filter((product) => product.category === category)
          .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), 'hu')),
      }))
      .filter((section) => section.items.length)
  }, [activeProducts, categories, searchQuery, selectedCategory])

  const visibleCount = sections.reduce((count, section) => count + section.items.length, 0)
  const isKitchenClosed = Boolean(activeEvent?.isKitchenClosed)

  return (
    <div className="customer-menu-page">
      <div className="customer-menu-toolbar">
        <div className="customer-menu-toolbar-top">
          <div>
            <span className="customer-menu-section-kicker">Büfé</span>
            <h2>Étlap és itallap</h2>
          </div>
          <span className="customer-menu-count" aria-live="polite">
            {loading ? 'Betöltés…' : `${visibleCount} termék`}
          </span>
        </div>

        <label className="customer-menu-search">
          <span>Termék keresése</span>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Mit keresel?"
            autoComplete="off"
          />
        </label>

        <div className="customer-menu-filters" role="group" aria-label="Terméktípus szűrő">
          {[ALL_CATEGORIES, ...categories].map((category) => (
            <button
              key={category}
              type="button"
              className={`customer-menu-filter${selectedCategory === category ? ' is-active' : ''}`}
              aria-pressed={selectedCategory === category}
              onClick={() => setSelectedCategory(category)}
            >
              {category === ALL_CATEGORIES ? 'Összes' : category}
            </button>
          ))}
        </div>
      </div>

      {errorMessage ? <div className="error-banner" role="alert">{errorMessage}</div> : null}

      {loading ? (
        <div className="customer-menu-empty" role="status">A kínálat betöltése folyamatban…</div>
      ) : sections.length ? (
        <div className="customer-menu-sections">
          {sections.map(({ category, items }) => (
            <section key={category} className="customer-menu-section" aria-label={category}>
              <div className="customer-menu-section-heading">
                <h3>{category}</h3>
              </div>
              <div className="customer-menu-items">
                {items.map((product) => {
                  const availabilityLabel = getAvailabilityLabel(product, isKitchenClosed)
                  return (
                    <article
                      key={product.id}
                      className={`customer-menu-item${availabilityLabel ? ' is-unavailable' : ''}`}
                    >
                      <div className="customer-menu-item-info">
                        <h4>{product.name}</h4>
                        <div className="customer-menu-item-meta">
                          {availabilityLabel ? (
                            <span className="customer-menu-unavailable">{availabilityLabel}</span>
                          ) : null}
                          {product.modifierTemplateId ? <span>Alapár, extrák nélkül</span> : null}
                        </div>
                      </div>
                      <MenuPrice product={product} />
                    </article>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="customer-menu-empty" role="status">
          {activeProducts.length
            ? 'Nincs a szűrésnek megfelelő termék. Próbálj másik kategóriát vagy keresést.'
            : 'A kínálat még nem elérhető. Nézz vissza később.'}
        </div>
      )}
    </div>
  )
}
