import { useEffect, useMemo, useState } from 'react'
import { formatHuf } from '../../lib/money'
import { PRODUCT_CATEGORIES } from '../products/productModels'
import { saveProduct, subscribeToProducts } from '../products/productService'
import { saveModifierTemplate, subscribeToModifierTemplates } from '../modifiers/modifierTemplateService'

const emptyProductState = {
  productId: null,
  name: '',
  category: PRODUCT_CATEGORIES[0],
  price: '',
  isActive: true,
  isTemporarilyUnavailable: false,
  modifierTemplateId: '',
}

const PRODUCT_AVAILABILITY = {
  active: 'active',
  unavailable: 'unavailable',
  inactive: 'inactive',
}

function createIngredientField(label = '') {
  return {
    id: crypto.randomUUID(),
    label,
  }
}

function createExtraField({ label = '', price = '', maxQuantity = '1' } = {}) {
  return {
    id: crypto.randomUUID(),
    label,
    price,
    maxQuantity,
  }
}

const emptyTemplateState = {
  templateId: null,
  name: '',
  defaultIncludedIngredients: [createIngredientField()],
  optionalExtras: [createExtraField()],
}

function getAvailabilityState(product) {
  if (!product.isActive) {
    return PRODUCT_AVAILABILITY.inactive
  }

  return product.isTemporarilyUnavailable
    ? PRODUCT_AVAILABILITY.unavailable
    : PRODUCT_AVAILABILITY.active
}

function buildAvailabilityPatch(availability) {
  if (availability === PRODUCT_AVAILABILITY.inactive) {
    return { isActive: false, isTemporarilyUnavailable: false }
  }

  if (availability === PRODUCT_AVAILABILITY.unavailable) {
    return { isActive: true, isTemporarilyUnavailable: true }
  }

  return { isActive: true, isTemporarilyUnavailable: false }
}

function normalizeQuery(value) {
  return value.trim().toLowerCase()
}

function productMatchesQuery(product, query, templateName) {
  if (!query) {
    return true
  }

  return [product.name, product.category, templateName]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function templateMatchesQuery(template, query) {
  if (!query) {
    return true
  }

  return [
    template.name,
    ...(template.defaultIncludedIngredients || []).map((item) => item.label),
    ...(template.optionalExtras || []).map((item) => item.label),
  ]
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function sanitizeIngredientFields(fields) {
  return fields
    .map((field) => field.label.trim())
    .filter(Boolean)
}

function sanitizeExtraFields(fields) {
  return fields
    .map((field) => {
      const label = field.label.trim()
      if (!label) {
        return null
      }

      const price = Number.parseInt(field.price || '0', 10)
      const maxQuantity = Number.parseInt(field.maxQuantity || '1', 10)

      return {
        label,
        price: Number.isInteger(price) ? price : 0,
        maxQuantity: Number.isInteger(maxQuantity) && maxQuantity > 0 ? maxQuantity : 1,
      }
    })
    .filter(Boolean)
}

function buildTemplatePayload(templateState) {
  const includedIngredients = sanitizeIngredientFields(templateState.defaultIncludedIngredients)
  const optionalExtras = sanitizeExtraFields(templateState.optionalExtras)

  return {
    templateId: templateState.templateId,
    name: templateState.name,
    defaultIncludedIngredientsText: includedIngredients.join('\n'),
    optionalExtrasText: optionalExtras
      .map((item) => `${item.label}|${item.price}|${item.maxQuantity}`)
      .join('\n'),
  }
}

function ensureAtLeastOneIngredient(fields) {
  return fields.length ? fields : [createIngredientField()]
}

function ensureAtLeastOneExtra(fields) {
  return fields.length ? fields : [createExtraField()]
}

export function ProductManagementPanel({ eventId, actorUid }) {
  const [products, setProducts] = useState([])
  const [modifierTemplates, setModifierTemplates] = useState([])
  const [productState, setProductState] = useState(emptyProductState)
  const [templateState, setTemplateState] = useState(emptyTemplateState)
  const [productQuery, setProductQuery] = useState('')
  const [templateQuery, setTemplateQuery] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  const availabilityState = useMemo(() => getAvailabilityState(productState), [productState])

  useEffect(() => {
    return subscribeToProducts(eventId, setProducts, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    return subscribeToModifierTemplates(eventId, setModifierTemplates, (error) => setErrorMessage(error.message))
  }, [eventId])

  const sortedTemplates = useMemo(() => modifierTemplates.slice(), [modifierTemplates])
  const templateLookup = useMemo(
    () => Object.fromEntries(modifierTemplates.map((template) => [template.id, template])),
    [modifierTemplates],
  )
  const sanitizedIngredientsPreview = useMemo(
    () => sanitizeIngredientFields(templateState.defaultIncludedIngredients),
    [templateState.defaultIncludedIngredients],
  )
  const sanitizedExtrasPreview = useMemo(
    () => sanitizeExtraFields(templateState.optionalExtras),
    [templateState.optionalExtras],
  )
  const filteredProducts = useMemo(() => {
    const query = normalizeQuery(productQuery)

    return products.filter((product) =>
      productMatchesQuery(product, query, templateLookup[product.modifierTemplateId || '']?.name || ''),
    )
  }, [productQuery, products, templateLookup])
  const filteredTemplates = useMemo(() => {
    const query = normalizeQuery(templateQuery)

    return modifierTemplates.filter((template) => templateMatchesQuery(template, query))
  }, [modifierTemplates, templateQuery])

  async function runAction(action) {
    setPending(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      await action()
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setPending(false)
    }
  }

  async function handleProductSubmit(event) {
    event.preventDefault()
    const isEditing = Boolean(productState.productId)

    await runAction(() =>
      saveProduct({
        eventId,
        actorUid,
        ...productState,
      }),
    )

    setProductState(emptyProductState)
    setStatusMessage(isEditing ? 'A termék frissítve lett.' : 'A termék létrejött.')
  }

  async function handleTemplateSubmit(event) {
    event.preventDefault()
    const isEditing = Boolean(templateState.templateId)

    await runAction(() =>
      saveModifierTemplate({
        eventId,
        actorUid,
        ...buildTemplatePayload(templateState),
      }),
    )

    setTemplateState(emptyTemplateState)
    setStatusMessage(isEditing ? 'A módosítósablon frissítve lett.' : 'A módosítósablon létrejött.')
  }

  function loadProductIntoForm(product) {
    setProductState({
      productId: product.id,
      name: product.name,
      category: product.category,
      price: String(product.price),
      isActive: product.isActive,
      isTemporarilyUnavailable: product.isTemporarilyUnavailable,
      modifierTemplateId: product.modifierTemplateId || '',
    })
    setStatusMessage('')
  }

  function loadTemplateIntoForm(template) {
    setTemplateState({
      templateId: template.id,
      name: template.name,
      defaultIncludedIngredients: ensureAtLeastOneIngredient(
        (template.defaultIncludedIngredients || []).map((item) => createIngredientField(item.label)),
      ),
      optionalExtras: ensureAtLeastOneExtra(
        (template.optionalExtras || []).map((item) =>
          createExtraField({
            label: item.label,
            price: String(item.price ?? ''),
            maxQuantity: String(item.maxQuantity ?? 1),
          }),
        ),
      ),
    })
    setStatusMessage('')
  }

  function updateIngredientField(id, value) {
    setTemplateState((current) => ({
      ...current,
      defaultIncludedIngredients: current.defaultIncludedIngredients.map((field) =>
        field.id === id ? { ...field, label: value } : field,
      ),
    }))
  }

  function removeIngredientField(id) {
    setTemplateState((current) => ({
      ...current,
      defaultIncludedIngredients: ensureAtLeastOneIngredient(
        current.defaultIncludedIngredients.filter((field) => field.id !== id),
      ),
    }))
  }

  function addIngredientField() {
    setTemplateState((current) => ({
      ...current,
      defaultIncludedIngredients: [...current.defaultIncludedIngredients, createIngredientField()],
    }))
  }

  function updateExtraField(id, key, value) {
    setTemplateState((current) => ({
      ...current,
      optionalExtras: current.optionalExtras.map((field) =>
        field.id === id ? { ...field, [key]: value } : field,
      ),
    }))
  }

  function removeExtraField(id) {
    setTemplateState((current) => ({
      ...current,
      optionalExtras: ensureAtLeastOneExtra(current.optionalExtras.filter((field) => field.id !== id)),
    }))
  }

  function addExtraField() {
    setTemplateState((current) => ({
      ...current,
      optionalExtras: [...current.optionalExtras, createExtraField()],
    }))
  }

  return (
    <div className="admin-section">
      <section className="page-heading">
        <span className="eyebrow">Katalógus</span>
        <h3>Termékek és újrahasználható ételmódosítók</h3>
        <p className="muted">
          A termékek eseményhez kötve maradnak, így a későbbi események indulhatnak üresen vagy egy tiszta katalógus másolatával.
        </p>
      </section>

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
      {statusMessage ? <div className="status-inline">{statusMessage}</div> : null}

      <section className="panel catalog-summary-panel">
        <div className="catalog-summary-grid">
          <div className="catalog-summary-card">
            <span className="catalog-summary-label">Termékek</span>
            <strong>{products.length}</strong>
            <p className="helper-text">Először válassz, utána szerkessz. A kereső hosszú listák mellett is mindig látható marad.</p>
          </div>
          <div className="catalog-summary-card">
            <span className="catalog-summary-label">Módosítósablonok</span>
            <strong>{modifierTemplates.length}</strong>
            <p className="helper-text">A sablonok most strukturált összetevő- és extra sorokat használnak szabad szöveges formázás helyett.</p>
          </div>
          <div className="catalog-summary-card">
            <span className="catalog-summary-label">Ajánlott folyamat</span>
            <strong>Bal oldalon válassz vagy hozz létre, jobb oldalon szerkessz</strong>
            <p className="helper-text">A szerkesztő mindig a kiválasztott elem mellett marad, nem rejtve a lista alá.</p>
          </div>
        </div>
      </section>

      <div className="two-column-grid">
        <section className="panel catalog-panel">
          <div className="catalog-panel-header">
            <div>
              <h4 className="card-title">Termékkezelés</h4>
              <p className="helper-text">
                Először keress rá vagy válassz ki egy meglévő terméket, majd szerkeszd a környezet elvesztése nélkül.
              </p>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setProductState(emptyProductState)}
              disabled={pending}
            >
              Új termék
            </button>
          </div>

          <div className="catalog-workbench">
            <div className="catalog-list-card">
              <div className="split-header">
                <div>
                  <p className="catalog-editor-kicker">Kiválasztás</p>
                  <h5 className="catalog-editor-title">Termékek</h5>
                </div>
                <span className="catalog-state-badge">{filteredProducts.length} látható</span>
              </div>

              <div className="field">
                <label htmlFor="productSearch">Termékek keresése</label>
                <input
                  id="productSearch"
                  type="search"
                  value={productQuery}
                  onChange={(event) => setProductQuery(event.target.value)}
                  placeholder="Keresés termék, kategória vagy kapcsolt sablon alapján"
                />
              </div>

              <div className="record-list stacked catalog-record-list">
                {filteredProducts.length ? (
                  filteredProducts.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      className={`record-row${productState.productId === product.id ? ' selected' : ''}`}
                      onClick={() => loadProductIntoForm(product)}
                    >
                      <span>
                        <strong>{product.name}</strong>
                        <small>
                          {product.category} | {formatHuf(product.price)}
                        </small>
                      </span>
                      <span className="catalog-record-meta">
                        {product.modifierTemplateId ? (
                          <small>{templateLookup[product.modifierTemplateId]?.name || 'Kapcsolt sablon'}</small>
                        ) : null}
                        {getAvailabilityState(product) === PRODUCT_AVAILABILITY.unavailable
                          ? 'Nem elérhető'
                          : getAvailabilityState(product) === PRODUCT_AVAILABILITY.active
                            ? 'Aktív'
                            : 'Inaktív'}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="catalog-empty-state">
                    <strong>Nincs a keresésnek megfelelő termék.</strong>
                    <p className="helper-text">Próbálj tágabb keresést, vagy hozz létre új terméket.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="catalog-editor-card">
              <div className="split-header">
                <div>
                  <p className="catalog-editor-kicker">Szerkesztő</p>
                  <h5 className="catalog-editor-title">
                    {productState.productId ? `${productState.name || 'termék'} szerkesztése` : 'Új termék létrehozása'}
                  </h5>
                </div>
                <span className={`catalog-state-badge ${productState.productId ? 'is-editing' : ''}`}>
                  {productState.productId ? 'Szerkesztés' : 'Új'}
                </span>
              </div>

              <div className="catalog-preview-strip">
                <div className="catalog-preview-tile">
                  <span className="catalog-preview-label">Ár előnézet</span>
                  <strong>{productState.price ? formatHuf(Number(productState.price) || 0) : 'Adj meg árat'}</strong>
                </div>
                <div className="catalog-preview-tile">
                  <span className="catalog-preview-label">Elérhetőség</span>
                  <strong>
                    {availabilityState === PRODUCT_AVAILABILITY.unavailable
                      ? 'Ideiglenesen nem elérhető'
                      : availabilityState === PRODUCT_AVAILABILITY.inactive
                        ? 'Inaktív'
                        : 'Aktív'}
                  </strong>
                </div>
                <div className="catalog-preview-tile">
                  <span className="catalog-preview-label">Módosító beállítás</span>
                  <strong>{templateLookup[productState.modifierTemplateId]?.name || 'Nincs kapcsolt sablon'}</strong>
                </div>
              </div>

              <form className="form-grid" onSubmit={handleProductSubmit}>
                <div className="field">
                  <label htmlFor="productName">Név</label>
                  <input
                    id="productName"
                    value={productState.name}
                    onChange={(event) => setProductState((current) => ({ ...current, name: event.target.value }))}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="productCategory">Kategória</label>
                  <select
                    id="productCategory"
                    value={productState.category}
                    onChange={(event) => setProductState((current) => ({ ...current, category: event.target.value }))}
                  >
                    {PRODUCT_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="productPrice">Ár (egész HUF)</label>
                  <input
                    id="productPrice"
                    value={productState.price}
                    onChange={(event) => setProductState((current) => ({ ...current, price: event.target.value }))}
                    placeholder="1200"
                    required
                  />
                  <span className="helper-text">Csak egész forint összeget használj.</span>
                </div>
                <div className="field">
                  <label htmlFor="productModifier">Módosítósablon</label>
                  <select
                    id="productModifier"
                    value={productState.modifierTemplateId}
                    onChange={(event) =>
                      setProductState((current) => ({ ...current, modifierTemplateId: event.target.value }))
                    }
                  >
                    <option value="">Nincs</option>
                    {sortedTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                  <span className="helper-text">
                    {sortedTemplates.length
                      ? 'Válassz sablont, ha a staff módosíthat összetevőket vagy fizetős extrákat.'
                      : 'Még nincs sablon. Először hozz létre egyet a sablonpanelen.'}
                  </span>
                </div>
                <div className="field">
                  <label>Elérhetőség</label>
                  <div className="availability-toggle">
                    <button
                      type="button"
                      className={`availability-option${availabilityState === PRODUCT_AVAILABILITY.active ? ' active' : ''}`}
                      onClick={() =>
                        setProductState((current) => ({
                          ...current,
                          ...buildAvailabilityPatch(PRODUCT_AVAILABILITY.active),
                        }))
                      }
                    >
                      Aktív
                    </button>
                    <button
                      type="button"
                      className={`availability-option${availabilityState === PRODUCT_AVAILABILITY.unavailable ? ' active' : ''}`}
                      onClick={() =>
                        setProductState((current) => ({
                          ...current,
                          ...buildAvailabilityPatch(PRODUCT_AVAILABILITY.unavailable),
                        }))
                      }
                    >
                      Ideiglenesen nem elérhető
                    </button>
                    <button
                      type="button"
                      className={`availability-option${availabilityState === PRODUCT_AVAILABILITY.inactive ? ' active' : ''}`}
                      onClick={() =>
                        setProductState((current) => ({
                          ...current,
                          ...buildAvailabilityPatch(PRODUCT_AVAILABILITY.inactive),
                        }))
                      }
                    >
                      Inaktív
                    </button>
                  </div>
                </div>
                <div className="button-row">
                  <button type="submit" className="primary-button" disabled={pending}>
                    {productState.productId ? 'Termék frissítése' : 'Termék mentése'}
                  </button>
                  {productState.productId ? (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setProductState(emptyProductState)}
                      disabled={pending}
                    >
                      Szerkesztés megszakítása
                    </button>
                  ) : null}
                </div>
              </form>
            </div>
          </div>
        </section>

        <section className="panel catalog-panel">
          <div className="catalog-panel-header">
            <div>
              <h4 className="card-title">Módosítósablonok</h4>
              <p className="helper-text">
                Válassz sablont a listából, majd szerkeszd az összetevőket és extrákat külön mezőkkel, nyers szöveg helyett.
              </p>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setTemplateState(emptyTemplateState)}
              disabled={pending}
            >
              Új sablon
            </button>
          </div>

          <div className="catalog-workbench">
            <div className="catalog-list-card">
              <div className="split-header">
                <div>
                  <p className="catalog-editor-kicker">Kiválasztás</p>
                  <h5 className="catalog-editor-title">Módosítósablonok</h5>
                </div>
                <span className="catalog-state-badge">{filteredTemplates.length} látható</span>
              </div>

              <div className="field">
                <label htmlFor="templateSearch">Sablonok keresése</label>
                <input
                  id="templateSearch"
                  type="search"
                  value={templateQuery}
                  onChange={(event) => setTemplateQuery(event.target.value)}
                  placeholder="Keresés sablon, összetevő vagy extra alapján"
                />
              </div>

              <div className="record-list stacked catalog-record-list">
                {filteredTemplates.length ? (
                  filteredTemplates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className={`record-row${templateState.templateId === template.id ? ' selected' : ''}`}
                      onClick={() => loadTemplateIntoForm(template)}
                    >
                      <span>
                        <strong>{template.name}</strong>
                        <small>
                          {(template.defaultIncludedIngredients || []).length} alapértelmezett | {(template.optionalExtras || []).length} extra
                        </small>
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="catalog-empty-state">
                    <strong>Nincs a keresésnek megfelelő sablon.</strong>
                    <p className="helper-text">Próbálj tágabb keresést, vagy hozz létre új sablont.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="catalog-editor-stack">
              <div className="catalog-editor-card">
                <div className="split-header">
                  <div>
                    <p className="catalog-editor-kicker">Sablonszerkesztő</p>
                    <h5 className="catalog-editor-title">
                      {templateState.templateId ? `${templateState.name || 'sablon'} szerkesztése` : 'Módosítósablon létrehozása'}
                    </h5>
                  </div>
                  <span className={`catalog-state-badge ${templateState.templateId ? 'is-editing' : ''}`}>
                    {templateState.templateId ? 'Szerkesztés' : 'Új'}
                  </span>
                </div>

                <form className="form-grid" onSubmit={handleTemplateSubmit}>
                  <div className="field">
                    <label htmlFor="templateName">Sablon neve</label>
                    <input
                      id="templateName"
                      value={templateState.name}
                      onChange={(event) => setTemplateState((current) => ({ ...current, name: event.target.value }))}
                      required
                    />
                  </div>

                  <div className="catalog-structured-section">
                    <div className="split-header">
                      <div>
                        <span className="catalog-preview-label">Alapértelmezett összetevők</span>
                        <p className="helper-text">Minden sor egy eltávolítható alap összetevő lesz a POS folyamatban.</p>
                      </div>
                      <button type="button" className="secondary-button" onClick={addIngredientField}>
                        Összetevő hozzáadása
                      </button>
                    </div>

                    <div className="catalog-field-list">
                      {templateState.defaultIncludedIngredients.map((field, index) => (
                        <div key={field.id} className="catalog-builder-row">
                          <span className="catalog-builder-index">{index + 1}</span>
                          <input
                            value={field.label}
                            onChange={(event) => updateIngredientField(field.id, event.target.value)}
                            placeholder="Paradicsom"
                          />
                          <button
                            type="button"
                            className="icon-button"
                            onClick={() => removeIngredientField(field.id)}
                            aria-label={`${index + 1}. összetevő eltávolítása`}
                          >
                            -
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="catalog-structured-section">
                    <div className="split-header">
                      <div>
                        <span className="catalog-preview-label">Választható extrák</span>
                        <p className="helper-text">Add meg az elnevezést, a felárat és a maximális mennyiséget minden extrához.</p>
                      </div>
                      <button type="button" className="secondary-button" onClick={addExtraField}>
                        Extra hozzáadása
                      </button>
                    </div>

                    <div className="catalog-field-list">
                      {templateState.optionalExtras.map((field, index) => (
                        <div key={field.id} className="catalog-builder-row catalog-builder-row-extra">
                          <span className="catalog-builder-index">{index + 1}</span>
                          <input
                            value={field.label}
                            onChange={(event) => updateExtraField(field.id, 'label', event.target.value)}
                            placeholder="Extra hús"
                          />
                          <input
                            value={field.price}
                            onChange={(event) => updateExtraField(field.id, 'price', event.target.value)}
                            inputMode="numeric"
                            placeholder="600"
                          />
                          <input
                            value={field.maxQuantity}
                            onChange={(event) => updateExtraField(field.id, 'maxQuantity', event.target.value)}
                            inputMode="numeric"
                            placeholder="1"
                          />
                          <button
                            type="button"
                            className="icon-button"
                            onClick={() => removeExtraField(field.id)}
                            aria-label={`${index + 1}. extra eltávolítása`}
                          >
                            -
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="button-row">
                    <button type="submit" className="primary-button" disabled={pending}>
                      {templateState.templateId ? 'Sablon frissítése' : 'Sablon mentése'}
                    </button>
                    {templateState.templateId ? (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => setTemplateState(emptyTemplateState)}
                        disabled={pending}
                      >
                        Szerkesztés megszakítása
                      </button>
                    ) : null}
                  </div>
                </form>
              </div>

              <div className="catalog-list-card">
                <div className="split-header">
                  <div>
                    <p className="catalog-editor-kicker">Élő előnézet</p>
                    <h5 className="catalog-editor-title">Amit a staff látni fog</h5>
                  </div>
                  <span className="catalog-state-badge">
                    {sanitizedIngredientsPreview.length} alapértelmezett | {sanitizedExtrasPreview.length} extra
                  </span>
                </div>

                <div className="catalog-preview-shell">
                  <div className="catalog-preview-block">
                    <span className="catalog-preview-label">Alapból benne van</span>
                    <div className="pill-row">
                      {sanitizedIngredientsPreview.length ? (
                        sanitizedIngredientsPreview.map((label) => (
                          <span key={label} className="event-pill">
                            {label}
                          </span>
                        ))
                      ) : (
                        <span className="catalog-empty-inline">Még nincs alapértelmezett összetevő.</span>
                      )}
                    </div>
                  </div>

                  <div className="catalog-preview-block">
                    <span className="catalog-preview-label">Választható extrák</span>
                    <div className="catalog-extra-preview-list">
                      {sanitizedExtrasPreview.length ? (
                        sanitizedExtrasPreview.map((item) => (
                          <div key={`${item.label}-${item.price}-${item.maxQuantity}`} className="catalog-extra-preview-row">
                            <strong>{item.label}</strong>
                            <span>{formatHuf(item.price)} | max. {item.maxQuantity}</span>
                          </div>
                        ))
                      ) : (
                        <span className="catalog-empty-inline">Még nincs fizetős extra.</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
