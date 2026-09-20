import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { read, utils, writeFile } from 'xlsx'
import { formatHuf, parseHufInteger } from '../../lib/money'
import { PRODUCT_CATEGORIES, normalizeProductCategory } from '../products/productModels'
import { clearProducts, deleteProduct, importProducts, saveProduct, subscribeToProducts } from '../products/productService'
import { normalizeProductBarcode, parseBarcodeList } from '../products/productBarcodes'
import { deleteModifierTemplate, saveModifierTemplate, subscribeToModifierTemplates } from '../modifiers/modifierTemplateService'
import { applyManualStockMovement, importStockItems, saveStockItem, subscribeToStockItems, subscribeToStockMovements } from '../stock/stockService'
import { parseStockInteger, STOCK_MOVEMENT_TYPES, STOCK_UNIT_LABELS, STOCK_UNITS } from '../stock/stockModels'

const emptyProductState = {
  productId: null,
  name: '',
  category: PRODUCT_CATEGORIES[0],
  price: '',
  isActive: true,
  isTemporarilyUnavailable: false,
  modifierTemplateId: '',
  isDRS: false,
  barcodes: [],
  stockMode: 'none',
  selfStockUnit: STOCK_UNITS.piece,
  selfStockQuantity: '0',
  selfStockLowThreshold: '0',
  stockRecipe: {
    enabled: false,
    components: [],
    choiceGroups: [],
  },
}

const emptyStockItemState = {
  stockItemId: null,
  name: '',
  unit: STOCK_UNITS.piece,
  currentQuantity: '0',
  lowThreshold: '0',
  isActive: true,
}

const emptyStockMovementState = {
  stockItemId: '',
  amount: '',
  countedQuantity: '',
  reason: '',
}

const PRODUCT_AVAILABILITY = {
  active: 'active',
  unavailable: 'unavailable',
  inactive: 'inactive',
}

const CATEGORY_COLOR_MAP = {
  'Sör':       { key: 'sor',        color: '#d97706' },
  'Bor':       { key: 'bor',        color: '#7c3aed' },
  'Hosszúital':{ key: 'hosszuital', color: '#ea580c' },
  'Üditő':     { key: 'udito',      color: '#059669' },
  'Nasi':      { key: 'nasi',       color: '#db2777' },
  'Kaja':      { key: 'kaja',       color: '#dc2626' },
}

const DEFAULT_CATEGORY = { key: 'default', color: '#9ca3af' }
const BARCODE_SCANNER_MIN_LENGTH = 8
const BARCODE_SCANNER_MAX_GAP_MS = 120
const BARCODE_SCANNER_FLUSH_MS = 220

const PRODUCT_IMPORT_HEADERS = ['name', 'drs', 'price', 'category']
const PRODUCT_IMPORT_HEADER_ALIASES = {
  name: 'name',
  productname: 'name',
  drs: 'drs',
  isdrs: 'drs',
  price: 'price',
  ar: 'price',
  category: 'category',
  kategoria: 'category',
  barcode: 'barcodes',
  barcodes: 'barcodes',
  vonalkod: 'barcodes',
  vonalkodok: 'barcodes',
  stockmode: 'stockMode',
  keszletmod: 'stockMode',
  keszletkovetes: 'stockMode',
  stockquantity: 'stockQuantity',
  keszletmennyiseg: 'stockQuantity',
  stocklowthreshold: 'stockLowThreshold',
  lowthreshold: 'stockLowThreshold',
  alacsonyjelzes: 'stockLowThreshold',
  stockunit: 'stockUnit',
  keszletegyseg: 'stockUnit',
  stockrecipe: 'stockRecipe',
  recept: 'stockRecipe',
  stockchoicegroups: 'stockChoiceGroups',
  valasztasok: 'stockChoiceGroups',
}

const STOCK_IMPORT_REQUIRED_HEADERS = ['name', 'unit', 'currentQuantity']
const STOCK_IMPORT_HEADER_ALIASES = {
  name: 'name',
  nev: 'name',
  unit: 'unit',
  egyseg: 'unit',
  currentquantity: 'currentQuantity',
  currentstock: 'currentQuantity',
  quantity: 'currentQuantity',
  jelenlegimennyiseg: 'currentQuantity',
  keszlet: 'currentQuantity',
  lowthreshold: 'lowThreshold',
  low: 'lowThreshold',
  alacsonyjelzes: 'lowThreshold',
  minimum: 'lowThreshold',
  active: 'active',
  aktiv: 'active',
  isactive: 'active',
}

const STOCK_EDITOR_MODES = {
  none: 'none',
  self: 'self',
  recipe: 'recipe',
  choice: 'choice',
}

const LONG_DRINK_RECIPE_PRESETS = [
  { label: 'Vodka-szóda', spirit: 'Vodka', mixer: 'Szóda' },
  { label: 'Vodka-hell', spirit: 'Vodka', mixer: 'Hell' },
  { label: 'Vodka-üdítő', spirit: 'Vodka', mixer: 'Üdítő' },
  { label: 'Gin-tonic', spirit: 'Gin', mixer: 'Tonic' },
  { label: 'Gin-fizz', spirit: 'Gin', mixer: 'Szóda' },
  { label: 'Rum-kóla', spirit: 'Rum', mixer: 'Kóla' },
  { label: 'Whiskey-hell', spirit: 'Whiskey', mixer: 'Hell' },
  { label: 'Jager-hell', spirit: 'Jager', mixer: 'Hell' },
]

function parseImportStockMode(value) {
  const normalized = normalizeImportHeader(value)
  if (!normalized || normalized === 'none' || normalized === 'nincs' || normalized === 'no') {
    return 'none'
  }
  if (['self', 'sajat', 'sajatkeszlet', 'product', 'termek'].includes(normalized)) {
    return 'self'
  }
  if (['recipe', 'recept', 'ingredients', 'hozzavalok'].includes(normalized)) {
    return 'recipe'
  }
  if (['choice', 'valasztas', 'valasztassal', 'valasztasok'].includes(normalized)) {
    return 'choice'
  }
  return null
}

function parseImportStockUnit(value, fallback = STOCK_UNITS.piece) {
  const normalized = normalizeImportHeader(value)
  if (!normalized) return fallback
  if (['ml', 'milliliter'].includes(normalized)) return STOCK_UNITS.ml
  if (['db', 'piece', 'pieces', 'darab'].includes(normalized)) return STOCK_UNITS.piece
  return null
}

function parseImportStockQuantity(value, fallback = 0) {
  if (String(value ?? '').trim() === '') return fallback
  const normalized = String(value ?? '').replace(/\s+/g, '')
  return /^-?\d+$/.test(normalized) ? Number.parseInt(normalized, 10) : null
}

function parseImportRecipeComponent(rawValue, fallbackUnit = STOCK_UNITS.ml) {
  const text = String(rawValue || '').trim()
  const separatorIndex = text.lastIndexOf(':')
  if (separatorIndex <= 0) {
    return null
  }

  const stockItemName = text.slice(0, separatorIndex).trim()
  const quantityText = text.slice(separatorIndex + 1).trim()
  const quantityMatch = quantityText.match(/^(\d+)\s*([a-zA-ZáéíóöőúüűÁÉÍÓÖŐÚÜŰ]*)$/)
  if (!stockItemName || !quantityMatch) {
    return null
  }

  const unit = parseImportStockUnit(quantityMatch[2], fallbackUnit)
  if (!unit) {
    return null
  }

  return {
    stockItemName,
    quantityPerUnit: parseStockInteger(quantityMatch[1], 0),
    unit,
  }
}

function parseImportRecipeList(value) {
  return String(value || '')
    .split(';')
    .map((part) => parseImportRecipeComponent(part))
    .filter((component) => component && component.quantityPerUnit > 0)
}

function parseImportChoiceGroups(value) {
  return String(value || '')
    .split(';')
    .map((groupText) => {
      const [labelPart, optionsPart] = groupText.split('=')
      const label = String(labelPart || '').trim()
      const options = String(optionsPart || '')
        .split('|')
        .map((optionText) => {
          const component = parseImportRecipeComponent(optionText)
          if (!component) return null
          return {
            label: component.stockItemName,
            components: [component],
          }
        })
        .filter(Boolean)

      if (!label || !options.length) {
        return null
      }

      return { label, options }
    })
    .filter(Boolean)
}

function normalizeNameForMatch(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function getStockItemById(stockItems, stockItemId) {
  return stockItems.find((item) => item.id === stockItemId) || null
}

function getStockItemByName(stockItems, name) {
  const normalizedName = normalizeNameForMatch(name)
  return stockItems.find((item) => normalizeNameForMatch(item.name) === normalizedName) || null
}

function isSelfStockRecipe(product, stockItems) {
  const recipe = product?.stockRecipe
  const components = recipe?.components || []
  const choiceGroups = recipe?.choiceGroups || []

  if (!recipe?.enabled || components.length !== 1 || choiceGroups.length > 0) {
    return false
  }

  const component = components[0]
  if (parseStockInteger(component.quantityPerUnit, 0) !== 1) {
    return false
  }

  const stockItem = getStockItemById(stockItems, component.stockItemId)
  const stockName = stockItem?.name || component.stockItemName
  return !stockName || normalizeNameForMatch(stockName) === normalizeNameForMatch(product.name)
}

function inferStockMode(product, stockItems) {
  const recipe = product?.stockRecipe
  if (!recipe?.enabled) {
    return STOCK_EDITOR_MODES.none
  }
  if (isSelfStockRecipe(product, stockItems)) {
    return STOCK_EDITOR_MODES.self
  }
  if ((recipe.choiceGroups || []).length > 0) {
    return STOCK_EDITOR_MODES.choice
  }
  return STOCK_EDITOR_MODES.recipe
}

function formatRecipeComponentsForExport(components = [], stockItems = []) {
  return components
    .map((component) => {
      const stockItem = getStockItemById(stockItems, component.stockItemId)
      const unit = STOCK_UNIT_LABELS[stockItem?.unit] || stockItem?.unit || ''
      return `${component.stockItemName || stockItem?.name || ''}:${component.quantityPerUnit || 0}${unit}`
    })
    .join('; ')
}

function formatChoiceGroupsForExport(choiceGroups = [], stockItems = []) {
  return choiceGroups
    .map((group) => {
      const options = (group.options || [])
        .map((option) => {
          const component = option.components?.[0]
          if (!component) return null
          const stockItem = getStockItemById(stockItems, component.stockItemId)
          const unit = STOCK_UNIT_LABELS[stockItem?.unit] || stockItem?.unit || ''
          return `${option.label || component.stockItemName}:${component.quantityPerUnit || 0}${unit}`
        })
        .filter(Boolean)
        .join('|')
      return options ? `${group.label || 'Választás'}=${options}` : null
    })
    .filter(Boolean)
    .join('; ')
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

function createRecipeComponent() {
  return {
    id: crypto.randomUUID(),
    stockItemId: '',
    stockItemName: '',
    quantityPerUnit: '',
  }
}

function createRecipeOption() {
  return {
    id: crypto.randomUUID(),
    label: '',
    components: [createRecipeComponent()],
  }
}

function createRecipeChoiceGroup() {
  return {
    id: crypto.randomUUID(),
    label: '',
    options: [createRecipeOption()],
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

function normalizeImportHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
}

function parseImportBoolean(value) {
  if (typeof value === 'boolean') {
    return value
  }

  const normalized = String(value ?? '').trim().toLowerCase()

  if (['true', '1', 'yes', 'y', 'igen'].includes(normalized)) {
    return true
  }

  if (['false', '0', 'no', 'n', 'nem', ''].includes(normalized)) {
    return false
  }

  return null
}

async function parseImportedProducts(file) {
  const buffer = await file.arrayBuffer()
  const workbook = read(buffer, { type: 'array' })
  const firstSheetName = workbook.SheetNames[0]

  if (!firstSheetName) {
    throw new Error('The selected Excel file does not contain any sheets.')
  }

  const sheet = workbook.Sheets[firstSheetName]
  const rows = utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  })

  if (!rows.length) {
    throw new Error('The selected Excel sheet is empty.')
  }

  const headerRow = rows[0]
  const headerMap = {}

  headerRow.forEach((cell, index) => {
    const normalizedHeader = PRODUCT_IMPORT_HEADER_ALIASES[normalizeImportHeader(cell)]
    if (normalizedHeader && headerMap[normalizedHeader] === undefined) {
      headerMap[normalizedHeader] = index
    }
  })

  const missingHeaders = PRODUCT_IMPORT_HEADERS.filter((header) => headerMap[header] === undefined)
  if (missingHeaders.length) {
    throw new Error(`Missing required columns: ${missingHeaders.join(', ')}.`)
  }

  const errors = []
  const importedProducts = []

  rows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2
    const name = String(row[headerMap.name] ?? '').trim()
    const category = normalizeProductCategory(row[headerMap.category])
    const price = parseHufInteger(row[headerMap.price])
    const isDRS = parseImportBoolean(row[headerMap.drs])
    const barcodes = headerMap.barcodes === undefined
      ? []
      : parseBarcodeList(row[headerMap.barcodes])
    const stockMode = headerMap.stockMode === undefined
      ? 'none'
      : parseImportStockMode(row[headerMap.stockMode])
    const stockUnit = headerMap.stockUnit === undefined
      ? STOCK_UNITS.piece
      : parseImportStockUnit(row[headerMap.stockUnit], STOCK_UNITS.piece)
    const stockQuantity = headerMap.stockQuantity === undefined
      ? 0
      : parseImportStockQuantity(row[headerMap.stockQuantity], 0)
    const stockLowThreshold = headerMap.stockLowThreshold === undefined
      ? 0
      : parseImportStockQuantity(row[headerMap.stockLowThreshold], 0)
    const stockRecipeComponents = headerMap.stockRecipe === undefined
      ? []
      : parseImportRecipeList(row[headerMap.stockRecipe])
    const stockChoiceGroups = headerMap.stockChoiceGroups === undefined
      ? []
      : parseImportChoiceGroups(row[headerMap.stockChoiceGroups])
    const rowValues = [
      row[headerMap.name],
      row[headerMap.drs],
      row[headerMap.price],
      row[headerMap.category],
      row[headerMap.stockMode],
      row[headerMap.stockQuantity],
      row[headerMap.stockLowThreshold],
      row[headerMap.stockUnit],
      row[headerMap.stockRecipe],
      row[headerMap.stockChoiceGroups],
    ]
    const isBlankRow = rowValues.every((value) => String(value ?? '').trim() === '')

    if (isBlankRow) {
      return
    }

    const rowErrors = []

    if (!name) {
      rowErrors.push('name is required')
    }

    if (!PRODUCT_CATEGORIES.includes(category)) {
      rowErrors.push(`category must be one of ${PRODUCT_CATEGORIES.join(', ')}`)
    }

    if (!Number.isInteger(price) || price < 0) {
      rowErrors.push('price must be a non-negative whole number')
    }

    if (isDRS === null) {
      rowErrors.push('drs must be true or false')
    }

    if (!stockMode) {
      rowErrors.push('stock_mode must be none, self, recipe, or choice')
    }

    if (!stockUnit) {
      rowErrors.push('stock_unit must be db or ml')
    }

    if (stockQuantity === null) {
      rowErrors.push('stock_quantity must be a whole number')
    }

    if (stockLowThreshold === null) {
      rowErrors.push('stock_low_threshold must be a whole number')
    }

    if (stockMode === 'self' && stockQuantity < 0) {
      rowErrors.push('stock_quantity must be zero or positive')
    }

    if (stockLowThreshold < 0) {
      rowErrors.push('stock_low_threshold must be zero or positive')
    }

    if ((stockMode === 'recipe' || stockMode === 'choice') && headerMap.stockRecipe !== undefined && String(row[headerMap.stockRecipe] || '').trim() && !stockRecipeComponents.length) {
      rowErrors.push('stock_recipe must use "Stock item:40ml; Other item:250ml" format')
    }

    if (stockMode === 'choice' && headerMap.stockChoiceGroups !== undefined && String(row[headerMap.stockChoiceGroups] || '').trim() && !stockChoiceGroups.length) {
      rowErrors.push('stock_choice_groups must use "Question=Option:100ml|Other:100ml" format')
    }

    if (stockMode === 'choice' && !stockChoiceGroups.length) {
      rowErrors.push('choice stock_mode requires stock_choice_groups')
    }

    try {
      barcodes.forEach((barcode) => normalizeProductBarcode(barcode))
    } catch (error) {
      rowErrors.push(error.message)
    }

    if (rowErrors.length) {
      errors.push(`Row ${rowNumber}: ${rowErrors.join('; ')}.`)
      return
    }

    importedProducts.push({
      name,
      category,
      price,
      isDRS,
      barcodes,
      stockImport: stockMode === 'none'
        ? null
        : {
            mode: stockMode,
            unit: stockUnit,
            quantity: stockQuantity,
            lowThreshold: stockLowThreshold,
            components: stockRecipeComponents,
            choiceGroups: stockChoiceGroups,
          },
    })
  })

  if (!importedProducts.length && !errors.length) {
    throw new Error('The selected Excel sheet does not contain any product rows.')
  }

  if (errors.length) {
    throw new Error(errors.slice(0, 8).join(' '))
  }

  return importedProducts
}

async function parseImportedStockItems(file) {
  const buffer = await file.arrayBuffer()
  const workbook = read(buffer, { type: 'array' })
  const firstSheetName = workbook.SheetNames[0]

  if (!firstSheetName) {
    throw new Error('A kiválasztott Excel fájlban nincs munkalap.')
  }

  const rows = utils.sheet_to_json(workbook.Sheets[firstSheetName], {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  })

  if (!rows.length) {
    throw new Error('A kiválasztott Excel munkalap üres.')
  }

  const headerMap = {}
  rows[0].forEach((cell, index) => {
    const normalizedHeader = STOCK_IMPORT_HEADER_ALIASES[normalizeImportHeader(cell)]
    if (normalizedHeader && headerMap[normalizedHeader] === undefined) {
      headerMap[normalizedHeader] = index
    }
  })

  const missingHeaders = STOCK_IMPORT_REQUIRED_HEADERS.filter((header) => headerMap[header] === undefined)
  if (missingHeaders.length) {
    throw new Error(`Hiányzó kötelező oszlopok: ${missingHeaders.join(', ')}.`)
  }

  const errors = []
  const importedStockItems = []
  const seenStockNames = new Map()

  rows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2
    const name = String(row[headerMap.name] ?? '').trim()
    const normalizedName = normalizeNameForMatch(name)
    const unit = parseImportStockUnit(row[headerMap.unit])
    const currentQuantity = parseImportStockQuantity(row[headerMap.currentQuantity], 0)
    const lowThreshold = headerMap.lowThreshold === undefined
      ? 0
      : parseImportStockQuantity(row[headerMap.lowThreshold], 0)
    const isActive = headerMap.active === undefined
      ? true
      : parseImportBoolean(row[headerMap.active])
    const rowValues = [
      row[headerMap.name],
      row[headerMap.unit],
      row[headerMap.currentQuantity],
      row[headerMap.lowThreshold],
      row[headerMap.active],
    ]

    if (rowValues.every((value) => String(value ?? '').trim() === '')) {
      return
    }

    const rowErrors = []
    if (!name) rowErrors.push('name kötelező')
    if (normalizedName && seenStockNames.has(normalizedName)) {
      rowErrors.push(`duplikált készletnév, előző sor: ${seenStockNames.get(normalizedName)}`)
    }
    if (!unit) rowErrors.push('unit csak db vagy ml lehet')
    if (currentQuantity === null) rowErrors.push('current_quantity egész szám legyen')
    if (lowThreshold === null) rowErrors.push('low_threshold egész szám legyen')
    if (lowThreshold < 0) rowErrors.push('low_threshold nem lehet negatív')
    if (isActive === null) rowErrors.push('active true vagy false legyen')

    if (rowErrors.length) {
      errors.push(`Sor ${rowNumber}: ${rowErrors.join('; ')}.`)
      return
    }

    importedStockItems.push({
      name,
      unit,
      currentQuantity,
      lowThreshold,
      isActive,
    })
    seenStockNames.set(normalizedName, rowNumber)
  })

  if (!importedStockItems.length && !errors.length) {
    throw new Error('A kiválasztott Excel munkalapon nincs készletsor.')
  }

  if (errors.length) {
    throw new Error(errors.slice(0, 8).join(' '))
  }

  return importedStockItems
}

function productMatchesQuery(product, query, templateName) {
  if (!query) {
    return true
  }

  return [product.name, normalizeProductCategory(product.category), templateName, ...(product.barcodes || [])]
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
  const [stockItems, setStockItems] = useState([])
  const [stockMovements, setStockMovements] = useState([])
  const [productState, setProductState] = useState(emptyProductState)
  const [templateState, setTemplateState] = useState(emptyTemplateState)
  const [stockItemState, setStockItemState] = useState(emptyStockItemState)
  const [stockMovementState, setStockMovementState] = useState(emptyStockMovementState)
  const [productQuery, setProductQuery] = useState('')
  const [templateQuery, setTemplateQuery] = useState('')
  const [activeCatalogSection, setActiveCatalogSection] = useState('products')
  const [statusMessage, setStatusMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [importFileName, setImportFileName] = useState('')
  const [stockImportFileName, setStockImportFileName] = useState('')
  const [barcodeInput, setBarcodeInput] = useState('')
  const importInputRef = useRef(null)
  const stockImportInputRef = useRef(null)
  const barcodeScannerTimerRef = useRef(null)
  const barcodeScannerBufferRef = useRef('')
  const barcodeScannerLastKeyAtRef = useRef(0)
  const barcodeScannerTargetRef = useRef(null)
  const hiddenBarcodeScannerInputRef = useRef(null)

  const availabilityState = useMemo(() => getAvailabilityState(productState), [productState])

  const addProductBarcode = useCallback((rawValue) => {
    setErrorMessage('')

    let barcode = ''
    try {
      barcode = normalizeProductBarcode(rawValue)
    } catch (error) {
      setErrorMessage(error.message)
      return false
    }

    if ((productState.barcodes || []).includes(barcode)) {
      setErrorMessage(`A(z) ${barcode} vonalkod mar ezen a termeken van.`)
      return false
    }

    const owner = products.find((product) =>
      product.id !== productState.productId && (product.barcodes || []).includes(barcode),
    )
    if (owner) {
      setErrorMessage(`A(z) ${barcode} vonalkod mar a(z) "${owner.name}" termekhez tartozik.`)
      return false
    }

    setProductState((current) => ({
      ...current,
      barcodes: [...(current.barcodes || []), barcode],
    }))
    setBarcodeInput('')
    setStatusMessage(`Vonalkod hozzaadva: ${barcode}`)
    return true
  }, [productState.barcodes, productState.productId, products])

  useEffect(() => {
    return subscribeToProducts(eventId, setProducts, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    return subscribeToModifierTemplates(eventId, setModifierTemplates, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    return subscribeToStockItems(eventId, setStockItems, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    if (activeCatalogSection !== 'stock') {
      setStockMovements([])
      return () => {}
    }

    return subscribeToStockMovements(eventId, setStockMovements, (error) => setErrorMessage(error.message))
  }, [activeCatalogSection, eventId])

  const restoreScannerTarget = useCallback(() => {
    const target = barcodeScannerTargetRef.current
    barcodeScannerTargetRef.current = null
    if (!target) return

    if (target.id === 'productName') {
      setProductState((current) => ({ ...current, name: target.initialValue }))
      return
    }

    if (target.id === 'productPrice') {
      setProductState((current) => ({ ...current, price: target.initialValue }))
      return
    }

    if (target.id === 'productBarcode') {
      setBarcodeInput(target.initialValue)
      return
    }

    if (target.id === 'productSearch') {
      setProductQuery(target.initialValue)
      return
    }

    if (target.id === 'templateSearch') {
      setTemplateQuery(target.initialValue)
    }
  }, [])

  const clearBarcodeScannerTimer = useCallback(() => {
    if (barcodeScannerTimerRef.current) {
      window.clearTimeout(barcodeScannerTimerRef.current)
      barcodeScannerTimerRef.current = null
    }
  }, [])

  const focusHiddenBarcodeScannerInput = useCallback((force = false) => {
    if (activeCatalogSection !== 'products' || pending) {
      return
    }

    const activeElement = document.activeElement
    const hiddenInput = hiddenBarcodeScannerInputRef.current
    const tagName = activeElement?.tagName?.toLowerCase()
    const activeElementIsTextEntry = tagName === 'input'
      || tagName === 'textarea'
      || tagName === 'select'
      || activeElement?.isContentEditable

    if (!hiddenInput || activeElement === hiddenInput || (!force && activeElementIsTextEntry)) {
      return
    }

    hiddenInput.focus({ preventScroll: true })
  }, [activeCatalogSection, pending])

  const flushBarcodeScannerBuffer = useCallback(() => {
    clearBarcodeScannerTimer()
    const value = barcodeScannerBufferRef.current
    barcodeScannerBufferRef.current = ''
    barcodeScannerLastKeyAtRef.current = 0
    if (hiddenBarcodeScannerInputRef.current) {
      hiddenBarcodeScannerInputRef.current.value = ''
    }

    if (value.length < BARCODE_SCANNER_MIN_LENGTH) {
      barcodeScannerTargetRef.current = null
      return false
    }

    const added = addProductBarcode(value)
    if (added) {
      restoreScannerTarget()
    } else {
      barcodeScannerTargetRef.current = null
    }

    return added
  }, [addProductBarcode, clearBarcodeScannerTimer, restoreScannerTarget])

  const scheduleBarcodeScannerFlush = useCallback(() => {
    clearBarcodeScannerTimer()
    barcodeScannerTimerRef.current = window.setTimeout(flushBarcodeScannerBuffer, BARCODE_SCANNER_FLUSH_MS)
  }, [clearBarcodeScannerTimer, flushBarcodeScannerBuffer])

  useEffect(() => {
    function rememberScannerTarget() {
      const element = document.activeElement
      const tagName = element?.tagName?.toLowerCase()
      const isTextInput = tagName === 'input' || tagName === 'textarea'

      barcodeScannerTargetRef.current = isTextInput
        ? { id: element.id || '', initialValue: element.value || '' }
        : null
    }

    function resetScannerBuffer() {
      clearBarcodeScannerTimer()
      barcodeScannerBufferRef.current = ''
      barcodeScannerLastKeyAtRef.current = 0
      barcodeScannerTargetRef.current = null
    }

    function handleGlobalKeyDown(event) {
      if (event.ctrlKey || event.altKey || event.metaKey || activeCatalogSection !== 'products' || pending) {
        return
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        if (barcodeScannerBufferRef.current.length >= BARCODE_SCANNER_MIN_LENGTH) {
          event.preventDefault()
          flushBarcodeScannerBuffer()
        }
        return
      }

      if (event.key.length !== 1) {
        return
      }

      if (!/^\d$/.test(event.key)) {
        resetScannerBuffer()
        return
      }

      const now = Date.now()
      if (now - barcodeScannerLastKeyAtRef.current > BARCODE_SCANNER_MAX_GAP_MS) {
        barcodeScannerBufferRef.current = ''
        rememberScannerTarget()
      }

      barcodeScannerLastKeyAtRef.current = now
      barcodeScannerBufferRef.current += event.key

      if (barcodeScannerBufferRef.current.length >= 2) {
        event.preventDefault()
      }

      scheduleBarcodeScannerFlush()
    }

    window.addEventListener('keydown', handleGlobalKeyDown, true)

    return () => {
      clearBarcodeScannerTimer()
      window.removeEventListener('keydown', handleGlobalKeyDown, true)
    }
  }, [activeCatalogSection, clearBarcodeScannerTimer, flushBarcodeScannerBuffer, pending, scheduleBarcodeScannerFlush])

  useEffect(() => {
    const focusTimer = window.setTimeout(focusHiddenBarcodeScannerInput, 0)
    const scheduleScannerFocus = () => window.setTimeout(focusHiddenBarcodeScannerInput, 0)

    window.addEventListener('pointerup', scheduleScannerFocus)
    window.addEventListener('focus', scheduleScannerFocus)

    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('pointerup', scheduleScannerFocus)
      window.removeEventListener('focus', scheduleScannerFocus)
    }
  }, [focusHiddenBarcodeScannerInput])

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

    return products
      .filter((product) =>
        productMatchesQuery(product, query, templateLookup[product.modifierTemplateId || '']?.name || ''),
      )
      .sort((a, b) => {
        const catA = PRODUCT_CATEGORIES.indexOf(normalizeProductCategory(a.category))
        const catB = PRODUCT_CATEGORIES.indexOf(normalizeProductCategory(b.category))
        const catDiff = (catA === -1 ? 999 : catA) - (catB === -1 ? 999 : catB)
        if (catDiff !== 0) return catDiff
        return a.name.localeCompare(b.name, 'hu')
      })
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

  function resetProductForm() {
    clearBarcodeScannerTimer()
    setBarcodeInput('')
    setProductState(emptyProductState)
  }

  function handleHiddenBarcodeScannerInputBlur() {
    window.setTimeout(focusHiddenBarcodeScannerInput, 0)
  }

  function handleHiddenBarcodeScannerInputChange(event) {
    const nextValue = event.target.value
    barcodeScannerBufferRef.current = nextValue
    barcodeScannerLastKeyAtRef.current = Date.now()
    scheduleBarcodeScannerFlush()

    if (nextValue.length > 512) {
      event.target.value = nextValue.slice(-512)
      barcodeScannerBufferRef.current = event.target.value
    }
  }

  function handleHiddenBarcodeScannerInputKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== 'Tab') {
      return
    }

    if (barcodeScannerBufferRef.current.length >= BARCODE_SCANNER_MIN_LENGTH) {
      event.preventDefault()
      flushBarcodeScannerBuffer()
      event.currentTarget.value = ''
    }
  }

  async function handleProductSubmit(event) {
    event.preventDefault()
    const isEditing = Boolean(productState.productId)
    const stockMode = productState.stockMode || STOCK_EDITOR_MODES.none
    const stockRecipe = stockMode === STOCK_EDITOR_MODES.none || stockMode === STOCK_EDITOR_MODES.self
      ? {
          enabled: false,
          components: [],
          choiceGroups: [],
        }
      : {
          ...(productState.stockRecipe || emptyProductState.stockRecipe),
          enabled: true,
          choiceGroups: stockMode === STOCK_EDITOR_MODES.choice
            ? productState.stockRecipe?.choiceGroups || []
            : [],
        }
    const stockImport = stockMode === STOCK_EDITOR_MODES.self
      ? {
          mode: 'self',
          unit: productState.selfStockUnit || STOCK_UNITS.piece,
          quantity: productState.selfStockQuantity,
          lowThreshold: productState.selfStockLowThreshold,
        }
      : null

    await runAction(() =>
      saveProduct({
        eventId,
        actorUid,
        ...productState,
        stockRecipe,
        stockImport,
      }),
    )

    resetProductForm()
    setStatusMessage(isEditing ? 'A termék frissítve lett.' : 'A termék létrejött.')
  }

  async function handleDeleteProduct() {
    if (!productState.productId) return
    const confirmed = window.confirm(`Biztosan törlöd a(z) "${productState.name}" terméket?`)
    if (!confirmed) return

    await runAction(() =>
      deleteProduct({
        eventId,
        actorUid,
        productId: productState.productId,
        name: productState.name,
      }),
    )

    resetProductForm()
    setStatusMessage('A termék törölve lett.')
  }

  async function handleProductImport(event) {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    setImportFileName(file.name)

    await runAction(async () => {
      const importedProducts = await parseImportedProducts(file)
      await importProducts({
        eventId,
        actorUid,
        products: importedProducts,
      })

      setStatusMessage(`${importedProducts.length} termék importálva: ${file.name}`)
      setImportFileName('')

      if (importInputRef.current) {
        importInputRef.current.value = ''
      }
    })

    if (importInputRef.current) {
      importInputRef.current.value = ''
    }
  }

  function handleProductExport() {
    const rows = products
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name, 'hu'))
      .map((product) => {
        const stockMode = inferStockMode(product, stockItems)
        const recipe = product.stockRecipe || {}
        const selfComponent = recipe.components?.[0]
        const selfStockItem = stockMode === STOCK_EDITOR_MODES.self
          ? getStockItemById(stockItems, selfComponent?.stockItemId)
          : null

        return {
          name: product.name || '',
          drs: Boolean(product.isDRS),
          price: product.price ?? 0,
          category: normalizeProductCategory(product.category),
          barcodes: (product.barcodes || []).join(', '),
          stock_mode: stockMode,
          stock_quantity: stockMode === STOCK_EDITOR_MODES.self ? selfStockItem?.currentQuantity ?? 0 : '',
          stock_low_threshold: stockMode === STOCK_EDITOR_MODES.self ? selfStockItem?.lowThreshold ?? 0 : '',
          stock_unit: stockMode === STOCK_EDITOR_MODES.self ? STOCK_UNIT_LABELS[selfStockItem?.unit] || selfStockItem?.unit || 'db' : '',
          stock_recipe: stockMode === STOCK_EDITOR_MODES.recipe || stockMode === STOCK_EDITOR_MODES.choice
            ? formatRecipeComponentsForExport(recipe.components || [], stockItems)
            : '',
          stock_choice_groups: stockMode === STOCK_EDITOR_MODES.choice
            ? formatChoiceGroupsForExport(recipe.choiceGroups || [], stockItems)
            : '',
        }
      })
    const worksheet = utils.json_to_sheet(rows)
    const workbook = utils.book_new()
    utils.book_append_sheet(workbook, worksheet, 'products')
    writeFile(workbook, `products-${eventId}.xlsx`)
  }

  async function handleClearProducts() {
    if (!products.length) {
      setStatusMessage('Nincs mit törölni a katalógusból.')
      return
    }

    const confirmed = window.confirm(`Biztosan törlöd az összes terméket? (${products.length} db)`)

    if (!confirmed) {
      return
    }

    await runAction(async () => {
      const clearedCount = await clearProducts({
        eventId,
        actorUid,
      })

      resetProductForm()
      setStatusMessage(`${clearedCount} termék törölve lett a katalógusból.`)
    })
  }

  function handleManualBarcodeAdd() {
    addProductBarcode(barcodeInput)
  }

  function removeProductBarcode(barcode) {
    setProductState((current) => ({
      ...current,
      barcodes: (current.barcodes || []).filter((item) => item !== barcode),
    }))
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

  async function handleDeleteTemplate() {
    if (!templateState.templateId) return
    const confirmed = window.confirm(`Biztosan törlöd a(z) "${templateState.name}" módosítósablont?`)
    if (!confirmed) return

    await runAction(() =>
      deleteModifierTemplate({
        eventId,
        actorUid,
        templateId: templateState.templateId,
        name: templateState.name,
      }),
    )

    setTemplateState(emptyTemplateState)
    setStatusMessage('A módosítósablon törölve lett.')
  }

  function loadProductIntoForm(product) {
    clearBarcodeScannerTimer()
    setBarcodeInput('')
    const stockMode = inferStockMode(product, stockItems)
    const selfComponent = product.stockRecipe?.components?.[0]
    const selfStockItem = stockMode === STOCK_EDITOR_MODES.self
      ? getStockItemById(stockItems, selfComponent?.stockItemId)
      : null
    setProductState({
      productId: product.id,
      name: product.name,
      category: normalizeProductCategory(product.category),
      price: String(product.price),
      isActive: product.isActive,
      isTemporarilyUnavailable: product.isTemporarilyUnavailable,
      modifierTemplateId: product.modifierTemplateId || '',
      isDRS: product.isDRS || false,
      barcodes: product.barcodes || [],
      stockMode,
      selfStockUnit: selfStockItem?.unit || STOCK_UNITS.piece,
      selfStockQuantity: String(selfStockItem?.currentQuantity ?? 0),
      selfStockLowThreshold: String(selfStockItem?.lowThreshold ?? 0),
      stockRecipe: product.stockRecipe || emptyProductState.stockRecipe,
    })
    setStatusMessage('')
  }

  function loadStockItemIntoForm(stockItem) {
    setStockItemState({
      stockItemId: stockItem.id,
      name: stockItem.name || '',
      unit: stockItem.unit || STOCK_UNITS.piece,
      currentQuantity: String(stockItem.currentQuantity ?? 0),
      lowThreshold: String(stockItem.lowThreshold ?? 0),
      isActive: stockItem.isActive !== false,
    })
    setStockMovementState((current) => ({
      ...current,
      stockItemId: stockItem.id,
    }))
  }

  async function handleStockItemSubmit(event) {
    event.preventDefault()
    const isEditing = Boolean(stockItemState.stockItemId)

    await runAction(() =>
      saveStockItem({
        eventId,
        actorUid,
        ...stockItemState,
      }),
    )

    setStockItemState(emptyStockItemState)
    setStatusMessage(isEditing ? 'A készletelem frissítve lett.' : 'A készletelem létrejött.')
  }

  async function handleStockExcelImport(event) {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    setStockImportFileName(file.name)

    await runAction(async () => {
      const rows = await parseImportedStockItems(file)
      const result = await importStockItems({
        eventId,
        actorUid,
        rows,
      })

      setStatusMessage(`${result.importedCount} készletelem importálva. ${result.movementCount} korrekciós mozgás rögzítve.`)
      setStockImportFileName('')

      if (stockImportInputRef.current) {
        stockImportInputRef.current.value = ''
      }
    })

    if (stockImportInputRef.current) {
      stockImportInputRef.current.value = ''
    }
  }

  function handleStockExcelExport() {
    const rows = stockItems
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name, 'hu'))
      .map((stockItem) => ({
        name: stockItem.name || '',
        unit: STOCK_UNIT_LABELS[stockItem.unit] || stockItem.unit || 'db',
        current_quantity: stockItem.currentQuantity ?? 0,
        low_threshold: stockItem.lowThreshold ?? 0,
        active: stockItem.isActive !== false,
      }))
    const worksheet = utils.json_to_sheet(rows)
    const workbook = utils.book_new()
    utils.book_append_sheet(workbook, worksheet, 'stock')
    writeFile(workbook, `stock-${eventId}.xlsx`)
  }

  async function handleManualStockAdd(event) {
    event.preventDefault()

    await runAction(() =>
      applyManualStockMovement({
        eventId,
        actorUid,
        stockItemId: stockMovementState.stockItemId,
        type: STOCK_MOVEMENT_TYPES.manualAdd,
        amount: stockMovementState.amount,
        reason: stockMovementState.reason || 'Készlet hozzáadás',
      }),
    )

    setStockMovementState(emptyStockMovementState)
    setStatusMessage('A készlet hozzáadva.')
  }

  async function handleManualStockCorrection(event) {
    event.preventDefault()

    await runAction(() =>
      applyManualStockMovement({
        eventId,
        actorUid,
        stockItemId: stockMovementState.stockItemId,
        type: STOCK_MOVEMENT_TYPES.manualCorrection,
        countedQuantity: stockMovementState.countedQuantity,
        reason: stockMovementState.reason || 'Számolt készlet korrekció',
      }),
    )

    setStockMovementState(emptyStockMovementState)
    setStatusMessage('A készlet korrigálva.')
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

  function updateRecipe(updater) {
    setProductState((current) => ({
      ...current,
      stockRecipe: updater(current.stockRecipe || emptyProductState.stockRecipe),
    }))
  }

  function updateStockMode(mode) {
    setProductState((current) => {
      if (mode === STOCK_EDITOR_MODES.none) {
        return {
          ...current,
          stockMode: mode,
          stockRecipe: {
            enabled: false,
            components: [],
            choiceGroups: [],
          },
        }
      }

      if (mode === STOCK_EDITOR_MODES.self) {
        const stockItem = getStockItemByName(stockItems, current.name)
        return {
          ...current,
          stockMode: mode,
          selfStockUnit: stockItem?.unit || current.selfStockUnit || STOCK_UNITS.piece,
          selfStockQuantity: String(stockItem?.currentQuantity ?? current.selfStockQuantity ?? 0),
          selfStockLowThreshold: String(stockItem?.lowThreshold ?? current.selfStockLowThreshold ?? 0),
          stockRecipe: {
            enabled: false,
            components: [],
            choiceGroups: [],
          },
        }
      }

      return {
        ...current,
        stockMode: mode,
        stockRecipe: {
          ...(current.stockRecipe || emptyProductState.stockRecipe),
          enabled: true,
          components: current.stockRecipe?.components || [],
          choiceGroups: mode === STOCK_EDITOR_MODES.choice
            ? current.stockRecipe?.choiceGroups || []
            : [],
        },
      }
    })
  }

  function buildPresetComponent(name, quantityPerUnit) {
    const stockItem = getStockItemByName(stockItems, name)
    return {
      id: crypto.randomUUID(),
      stockItemId: stockItem?.id || '',
      stockItemName: stockItem?.name || name,
      quantityPerUnit: String(quantityPerUnit),
    }
  }

  function applyLongDrinkPreset(preset) {
    setProductState((current) => ({
      ...current,
      stockMode: STOCK_EDITOR_MODES.recipe,
      stockRecipe: {
        enabled: true,
        components: [
          buildPresetComponent(preset.spirit, 40),
          buildPresetComponent(preset.mixer, 250),
        ],
        choiceGroups: [],
      },
    }))
  }

  function enrichRecipeComponent(component) {
    const stockItem = stockItems.find((item) => item.id === component.stockItemId)
    return {
      ...component,
      stockItemName: stockItem?.name || component.stockItemName || '',
    }
  }

  function updateRecipeComponent(componentId, patch) {
    updateRecipe((recipe) => ({
      ...recipe,
      components: (recipe.components || []).map((component) =>
        component.id === componentId ? enrichRecipeComponent({ ...component, ...patch }) : component,
      ),
    }))
  }

  function updateRecipeOptionComponent(groupId, optionId, componentId, patch) {
    updateRecipe((recipe) => ({
      ...recipe,
      choiceGroups: (recipe.choiceGroups || []).map((group) =>
        group.id === groupId
          ? {
              ...group,
              options: (group.options || []).map((option) =>
                option.id === optionId
                  ? {
                      ...option,
                      components: (option.components || []).map((component) =>
                        component.id === componentId ? enrichRecipeComponent({ ...component, ...patch }) : component,
                      ),
                    }
                  : option,
              ),
            }
          : group,
      ),
    }))
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
      <input
        ref={hiddenBarcodeScannerInputRef}
        className="pos-hidden-scanner-input"
        type="text"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        onBlur={handleHiddenBarcodeScannerInputBlur}
        onChange={handleHiddenBarcodeScannerInputChange}
        onKeyDown={handleHiddenBarcodeScannerInputKeyDown}
      />
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
      {statusMessage ? <div className="status-inline">{statusMessage}</div> : null}

      <div className="catalog-mode-tabs" role="tablist" aria-label="Katalógus nézetek">
        <button
          type="button"
          role="tab"
          aria-selected={activeCatalogSection === 'products'}
          className={`catalog-mode-tab${activeCatalogSection === 'products' ? ' active' : ''}`}
          onClick={() => setActiveCatalogSection('products')}
        >
          <span>Termékek</span>
          <strong>{products.length}</strong>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeCatalogSection === 'templates'}
          className={`catalog-mode-tab${activeCatalogSection === 'templates' ? ' active' : ''}`}
          onClick={() => setActiveCatalogSection('templates')}
        >
          <span>Módosítósablonok</span>
          <strong>{modifierTemplates.length}</strong>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeCatalogSection === 'stock'}
          className={`catalog-mode-tab${activeCatalogSection === 'stock' ? ' active' : ''}`}
          onClick={() => setActiveCatalogSection('stock')}
        >
          <span>Készlet</span>
          <strong>{stockItems.length}</strong>
        </button>
      </div>

      <div className="catalog-mode-panel">
        {activeCatalogSection === 'products' ? (
        <section className="panel catalog-panel">
          <div className="catalog-panel-header">
            <h4 className="card-title">Termékkezelés</h4>
            <button
              type="button"
              className="secondary-button"
              onClick={resetProductForm}
              disabled={pending}
            >
              Új termék
            </button>
          </div>

          <div className="catalog-workbench">
            <div className="catalog-list-card">
              <div className="split-header">
                <h5 className="catalog-editor-title">Termékek</h5>
                <span className="catalog-state-badge">{filteredProducts.length}</span>
              </div>

              <input
                id="productSearch"
                type="search"
                value={productQuery}
                onChange={(event) => setProductQuery(event.target.value)}
                placeholder="Keresés…"
                aria-label="Termékek keresése"
              />

              <div className="catalog-import-bar">
                <label
                  className="secondary-button catalog-import-btn"
                  htmlFor="productImportFile"
                  title={`Oszlopok: name, drs, price, category, barcodes (${PRODUCT_CATEGORIES.join(', ')}). Opcionális készlet: stock_mode, stock_quantity, stock_low_threshold, stock_unit, stock_recipe, stock_choice_groups.`}
                >
                  ↑ Excel import
                </label>
                <input
                  id="productImportFile"
                  ref={importInputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={handleProductImport}
                  disabled={pending}
                  style={{ display: 'none' }}
                />
                <button
                  type="button"
                  className="secondary-button catalog-import-btn"
                  onClick={handleProductExport}
                  disabled={pending || !products.length}
                  title="Termékek exportálása Excelbe készlet oszlopokkal"
                >
                  ↓ Export
                </button>
                <button
                  type="button"
                  className="danger-button catalog-import-btn"
                  onClick={handleClearProducts}
                  disabled={pending || !products.length}
                  title={`Összes termék törlése (${products.length} db)`}
                >
                  ⊘ Törlés
                </button>
                {importFileName ? <span className="catalog-import-filename">{importFileName}</span> : null}
              </div>

              <div className="record-list stacked catalog-record-list">
                {filteredProducts.length ? (
                  filteredProducts.map((product) => {
                    const status = getAvailabilityState(product)
                    const { key: categoryKey, color: categoryColor } = CATEGORY_COLOR_MAP[normalizeProductCategory(product.category)] || DEFAULT_CATEGORY
                    const templateName = templateLookup[product.modifierTemplateId]?.name
                    return (
                      <button
                        key={product.id}
                        type="button"
                        className={`record-row catalog-product-row${productState.productId === product.id ? ' selected' : ''}`}
                        style={{ borderLeft: `4px solid ${categoryColor}` }}
                        onClick={() => loadProductIntoForm(product)}
                      >
                        <span className="catalog-row-body">
                          <strong>{product.name}</strong>
                          <span className="catalog-row-chips">
                            <span className={`catalog-cat-chip catalog-cat-chip--${categoryKey}`}>{normalizeProductCategory(product.category)}</span>
                            <span className="catalog-price-chip">{formatHuf(product.price)}</span>
                            {product.isDRS && <span className="catalog-drs-chip">DRS</span>}
                            {(product.barcodes || []).length > 0 && (
                              <span className="catalog-barcode-chip">{(product.barcodes || []).length} vonalkod</span>
                            )}
                            {templateName && <span className="catalog-template-name">{templateName}</span>}
                          </span>
                        </span>
                        <span
                          className={`catalog-status-dot catalog-status-dot--${status}`}
                          title={
                            status === PRODUCT_AVAILABILITY.unavailable ? 'Ideiglenesen nem elérhető'
                            : status === PRODUCT_AVAILABILITY.inactive ? 'Inaktív'
                            : 'Aktív'
                          }
                        />
                      </button>
                    )
                  })
                ) : (
                  <div className="catalog-empty-state">
                    <strong>Nincs találat.</strong>
                    <p className="helper-text">Próbálj tágabb keresést, vagy hozz létre új terméket.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="catalog-editor-card">
              <div className="split-header">
                <h5 className="catalog-editor-title">
                  {productState.productId ? `${productState.name || 'termék'} szerkesztése` : 'Új termék'}
                </h5>
                <span className={`catalog-state-badge ${productState.productId ? 'is-editing' : ''}`}>
                  {productState.productId ? 'Szerkesztés' : 'Új'}
                </span>
              </div>

              <div className="catalog-preview-strip">
                <div className="catalog-preview-tile">
                  <span className="catalog-preview-label">Ár</span>
                  <strong>{productState.price ? formatHuf(Number(productState.price) || 0) : '—'}</strong>
                </div>
                <div className="catalog-preview-tile">
                  <span className="catalog-preview-label">Elérhetőség</span>
                  <strong>
                    {availabilityState === PRODUCT_AVAILABILITY.unavailable
                      ? 'Szünetel'
                      : availabilityState === PRODUCT_AVAILABILITY.inactive
                        ? 'Inaktív'
                        : 'Aktív'}
                  </strong>
                </div>
                <div className="catalog-preview-tile">
                  <span className="catalog-preview-label">Módosító</span>
                  <strong>{templateLookup[productState.modifierTemplateId]?.name || '—'}</strong>
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
                  <label>Kategória</label>
                  <div className="catalog-category-picker">
                    {PRODUCT_CATEGORIES.map((cat) => {
                      const { key } = CATEGORY_COLOR_MAP[cat] || DEFAULT_CATEGORY
                      return (
                        <button
                          key={cat}
                          type="button"
                          className={`catalog-category-chip catalog-cat-chip--${key}${productState.category === cat ? ' selected' : ''}`}
                          onClick={() => setProductState((c) => ({ ...c, category: cat }))}
                        >
                          {cat}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="productPrice">Ár (HUF)</label>
                  <input
                    id="productPrice"
                    value={productState.price}
                    onChange={(event) => setProductState((current) => ({ ...current, price: event.target.value }))}
                    placeholder="1200"
                    required
                  />
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
                  {!sortedTemplates.length && (
                    <span className="helper-text">Még nincs sablon – először hozz létre egyet.</span>
                  )}
                </div>
                <div className="field catalog-barcode-field">
                  <label htmlFor="productBarcode">Vonalkodok</label>
                  <div className="catalog-barcode-capture-row">
                    <input
                      id="productBarcode"
                      value={barcodeInput}
                      onChange={(event) => setBarcodeInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          handleManualBarcodeAdd()
                        }
                      }}
                      placeholder="EAN / UPC"
                      inputMode="numeric"
                      pattern="[0-9]*"
                    />
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={handleManualBarcodeAdd}
                      disabled={pending || !barcodeInput.trim()}
                    >
                      Hozzaad
                    </button>
                  </div>
                  <span className="helper-text">Olvasd be barhol az oldalon, vagy add meg kezzel. A 4 jegyu kodok persona QR-hoz vannak fenntartva.</span>
                  {(productState.barcodes || []).length > 0 ? (
                    <div className="catalog-barcode-chip-list">
                      {productState.barcodes.map((barcode) => (
                        <button
                          key={barcode}
                          type="button"
                          className="catalog-barcode-token"
                          onClick={() => removeProductBarcode(barcode)}
                          title="Vonalkod eltavolitasa"
                        >
                          <span>{barcode}</span>
                          <strong aria-hidden="true">x</strong>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="field">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={productState.isDRS}
                      onChange={(event) =>
                        setProductState((current) => ({ ...current, isDRS: event.target.checked }))
                      }
                    />
                    <span style={{ fontWeight: 500 }}>Betétdíjas (DRS, +50 Ft)</span>
                  </label>
                  <span className="helper-text">A kasszában automatikusan +50 Ft betétdíj-sor jelenik meg.</span>
                </div>
                <div className="field">
                  <label>Elérhetőség</label>
                  <div className="availability-toggle">
                    <button
                      type="button"
                      className={`availability-option availability-option--active${availabilityState === PRODUCT_AVAILABILITY.active ? ' active' : ''}`}
                      onClick={() =>
                        setProductState((current) => ({
                          ...current,
                          ...buildAvailabilityPatch(PRODUCT_AVAILABILITY.active),
                        }))
                      }
                    >
                      ✓ Aktív
                    </button>
                    <button
                      type="button"
                      className={`availability-option availability-option--unavailable${availabilityState === PRODUCT_AVAILABILITY.unavailable ? ' active' : ''}`}
                      onClick={() =>
                        setProductState((current) => ({
                          ...current,
                          ...buildAvailabilityPatch(PRODUCT_AVAILABILITY.unavailable),
                        }))
                      }
                    >
                      ⚠ Szünetel
                    </button>
                    <button
                      type="button"
                      className={`availability-option availability-option--inactive${availabilityState === PRODUCT_AVAILABILITY.inactive ? ' active' : ''}`}
                      onClick={() =>
                        setProductState((current) => ({
                          ...current,
                          ...buildAvailabilityPatch(PRODUCT_AVAILABILITY.inactive),
                        }))
                      }
                    >
                      ✕ Inaktív
                    </button>
                  </div>
                </div>
                <div className="field catalog-stock-recipe-field">
                  <label>Készlet követés</label>
                  <div className="stock-mode-grid">
                    {[
                      { mode: STOCK_EDITOR_MODES.none, title: 'Nincs', text: 'Nem fogyaszt készletet.' },
                      { mode: STOCK_EDITOR_MODES.self, title: 'Saját készlet', text: 'Dobozos ital, nasi, darabos termék.' },
                      { mode: STOCK_EDITOR_MODES.recipe, title: 'Receptből fogy', text: 'Fix alkohol + mixer vagy alapanyagok.' },
                      { mode: STOCK_EDITOR_MODES.choice, title: 'Választással fogy', text: 'Például fehér/rosé fröccs.' },
                    ].map((option) => (
                      <button
                        key={option.mode}
                        type="button"
                        className={`stock-mode-card${productState.stockMode === option.mode ? ' selected' : ''}`}
                        onClick={() => updateStockMode(option.mode)}
                      >
                        <strong>{option.title}</strong>
                        <span>{option.text}</span>
                      </button>
                    ))}
                  </div>

                  {productState.stockMode === STOCK_EDITOR_MODES.self ? (
                    <div className="catalog-recipe-box stock-self-box">
                      <div className="split-header">
                        <strong>{productState.name || 'Termék'} készlete</strong>
                        <span className="catalog-state-badge">1 eladás = -1</span>
                      </div>
                      <div className="stock-self-grid">
                        <div className="field">
                          <label htmlFor="selfStockQuantity">Jelenlegi mennyiség</label>
                          <input
                            id="selfStockQuantity"
                            value={productState.selfStockQuantity}
                            onChange={(event) => setProductState((current) => ({ ...current, selfStockQuantity: event.target.value }))}
                            inputMode="numeric"
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="selfStockLowThreshold">Alacsony jelzés</label>
                          <input
                            id="selfStockLowThreshold"
                            value={productState.selfStockLowThreshold}
                            onChange={(event) => setProductState((current) => ({ ...current, selfStockLowThreshold: event.target.value }))}
                            inputMode="numeric"
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="selfStockUnit">Egység</label>
                          <select
                            id="selfStockUnit"
                            value={productState.selfStockUnit}
                            onChange={(event) => setProductState((current) => ({ ...current, selfStockUnit: event.target.value }))}
                          >
                            <option value={STOCK_UNITS.piece}>db</option>
                            <option value={STOCK_UNITS.ml}>ml</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {productState.stockMode === STOCK_EDITOR_MODES.recipe || productState.stockMode === STOCK_EDITOR_MODES.choice ? (
                    <div className="catalog-recipe-box">
                      <div className="split-header">
                        <strong>Gyors hosszúital sablon</strong>
                      </div>
                      <div className="stock-preset-grid">
                        {LONG_DRINK_RECIPE_PRESETS.map((preset) => (
                          <button
                            key={preset.label}
                            type="button"
                            className="secondary-button compact-button"
                            onClick={() => applyLongDrinkPreset(preset)}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>

                      <div className="split-header">
                        <strong>Fix fogyás / db</strong>
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={() => updateRecipe((recipe) => ({
                            ...recipe,
                            components: [...(recipe.components || []), createRecipeComponent()],
                          }))}
                        >
                          + Komponens
                        </button>
                      </div>
                      {(productState.stockRecipe.components || []).map((component) => (
                        <div key={component.id} className="catalog-recipe-row">
                          <select
                            value={component.stockItemId}
                            onChange={(event) => updateRecipeComponent(component.id, { stockItemId: event.target.value })}
                          >
                            <option value="">Készletelem</option>
                            {stockItems.map((stockItem) => (
                              <option key={stockItem.id} value={stockItem.id}>
                                {stockItem.name} ({STOCK_UNIT_LABELS[stockItem.unit] || stockItem.unit})
                              </option>
                            ))}
                          </select>
                          <input
                            value={component.quantityPerUnit}
                            onChange={(event) => updateRecipeComponent(component.id, { quantityPerUnit: event.target.value })}
                            placeholder="mennyiség"
                            inputMode="numeric"
                          />
                          <button
                            type="button"
                            className="danger-button compact-button"
                            onClick={() => updateRecipe((recipe) => ({
                              ...recipe,
                              components: (recipe.components || []).filter((item) => item.id !== component.id),
                            }))}
                          >
                            Törlés
                          </button>
                        </div>
                      ))}

                      {productState.stockMode === STOCK_EDITOR_MODES.choice ? (
                        <>
                          <div className="split-header">
                            <strong>Kötelező választások</strong>
                            <button
                              type="button"
                              className="secondary-button compact-button"
                              onClick={() => updateRecipe((recipe) => ({
                                ...recipe,
                                choiceGroups: [...(recipe.choiceGroups || []), createRecipeChoiceGroup()],
                              }))}
                            >
                              + Választás
                            </button>
                          </div>
                          {(productState.stockRecipe.choiceGroups || []).map((group) => (
                            <div key={group.id} className="catalog-choice-group">
                              <div className="catalog-recipe-row">
                                <input
                                  value={group.label}
                                  onChange={(event) => updateRecipe((recipe) => ({
                                    ...recipe,
                                    choiceGroups: (recipe.choiceGroups || []).map((item) =>
                                      item.id === group.id ? { ...item, label: event.target.value } : item,
                                    ),
                                  }))}
                                  placeholder="Pl. Bor fajtája"
                                />
                                <button
                                  type="button"
                                  className="danger-button compact-button"
                                  onClick={() => updateRecipe((recipe) => ({
                                    ...recipe,
                                    choiceGroups: (recipe.choiceGroups || []).filter((item) => item.id !== group.id),
                                  }))}
                                >
                                  Törlés
                                </button>
                              </div>
                              {(group.options || []).map((option) => {
                                const component = option.components?.[0] || createRecipeComponent()
                                return (
                                  <div key={option.id} className="catalog-recipe-row catalog-option-row">
                                    <input
                                      value={option.label}
                                      onChange={(event) => updateRecipe((recipe) => ({
                                        ...recipe,
                                        choiceGroups: (recipe.choiceGroups || []).map((item) =>
                                          item.id === group.id
                                            ? {
                                                ...item,
                                                options: (item.options || []).map((candidate) =>
                                                  candidate.id === option.id ? { ...candidate, label: event.target.value } : candidate,
                                                ),
                                              }
                                            : item,
                                        ),
                                      }))}
                                      placeholder="Opció neve"
                                    />
                                    <select
                                      value={component.stockItemId}
                                      onChange={(event) => updateRecipeOptionComponent(group.id, option.id, component.id, { stockItemId: event.target.value })}
                                    >
                                      <option value="">Készletelem</option>
                                      {stockItems.map((stockItem) => (
                                        <option key={stockItem.id} value={stockItem.id}>
                                          {stockItem.name}
                                        </option>
                                      ))}
                                    </select>
                                    <input
                                      value={component.quantityPerUnit}
                                      onChange={(event) => updateRecipeOptionComponent(group.id, option.id, component.id, { quantityPerUnit: event.target.value })}
                                      placeholder="menny."
                                      inputMode="numeric"
                                    />
                                    <button
                                      type="button"
                                      className="danger-button compact-button"
                                      onClick={() => updateRecipe((recipe) => ({
                                        ...recipe,
                                        choiceGroups: (recipe.choiceGroups || []).map((item) =>
                                          item.id === group.id
                                            ? { ...item, options: (item.options || []).filter((candidate) => candidate.id !== option.id) }
                                            : item,
                                        ),
                                      }))}
                                    >
                                      Törlés
                                    </button>
                                  </div>
                                )
                              })}
                              <button
                                type="button"
                                className="secondary-button compact-button"
                                onClick={() => updateRecipe((recipe) => ({
                                  ...recipe,
                                  choiceGroups: (recipe.choiceGroups || []).map((item) =>
                                    item.id === group.id ? { ...item, options: [...(item.options || []), createRecipeOption()] } : item,
                                  ),
                                }))}
                              >
                                + Opció
                              </button>
                            </div>
                          ))}
                        </>
                      ) : null}
                      {!stockItems.length ? <span className="helper-text">Először hozz létre készletelemeket a Készlet fülön.</span> : null}
                    </div>
                  ) : null}
                </div>
                <div className="button-row">
                  <button type="submit" className="primary-button" disabled={pending}>
                    {productState.productId ? 'Frissítés' : 'Mentés'}
                  </button>
                  {productState.productId ? (
                    <>
                      <button
                        type="button"
                        className="danger-button"
                        onClick={handleDeleteProduct}
                        disabled={pending}
                      >
                        Törlés
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={resetProductForm}
                        disabled={pending}
                      >
                        Mégse
                      </button>
                    </>
                  ) : null}
                </div>
              </form>
            </div>
          </div>
        </section>
        ) : null}

        {activeCatalogSection === 'templates' ? (
        <section className="panel catalog-panel">
          <div className="catalog-panel-header">
            <h4 className="card-title">Módosítósablonok</h4>
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
                <h5 className="catalog-editor-title">Sablonok</h5>
                <span className="catalog-state-badge">{filteredTemplates.length}</span>
              </div>

              <input
                id="templateSearch"
                type="search"
                value={templateQuery}
                onChange={(event) => setTemplateQuery(event.target.value)}
                placeholder="Keresés…"
                aria-label="Sablonok keresése"
              />

              <div className="record-list stacked catalog-record-list">
                {filteredTemplates.length ? (
                  filteredTemplates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className={`record-row catalog-template-row${templateState.templateId === template.id ? ' selected' : ''}`}
                      onClick={() => loadTemplateIntoForm(template)}
                    >
                      <span className="catalog-row-body">
                        <strong>{template.name}</strong>
                        {(template.defaultIncludedIngredients || []).length > 0 && (
                          <span className="catalog-row-chips">
                            {(template.defaultIncludedIngredients || []).slice(0, 3).map((ing) => (
                              <span key={ing.label} className="catalog-ing-pill">{ing.label}</span>
                            ))}
                            {(template.defaultIncludedIngredients || []).length > 3 && (
                              <span className="catalog-ing-pill catalog-ing-pill--more">
                                +{(template.defaultIncludedIngredients || []).length - 3}
                              </span>
                            )}
                            {(template.optionalExtras || []).length > 0 && (
                              <span className="catalog-extras-count">{(template.optionalExtras || []).length} extra</span>
                            )}
                          </span>
                        )}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="catalog-empty-state">
                    <strong>Nincs találat.</strong>
                    <p className="helper-text">Próbálj tágabb keresést, vagy hozz létre új sablont.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="catalog-editor-stack">
              <div className="catalog-editor-card">
                <div className="split-header">
                  <h5 className="catalog-editor-title">
                    {templateState.templateId ? `${templateState.name || 'sablon'} szerkesztése` : 'Új sablon'}
                  </h5>
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
                      <span className="catalog-preview-label">Alapértelmezett összetevők</span>
                      <button type="button" className="secondary-button" onClick={addIngredientField}>
                        + Összetevő
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
                            −
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="catalog-structured-section">
                    <div className="split-header">
                      <span className="catalog-preview-label">Választható extrák</span>
                      <button type="button" className="secondary-button" onClick={addExtraField}>
                        + Extra
                      </button>
                    </div>
                    <div className="catalog-field-list">
                      <div className="catalog-builder-row catalog-builder-row-extra catalog-builder-row-heading" aria-hidden="true">
                        <span />
                        <span>Extra neve</span>
                        <span>Felár</span>
                        <span>Max.</span>
                        <span />
                      </div>
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
                            −
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="button-row">
                    <button type="submit" className="primary-button" disabled={pending}>
                      {templateState.templateId ? 'Frissítés' : 'Mentés'}
                    </button>
                    {templateState.templateId ? (
                      <>
                        <button
                          type="button"
                          className="danger-button"
                          onClick={handleDeleteTemplate}
                          disabled={pending}
                        >
                          Törlés
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => setTemplateState(emptyTemplateState)}
                          disabled={pending}
                        >
                          Mégse
                        </button>
                      </>
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
                    {sanitizedIngredientsPreview.length} alap | {sanitizedExtrasPreview.length} extra
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
        ) : null}
        {activeCatalogSection === 'stock' ? (
        <section className="panel catalog-panel">
          <div className="catalog-panel-header">
            <h4 className="card-title">Készlet</h4>
            <div className="catalog-import-bar">
              <label
                className="secondary-button catalog-import-btn"
                htmlFor="stockImportFile"
                title="Oszlopok: name, unit, current_quantity, low_threshold, active"
              >
                ↑ Excel import
              </label>
              <input
                id="stockImportFile"
                ref={stockImportInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={handleStockExcelImport}
                disabled={pending}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                className="secondary-button catalog-import-btn"
                onClick={handleStockExcelExport}
                disabled={pending || !stockItems.length}
                title="Készletelemek exportálása Excelbe"
              >
                ↓ Export
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setStockItemState(emptyStockItemState)}
                disabled={pending}
              >
                Új készletelem
              </button>
              {stockImportFileName ? <span className="catalog-import-filename">{stockImportFileName}</span> : null}
            </div>
          </div>

          <div className="catalog-workbench">
            <div className="catalog-list-card">
              <div className="split-header">
                <h5 className="catalog-editor-title">Készletelemek</h5>
                <span className="catalog-state-badge">{stockItems.length}</span>
              </div>
              <div className="record-list stacked catalog-record-list">
                {stockItems.length ? stockItems.map((stockItem) => (
                  <button
                    key={stockItem.id}
                    type="button"
                    className={`record-row catalog-product-row${stockItemState.stockItemId === stockItem.id ? ' selected' : ''}`}
                    onClick={() => loadStockItemIntoForm(stockItem)}
                  >
                    <span className="catalog-row-body">
                      <strong>{stockItem.name}</strong>
                      <span className="catalog-row-chips">
                        <span className="catalog-price-chip">
                          {stockItem.currentQuantity ?? 0} {STOCK_UNIT_LABELS[stockItem.unit] || stockItem.unit}
                        </span>
                        <span className="catalog-ing-pill">Minimum: {stockItem.lowThreshold ?? 0}</span>
                        {stockItem.isActive === false ? <span className="catalog-drs-chip">Inaktív</span> : null}
                      </span>
                    </span>
                  </button>
                )) : (
                  <div className="catalog-empty-state">
                    <strong>Még nincs készlet.</strong>
                    <p className="helper-text">Hozz létre például sör db, fehér bor ml, vodka ml vagy tonic ml elemet.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="catalog-editor-stack">
              <div className="catalog-editor-card">
                <div className="split-header">
                  <h5 className="catalog-editor-title">
                    {stockItemState.stockItemId ? `${stockItemState.name || 'készletelem'} szerkesztése` : 'Új készletelem'}
                  </h5>
                  <span className={`catalog-state-badge ${stockItemState.stockItemId ? 'is-editing' : ''}`}>
                    {stockItemState.stockItemId ? 'Szerkesztés' : 'Új'}
                  </span>
                </div>
                <form className="form-grid" onSubmit={handleStockItemSubmit}>
                  <div className="field">
                    <label htmlFor="stockItemName">Név</label>
                    <input
                      id="stockItemName"
                      value={stockItemState.name}
                      onChange={(event) => setStockItemState((current) => ({ ...current, name: event.target.value }))}
                      placeholder="Fehér bor"
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="stockItemUnit">Egység</label>
                    <select
                      id="stockItemUnit"
                      value={stockItemState.unit}
                      onChange={(event) => setStockItemState((current) => ({ ...current, unit: event.target.value }))}
                    >
                      <option value={STOCK_UNITS.piece}>db</option>
                      <option value={STOCK_UNITS.ml}>ml</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="stockCurrentQuantity">Jelenlegi mennyiség</label>
                    <input
                      id="stockCurrentQuantity"
                      value={stockItemState.currentQuantity}
                      onChange={(event) => setStockItemState((current) => ({ ...current, currentQuantity: event.target.value }))}
                      inputMode="numeric"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="stockLowThreshold">Alacsony jelzés</label>
                    <input
                      id="stockLowThreshold"
                      value={stockItemState.lowThreshold}
                      onChange={(event) => setStockItemState((current) => ({ ...current, lowThreshold: event.target.value }))}
                      inputMode="numeric"
                    />
                  </div>
                  <div className="field">
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={stockItemState.isActive}
                        onChange={(event) => setStockItemState((current) => ({ ...current, isActive: event.target.checked }))}
                      />
                      <span>Aktív</span>
                    </label>
                  </div>
                  <div className="button-row">
                    <button type="submit" className="primary-button" disabled={pending}>
                      {stockItemState.stockItemId ? 'Frissítés' : 'Mentés'}
                    </button>
                    {stockItemState.stockItemId ? (
                      <button type="button" className="secondary-button" onClick={() => setStockItemState(emptyStockItemState)}>
                          Mégse
                      </button>
                    ) : null}
                  </div>
                </form>
              </div>

              <div className="catalog-editor-card">
                <div className="split-header">
                  <h5 className="catalog-editor-title">Készletmozgás</h5>
                  <span className="catalog-state-badge">{stockMovements.length}</span>
                </div>
                <form className="form-grid" onSubmit={handleManualStockAdd}>
                  <div className="field">
                    <label htmlFor="movementStockItem">Készletelem</label>
                    <select
                      id="movementStockItem"
                      value={stockMovementState.stockItemId}
                      onChange={(event) => setStockMovementState((current) => ({ ...current, stockItemId: event.target.value }))}
                      required
                    >
                      <option value="">Válassz</option>
                      {stockItems.map((stockItem) => (
                        <option key={stockItem.id} value={stockItem.id}>{stockItem.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="movementAmount">Hozzáadás</label>
                    <input
                      id="movementAmount"
                      value={stockMovementState.amount}
                      onChange={(event) => setStockMovementState((current) => ({ ...current, amount: event.target.value }))}
                      inputMode="numeric"
                      placeholder="pl. 24000"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="movementCounted">Számolt készlet</label>
                    <input
                      id="movementCounted"
                      value={stockMovementState.countedQuantity}
                      onChange={(event) => setStockMovementState((current) => ({ ...current, countedQuantity: event.target.value }))}
                      inputMode="numeric"
                      placeholder="korrekcióhoz"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="movementReason">Megjegyzés</label>
                    <input
                      id="movementReason"
                      value={stockMovementState.reason}
                      onChange={(event) => setStockMovementState((current) => ({ ...current, reason: event.target.value }))}
                    />
                  </div>
                  <div className="button-row">
                    <button type="submit" className="primary-button" disabled={pending || !stockMovementState.stockItemId || parseStockInteger(stockMovementState.amount, 0) <= 0}>
                      Hozzáadás
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={handleManualStockCorrection}
                      disabled={pending || !stockMovementState.stockItemId || stockMovementState.countedQuantity === ''}
                    >
                      Korrekció
                    </button>
                  </div>
                </form>
                <div className="record-list stacked catalog-record-list">
                  {stockMovements.slice(0, 20).map((movement) => (
                    <div key={movement.id} className="record-row catalog-product-row">
                      <span className="catalog-row-body">
                        <strong>{movement.stockItemName}</strong>
                        <span className="catalog-row-chips">
                          <span className="catalog-price-chip">
                            {movement.quantityDelta > 0 ? '+' : ''}{movement.quantityDelta} {STOCK_UNIT_LABELS[movement.unit] || movement.unit}
                          </span>
                          <span className="catalog-ing-pill">{movement.type}</span>
                          {movement.reason ? <span className="catalog-ing-pill">{movement.reason}</span> : null}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>
        ) : null}
      </div>
    </div>
  )
}
