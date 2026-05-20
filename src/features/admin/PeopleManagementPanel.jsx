import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import * as XLSX from 'xlsx'
import { StatusCard } from '../../components/StatusCard'
import { formatHuf, parseHufInteger } from '../../lib/money'
import { ATTENDEE_TYPES, PERSON_RECORD_STATUSES, getAttendeeTypeLabel, getPersonDisplayId } from '../people/personModels'
import {
  adjustPersonBalance,
  deletePersonRecord,
  importPeopleFromRows,
  importPeopleFromText,
  restorePersonRecord,
  subscribeToPeople,
  topUpPersonBalance,
  updatePersonRecord,
} from '../people/personService'
import { subscribeToAccountsDirectory, linkRegisteredUserToPerson } from '../auth/accountService'
import {
  generateQrCredentials,
  importQrCredentials,
  deleteQrCredential,
  assignQrToPerson,
  revokeQrForPerson,
  resolveAssignedQrToPerson,
  subscribeToQrCredentials,
  QR_CREDENTIAL_STATUSES,
} from '../qr/qrService'
import { useQrScanner } from '../qr/useQrScanner'
import { QR_CODE_LENGTH, buildQrCredentialLink, normalizeQrInput } from '../qr/qrLinks'

const quickTopupAmounts = [2000, 5000, 10000, 20000]
const KEYBOARD_SCANNER_MAX_GAP_MS = 350
const KEYBOARD_SCANNER_FLUSH_MS = 500
const huCollator = new Intl.Collator('hu', { sensitivity: 'base', numeric: true })

const emptyEditState = {
  displayName: '',
  team: '',
  attendeeType: ATTENDEE_TYPES.freshman,
  shibboleth: '',
}

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

function buildSelectedPersonState(person) {
  return {
    displayName: person.displayName,
    team: person.team || '',
    attendeeType: person.attendeeType,
    shibboleth: person.shibboleth || '',
  }
}

function formatTimestamp(value) {
  if (!value?.toDate) return '—'
  return value.toDate().toLocaleString('hu-HU')
}

function buildPersonaCompleteness(person) {
  const hasAccount = Boolean(person.linkedAccountId || person.linkedAuthUid)
  const hasQr = Boolean(person.assignedQrId || person.qrCodeId)
  if (hasAccount && hasQr) return 'complete'
  if (hasAccount || hasQr) return 'partial'
  return 'incomplete'
}

function normalizeFunctionError(error, fallback) {
  switch (error?.code) {
    case 'functions/not-found':
    case 'functions/failed-precondition':
    case 'functions/invalid-argument':
      return error.message || fallback
    case 'functions/permission-denied':
      return 'Admin jogosultság szükséges ehhez a művelethez.'
    default:
      return error?.message || fallback
  }
}

// ── Completeness pill ──────────────────────────────────────────────────────
function normalizeImportHeader(value) {
  return `${value ?? ''}`
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
}

function resolveExcelColumnIndexes(headerRow) {
  const normalizedHeaders = headerRow.map(normalizeImportHeader)
  const aliases = {
    displayName: ['name', 'displayname', 'nev', 'név'],
    team: ['team', 'csapat'],
    attendeeType: ['type', 'attendeetype', 'status', 'tipus', 'típus'],
    shibboleth: ['shibboleth', 'shib'],
  }

  const indexes = Object.fromEntries(
    Object.entries(aliases).map(([field, fieldAliases]) => [
      field,
      normalizedHeaders.findIndex((header) => fieldAliases.includes(header)),
    ]),
  )

  return indexes.displayName >= 0 ? indexes : null
}

function parsePersonaExcelRows(workbook) {
  const firstSheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[firstSheetName]
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })
  const nonEmptyRows = rawRows.filter((row) => row.some((cell) => `${cell ?? ''}`.trim()))
  if (!nonEmptyRows.length) return []

  const headerIndexes = resolveExcelColumnIndexes(nonEmptyRows[0])

  if (!headerIndexes) {
    return nonEmptyRows.map((row) => [row[0], row[1], row[2], row[3]])
  }

  return nonEmptyRows.slice(1).map((row) => [
    row[headerIndexes.displayName],
    headerIndexes.team >= 0 ? row[headerIndexes.team] : '',
    headerIndexes.attendeeType >= 0 ? row[headerIndexes.attendeeType] : '',
    headerIndexes.shibboleth >= 0 ? row[headerIndexes.shibboleth] : '',
  ])
}

function parseQrExcelCodes(workbook) {
  const firstSheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[firstSheetName]
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })
  const nonEmptyRows = rawRows.filter((row) => row.some((cell) => `${cell ?? ''}`.trim()))
  if (!nonEmptyRows.length) return []

  const firstRow = nonEmptyRows[0].map(normalizeImportHeader)
  const codeIndex = firstRow.findIndex((header) => ['code', 'kod', 'kód', 'qr', 'qrcode', 'qrkod', 'qrkód'].includes(header))
  const linkIndex = firstRow.findIndex((header) => ['link', 'url'].includes(header))
  const hasHeader = codeIndex >= 0 || linkIndex >= 0
  const valueIndex = codeIndex >= 0 ? codeIndex : linkIndex >= 0 ? linkIndex : 0

  return (hasHeader ? nonEmptyRows.slice(1) : nonEmptyRows)
    .map((row) => row[valueIndex])
    .map((value) => `${value ?? ''}`.trim())
    .filter(Boolean)
}

function splitQrImportInput(value) {
  return `${value ?? ''}`
    .split(/[\s,;]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
}

const COMPLETENESS_LABELS = { complete: 'Kész', partial: 'Részleges', incomplete: 'Hiányos' }
const COMPLETENESS_COLORS = {
  complete:   { background: 'color-mix(in srgb, var(--success) 12%, transparent)', color: '#15803d', border: '#86efac' },
  partial:    { background: '#fefce8', color: '#92400e', border: '#fde047' },
  incomplete: { background: 'var(--surface)', color: 'var(--muted)', border: 'var(--border)' },
}

function getStatusLabel(status) {
  switch (status) {
    case 'active':
      return 'aktív'
    case 'deleted':
      return 'törölt'
    case 'assigned':
      return 'hozzárendelve'
    case 'unassigned':
      return 'szabad'
    case 'revoked':
      return 'visszavonva'
    default:
      return status || '-'
  }
}

function CompletenessDot({ completeness }) {
  return <span className={`completeness-dot ${completeness}`} title={COMPLETENESS_LABELS[completeness]} />
}

// ── Sub-tab bar ────────────────────────────────────────────────────────────
function SubTabBar({ tabs, active, onChange }) {
  return (
    <div className="sub-tab-bar">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`sub-tab-btn${active === tab.id ? ' active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

// ── Person Profile sub-tab ─────────────────────────────────────────────────
function PersonProfileTab({ selectedPerson, editState, setEditState, pending, onSave, onDelete, onRestore }) {
  const isDeleted = selectedPerson.recordStatus === PERSON_RECORD_STATUSES.deleted

  return (
    <div className="stack-block" style={{ gap: '14px' }}>
      <div className="field">
        <label htmlFor="personName">Megjelenített név</label>
        <input
          id="personName"
          value={editState.displayName}
          onChange={(e) => setEditState((s) => ({ ...s, displayName: e.target.value }))}
        />
      </div>
      <div className="field">
        <label htmlFor="personTeam">Csapat</label>
        <input
          id="personTeam"
          value={editState.team}
          onChange={(e) => setEditState((s) => ({ ...s, team: e.target.value }))}
          placeholder="Piros, Kék, Szervező..."
        />
      </div>
      <div className="field">
        <label htmlFor="personAttendeeType">Résztvevő típusa</label>
        <select
          id="personAttendeeType"
          value={editState.attendeeType}
          onChange={(e) => setEditState((s) => ({ ...s, attendeeType: e.target.value }))}
        >
          <option value={ATTENDEE_TYPES.freshman}>{getAttendeeTypeLabel(ATTENDEE_TYPES.freshman)}</option>
          <option value={ATTENDEE_TYPES.organizer}>{getAttendeeTypeLabel(ATTENDEE_TYPES.organizer)}</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="personShibboleth">Shibboleth</label>
        <input
          id="personShibboleth"
          value={editState.shibboleth}
          onChange={(e) => setEditState((s) => ({ ...s, shibboleth: e.target.value }))}
          placeholder="Külső azonosító"
        />
      </div>
      <div className="button-row">
        <button type="button" className="primary-button" onClick={onSave} disabled={pending}>
          Változások mentése
        </button>
        {isDeleted ? (
          <button type="button" className="secondary-button" onClick={onRestore} disabled={pending}>
            Persona visszaállítása
          </button>
        ) : (
          <button type="button" className="danger-button" onClick={onDelete} disabled={pending}>
            Persona törlése
          </button>
        )}
      </div>
      <ul className="detail-list" style={{ fontSize: '0.8rem', marginTop: '4px' }}>
        <li><strong>Publikus ID</strong> <span style={{ fontFamily: 'monospace' }}>{getPersonDisplayId(selectedPerson)}</span></li>
        <li><strong>Belső ID</strong> <span style={{ fontFamily: 'monospace', color: 'var(--muted)', fontSize: '0.9em' }}>{selectedPerson.internalId}</span></li>
        <li><strong>Állapot</strong> <span style={{ textTransform: 'capitalize' }}>{getStatusLabel(selectedPerson.recordStatus)}</span></li>
        <li><strong>Létrehozva</strong> <span>{formatTimestamp(selectedPerson.createdAt)}</span></li>
      </ul>
    </div>
  )
}

// ── Person Account sub-tab ─────────────────────────────────────────────────
function PersonAccountTab({ selectedPerson, linkedAccount, availableAccounts, accountSearch, setAccountSearch, pending, onLink, onUnlink }) {
  const linkedUid = selectedPerson.linkedAccountId || selectedPerson.linkedAuthUid || null

  return (
    <div className="stack-block" style={{ gap: '14px' }}>
      {linkedAccount ? (
        <>
          <div className="linked-account-chip">
            <div className="linked-account-avatar">
              {(linkedAccount.displayName || linkedAccount.email || '?')[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{linkedAccount.displayName || '—'}</div>
              <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>{linkedAccount.email}</div>
            </div>
          </div>
          <ul className="detail-list" style={{ fontSize: '0.8rem' }}>
            <li><strong>UID</strong> <span style={{ fontFamily: 'monospace', fontSize: '0.72rem' }}>{linkedUid}</span></li>
            <li><strong>Szerepkör</strong> <span>{linkedAccount.role || 'user'}</span></li>
          </ul>
          <div className="button-row">
            <button type="button" className="danger-button" onClick={onUnlink} disabled={pending}>
              Fiók leválasztása
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="helper-text">Nincs fiók hozzárendelve. Keress rá egy fiókra, majd kattints rá a hozzárendeléshez.</p>
          <div className="field">
            <label htmlFor="accountSearch">Keresés név vagy e-mail alapján</label>
            <input
              id="accountSearch"
              value={accountSearch}
              onChange={(e) => setAccountSearch(e.target.value)}
              placeholder="Jane…"
              autoComplete="off"
            />
          </div>
          <div className="record-list compact">
            {availableAccounts.map((account) => (
              <button
                key={account.uid}
                type="button"
                className="record-row"
                onClick={() => onLink(account.uid)}
                disabled={pending}
              >
                <span>
                  <strong>{account.displayName || account.email}</strong>
                  <small>{account.email}{account.shibboleth ? ` · ${account.shibboleth}` : ''}</small>
                </span>
              </button>
            ))}
            {availableAccounts.length === 0 && (
              <p className="helper-text">Nincs ilyen leválasztott résztvevői fiók.</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Person QR sub-tab ──────────────────────────────────────────────────────
function PersonQrTab({
  selectedPerson,
  selectedQrCredential,
  unassignedQrCredentials,
  qrInput,
  setQrInput,
  qrScanActive,
  setQrScanActive,
  scannerSupported,
  videoRef,
  pending,
  onAssign,
  onRevoke,
  onError,
}) {
  const isAssigned = Boolean(selectedPerson.assignedQrId || selectedPerson.qrCodeId)

  return (
    <div className="stack-block" style={{ gap: '14px' }}>
      {isAssigned ? (
        <>
          <div className="qr-credential-card">
            <div className="qr-code-value">{selectedQrCredential?.code || selectedPerson.assignedQrId || selectedPerson.qrCodeId}</div>
            <div className="qr-link-value">{selectedQrCredential?.link || '—'}</div>
            <ul className="detail-list" style={{ fontSize: '0.8rem', marginTop: '4px' }}>
              <li><strong>Állapot</strong> <span style={{ textTransform: 'capitalize' }}>{getStatusLabel(selectedQrCredential?.status || 'assigned')}</span></li>
              <li><strong>Hozzárendelve</strong> <span>{formatTimestamp(selectedQrCredential?.assignedAt)}</span></li>
            </ul>
          </div>
          <div className="button-row">
            <button type="button" className="danger-button" onClick={onRevoke} disabled={pending}>
              QR azonosító visszavonása
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="helper-text">Nincs QR azonosító hozzárendelve. Válassz egyet a lenti készletből, olvass be egy fizikai QR-t, vagy írd be kézzel.</p>

          <div className="lookup-toolbar">
            <input
              id="qrValue"
              value={qrInput}
              onChange={(e) => setQrInput(e.target.value)}
              placeholder="4 jegyű kód vagy QR link"
            />
            <button
              type="button"
              className={`icon-button${qrScanActive ? ' active' : ''}`}
              onClick={() => {
                if (!scannerSupported) {
                  onError('A kamerás QR-beolvasás nem támogatott ezen az eszközön.')
                  return
                }
                setQrScanActive((v) => !v)
              }}
              aria-label={qrScanActive ? 'Beolvasó bezárása' : 'QR beolvasása'}
              title={qrScanActive ? 'Beolvasó bezárása' : 'QR beolvasása'}
              disabled={pending}
            >
              <CameraIcon />
            </button>
          </div>

          {qrScanActive && (
            <div className="camera-panel">
              <video ref={videoRef} className="camera-preview" playsInline muted />
            </div>
          )}

          <div className="button-row">
            <button
              type="button"
              className="primary-button"
              onClick={() => onAssign()}
              disabled={pending || !qrInput.trim()}
            >
              Kézi hozzárendelés
            </button>
          </div>

          {unassignedQrCredentials.length > 0 && (
            <>
              <p className="helper-text" style={{ marginBottom: 0 }}>
                Vagy válassz a szabad készletből ({unassignedQrCredentials.length} elérhető):
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '200px', overflowY: 'auto' }}>
                {unassignedQrCredentials.slice(0, 20).map((cred) => (
                  <button
                    key={cred.id}
                    type="button"
                    className="pool-credential-row"
                    onClick={() => onAssign(cred.code)}
                    disabled={pending}
                  >
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, letterSpacing: '0.12em' }}>{cred.code}</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }}>
                      {cred.link || 'link előkészítés alatt'}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {unassignedQrCredentials.length === 0 && (
            <StatusCard
              title="Nincs szabad azonosító"
              tone="warning"
              body="Először generálj egy új adagot a QR Pool fülön."
            />
          )}
        </>
      )}
    </div>
  )
}

// ── Person Balance sub-tab ─────────────────────────────────────────────────
function PersonBalanceTab({
  selectedPerson,
  customTopupAmount,
  setCustomTopupAmount,
  manualAmount,
  setManualAmount,
  manualReason,
  setManualReason,
  pending,
  onQuickTopup,
  onCustomTopup,
  onManualAdjustment,
  allowManualAdjustment = true,
}) {
  return (
    <div className="stack-block" style={{ gap: '20px' }}>
      <div style={{ textAlign: 'center', padding: '16px 0' }}>
        <div className="balance-label">Aktuális egyenleg</div>
        <div className="balance-value">{formatHuf(selectedPerson.balance || 0)}</div>
      </div>

      <div>
        <p className="helper-text" style={{ marginBottom: '10px' }}>Gyors feltöltés</p>
        <div className="button-row">
          {quickTopupAmounts.map((amount) => (
            <button
              key={amount}
              type="button"
              className="secondary-button"
              onClick={() => onQuickTopup(amount)}
              disabled={pending}
            >
              +{formatHuf(amount)}
            </button>
          ))}
        </div>
      </div>

      <div className="stack-block" style={{ gap: '10px' }}>
        <p className="helper-text" style={{ marginBottom: 0 }}>Egyedi feltöltés</p>
        <div className="field">
          <label htmlFor="customTopup">Összeg (HUF)</label>
          <input
            id="customTopup"
            value={customTopupAmount}
            onChange={(e) => setCustomTopupAmount(e.target.value)}
            placeholder="pl. 3500"
          />
        </div>
        <div className="button-row">
          <button type="button" className="primary-button" onClick={onCustomTopup} disabled={pending}>
            Feltöltés jóváírása
          </button>
        </div>
      </div>

      {allowManualAdjustment ? (
      <div className="stack-block" style={{ gap: '10px', paddingTop: '4px', borderTop: '1px dashed var(--border)' }}>
        <p className="helper-text" style={{ marginBottom: 0 }}>Kézi korrekció (negatív is lehet)</p>
        <div className="field">
          <label htmlFor="manualAmount">Összeg (HUF)</label>
          <input
            id="manualAmount"
            value={manualAmount}
            onChange={(e) => setManualAmount(e.target.value)}
            placeholder="-500 vagy 1000"
          />
        </div>
        <div className="field">
          <label htmlFor="manualReason">Indoklás (opcionális)</label>
          <input
            id="manualReason"
            value={manualReason}
            onChange={(e) => setManualReason(e.target.value)}
            placeholder="Készpénz korrekció, esemény bónusz..."
          />
        </div>
        <div className="button-row">
          <button type="button" className="primary-button" onClick={onManualAdjustment} disabled={pending}>
            Korrekció jóváírása
          </button>
        </div>
      </div>
      ) : null}
    </div>
  )
}

// ── QR rendering helpers ───────────────────────────────────────────────────
function QrImage({ value, size = 160 }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    if (!value || !canvasRef.current) return
    QRCode.toCanvas(canvasRef.current, value, {
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
    }).catch(console.error)
  }, [value, size])

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{ display: 'block', borderRadius: 4 }}
    />
  )
}

function QrPoolRow({ cred, pending = false, onDelete = null }) {
  const [expanded, setExpanded] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const value = buildQrCredentialLink(cred.code) || cred.link || cred.code

  async function handleDownload() {
    if (!value) return
    setDownloading(true)
    try {
      const dataUrl = await QRCode.toDataURL(value, { width: 512, margin: 2, errorCorrectionLevel: 'M' })
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `qr-${cred.code}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (error) {
      console.error('QR letöltés sikertelen', error)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className={`qr-pool-row${expanded ? ' expanded' : ''}`}>
      <div className="qr-pool-row-main">
        <span className="qr-pool-row-info">
          <strong>{cred.code}</strong>
          <small>{value || 'Link előkészítés alatt'}</small>
        </span>
        <span className="qr-pool-row-actions">
          <button
            type="button"
            className="secondary-button btn-sm"
            onClick={() => setExpanded((v) => !v)}
            disabled={!value}
          >
            {expanded ? 'Elrejtés' : 'Megnyitás'}
          </button>
          <button
            type="button"
            className="secondary-button btn-sm"
            onClick={handleDownload}
            disabled={downloading || !value}
          >
            {downloading ? '…' : '↓ PNG'}
          </button>
          {onDelete ? (
            <button
              type="button"
              className="danger-button btn-sm"
              onClick={() => onDelete(cred)}
              disabled={pending}
              title="QR azonosító törlése"
            >
              Törlés
            </button>
          ) : null}
        </span>
      </div>
      {expanded && value ? (
        <div className="qr-inline-view">
          <QrImage value={value} size={160} />
          <span className="qr-inline-code">{cred.code}</span>
        </div>
      ) : null}
    </div>
  )
}

// Available print sizes — first entry is the default (1.5 cm).
const QR_PRINT_SIZES_MM = [10, 15, 20, 25, 30, 40, 50]
const QR_PRINT_DEFAULT_MM = 15

function buildPrintHtml(items, sizeMm = QR_PRINT_DEFAULT_MM) {
  // A4 portrait: 210mm wide with 10mm margin each side → 190mm usable.
  const usableMm = 190
  const gapMm = 2.5
  const cols = Math.max(1, Math.floor((usableMm + gapMm) / (sizeMm + gapMm)))
  // Scale the label proportionally to the QR size so it stays readable.
  const labelPt = Math.max(5, Math.min(14, Math.round(sizeMm * 0.45)))
  const labelMarginMm = Math.max(0.6, sizeMm * 0.06).toFixed(2)

  // Basic HTML escape so person names with quotes/angle brackets don't break markup.
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

  // Estimate the largest font size at which `name` fits inside `widthMm` on a
  // single line. Uses an avg Arial glyph width of ~0.55em and 1pt ≈ 0.3528mm,
  // with a small safety factor (×0.95) so wider-than-average names (W/M-heavy)
  // still fit. Never exceeds the default label size, and bottoms out at 3pt
  // so it remains at least somewhat legible.
  const fitNameFontPt = (name, widthMm, defaultPt) => {
    if (!name) return defaultPt
    const avgGlyphEm = 0.55
    const ptToMm = 0.3528
    const safety = 0.95
    const maxPt = (widthMm * safety) / (name.length * avgGlyphEm * ptToMm)
    return Math.max(3, Math.min(defaultPt, maxPt))
  }

  const cells = items
    .map(({ code, dataUrl, name }) => {
      let nameLine = ''
      if (name) {
        const nameFontPt = fitNameFontPt(name, sizeMm, labelPt).toFixed(2)
        nameLine = `<div class="name" style="font-size:${nameFontPt}pt">${esc(name)}</div>`
      }
      return `<div class="cell"><img src="${dataUrl}" alt="${esc(code)}"><div class="lbl">${esc(code)}</div>${nameLine}</div>`
    })
    .join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>QR Codes — ${items.length} codes (${sizeMm}mm)</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #fff; }
  .grid {
    display: grid;
    grid-template-columns: repeat(${cols}, ${sizeMm}mm);
    gap: ${gapMm}mm;
  }
  .cell {
    break-inside: avoid;
    text-align: center;
  }
  .cell img {
    width: ${sizeMm}mm;
    height: ${sizeMm}mm;
    display: block;
  }
  .lbl {
    font-size: ${labelPt}pt;
    font-family: 'Courier New', monospace;
    letter-spacing: 0.04em;
    margin-top: ${labelMarginMm}mm;
    line-height: 1.2;
  }
  .name {
    /* font-size is set inline per-cell so each name shrinks just enough to fit */
    font-family: Arial, sans-serif;
    font-weight: 600;
    margin-top: 0.4mm;
    line-height: 1.1;
    white-space: nowrap;
    max-width: ${sizeMm}mm;
  }
</style>
</head>
<body><div class="grid">${cells}</div></body>
</html>`
}

// ── QR Pool tab ────────────────────────────────────────────────────────────
function QrPoolTab({
  qrCredentials,
  unassignedQrCredentials,
  assignedQrCredentials,
  revokedQrCredentials,
  peopleById,
  qrManualInput,
  setQrManualInput,
  qrImportText,
  setQrImportText,
  qrImportFileRef,
  qrGenerationCount,
  setQrGenerationCount,
  pending,
  onGenerateBatch,
  onManualAdd,
  onImportText,
  onImportFile,
  onExportUnused,
  onDeleteCredential,
}) {
  // Single loading key: 'unassigned' | 'assigned' | null — only one print
  // job runs at a time and the right button shows its own spinner state.
  const [printingKey, setPrintingKey] = useState(null)
  const [printSizeMm, setPrintSizeMm] = useState(QR_PRINT_DEFAULT_MM)
  const [printIncludeNames, setPrintIncludeNames] = useState(false)
  const assignedCount = assignedQrCredentials.length

  async function handlePrintList(creds, key) {
    const eligible = creds.filter((c) => c.link || c.code)
    if (!eligible.length) return
    setPrintingKey(key)
    try {
      // Render the QR PNG at ~20px per printed mm so larger sizes stay crisp
      // (≈500dpi source). Floor at 200px so the smallest size isn't blurry.
      const renderPx = Math.max(200, Math.round(printSizeMm * 20))
      const items = await Promise.all(
        eligible.map(async (cred) => {
          const value = buildQrCredentialLink(cred.code) || cred.link || cred.code
          const dataUrl = await QRCode.toDataURL(value, { width: renderPx, margin: 1, errorCorrectionLevel: 'M' })
          // Only attach a name when the checkbox is on AND the credential is linked
          // to a person we have in memory. Unlinked entries print code-only as before.
          const person = printIncludeNames && cred.assignedPersonaId
            ? peopleById?.get(cred.assignedPersonaId)
            : null
          const name = person?.displayName || null
          return { code: cred.code, dataUrl, name }
        }),
      )
      const html = buildPrintHtml(items, printSizeMm)
      const win = window.open('', '_blank', 'width=900,height=700')
      if (!win) return
      win.document.write(html)
      win.document.close()
      win.focus()
      setTimeout(() => win.print(), 400)
    } catch (error) {
      console.error('Nyomtatás sikertelen', error)
    } finally {
      setPrintingKey(null)
    }
  }

  function renderPrintSizePicker(idSuffix) {
    return (
      <label
        style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: 'var(--muted)' }}
        htmlFor={`qrPrintSize-${idSuffix}`}
      >
        Méret
        <select
          id={`qrPrintSize-${idSuffix}`}
          value={printSizeMm}
          onChange={(e) => setPrintSizeMm(Number(e.target.value))}
          disabled={printingKey !== null}
          style={{ padding: '4px 6px', fontSize: '0.8rem' }}
        >
          {QR_PRINT_SIZES_MM.map((mm) => (
            <option key={mm} value={mm}>
              {(mm / 10).toFixed(mm % 10 === 0 ? 0 : 1)} cm
            </option>
          ))}
        </select>
      </label>
    )
  }

  return (
    <div className="stack-block" style={{ gap: '20px' }}>
      {/* Stats */}
      <div className="detail-grid">
        <span className="event-pill" style={{ background: 'color-mix(in srgb, var(--success) 10%, transparent)', borderColor: '#86efac', color: '#15803d' }}>
          Hozzárendelve: {assignedCount}
        </span>
        <span className="event-pill" style={{ background: '#fefce8', borderColor: '#fde047', color: '#92400e' }}>
          Szabad: {unassignedQrCredentials.length}
        </span>
        <span className="event-pill" style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
          Visszavonva: {revokedQrCredentials.length}
        </span>
        <span className="event-pill">
          Összesen: {qrCredentials.length}
        </span>
      </div>

      {/* Generate batch */}
      <section className="panel">
        <h4 className="card-title">Új adag generálása</h4>
        <p className="helper-text">
          N darab szabad QR azonosítót hoz létre. Ezeket később egyenként lehet personákhoz rendelni.
        </p>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '12px' }}>
          <div className="field" style={{ margin: 0, flex: '0 0 120px' }}>
            <label htmlFor="qrBatchCount">Darab</label>
            <input
              id="qrBatchCount"
              value={qrGenerationCount}
              onChange={(e) => setQrGenerationCount(e.target.value)}
              placeholder="20"
              type="number"
              min="1"
              max="200"
            />
          </div>
          <button type="button" className="primary-button" onClick={onGenerateBatch} disabled={pending}>
            QR azonosítók generálása
          </button>
        </div>
      </section>

      <section className="panel">
        <h4 className="card-title">Kézi QR hozzáadás / import</h4>
        <p className="helper-text">
          4 jegyű kódokat vagy QR linkeket adhatsz meg. Beillesztésnél szóköz, vessző, pontosvessző vagy sortörés is használható.
        </p>
        <div className="form-grid" style={{ marginTop: '12px' }}>
          <div className="field">
            <label htmlFor="qrManualInput">Kézi kódok</label>
            <input
              id="qrManualInput"
              value={qrManualInput}
              onChange={(event) => setQrManualInput(event.target.value)}
              placeholder="1234 vagy https://kasszaserzsi.hu/qr/1234"
              disabled={pending}
            />
          </div>
          <div className="button-row">
            <button type="button" className="primary-button" onClick={onManualAdd} disabled={pending || !qrManualInput.trim()}>
              Kód hozzáadása
            </button>
          </div>
          <div className="field">
            <label htmlFor="qrImportText">Lista import</label>
            <textarea
              id="qrImportText"
              className="text-area"
              value={qrImportText}
              onChange={(event) => setQrImportText(event.target.value)}
              placeholder={'1234\nhttps://kasszaserzsi.hu/qr/5678'}
              rows={5}
              disabled={pending}
            />
          </div>
          <div className="button-row">
            <button type="button" className="secondary-button" onClick={onImportText} disabled={pending || !qrImportText.trim()}>
              Lista importálása
            </button>
            <button type="button" className="secondary-button" onClick={() => qrImportFileRef.current?.click()} disabled={pending}>
              Excel import
            </button>
            <input
              ref={qrImportFileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={onImportFile}
              style={{ display: 'none' }}
            />
          </div>
        </div>
      </section>

      {/* Unassigned pool */}
      <section className="panel">
        <div className="split-header" style={{ marginBottom: '10px' }}>
          <div>
            <h4 className="card-title">Szabad készlet ({unassignedQrCredentials.length})</h4>
            <p className="helper-text">Personához rendelhető azonosítók.</p>
          </div>
          <button
            type="button"
            className="secondary-button btn-sm"
            onClick={onExportUnused}
            disabled={pending || unassignedQrCredentials.length === 0}
            title="Szabad QR kódok exportálása Excelbe"
          >
            Export
          </button>
          {unassignedQrCredentials.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {renderPrintSizePicker('unassigned')}
              <button
                type="button"
                className="secondary-button btn-sm"
                onClick={() => handlePrintList(unassignedQrCredentials, 'unassigned')}
                disabled={printingKey !== null}
                title="Nyomtatható A4-es lap generálása az összes szabad QR kóddal"
              >
                {printingKey === 'unassigned' ? 'Generálás...' : 'Nyomtatási lap'}
              </button>
            </div>
          ) : null}
        </div>
        <div className="qr-pool-list">
          {unassignedQrCredentials.map((cred) => (
            <QrPoolRow key={cred.id} cred={cred} pending={pending} onDelete={onDeleteCredential} />
          ))}
          {unassignedQrCredentials.length === 0 && (
            <p className="helper-text">Nincs szabad azonosító. Generálj egy új adagot fent.</p>
          )}
        </div>
      </section>

      {/* Assigned (taken) pool — same view & print flow as the free pool */}
      <section className="panel">
        <div className="split-header" style={{ marginBottom: '10px' }}>
          <div>
            <h4 className="card-title">Foglalt készlet ({assignedQrCredentials.length})</h4>
            <p className="helper-text">Personához már hozzárendelt azonosítók.</p>
          </div>
          {assignedQrCredentials.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <label
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: 'var(--muted)' }}
              >
                <input
                  type="checkbox"
                  checked={printIncludeNames}
                  onChange={(e) => setPrintIncludeNames(e.target.checked)}
                  disabled={printingKey !== null}
                />
                Nevekkel
              </label>
              {renderPrintSizePicker('assigned')}
              <button
                type="button"
                className="secondary-button btn-sm"
                onClick={() => handlePrintList(assignedQrCredentials, 'assigned')}
                disabled={printingKey !== null}
                title="Nyomtatható A4-es lap generálása az összes foglalt QR kóddal"
              >
                {printingKey === 'assigned' ? 'Generálás...' : 'Nyomtatási lap'}
              </button>
            </div>
          ) : null}
        </div>
        <div className="qr-pool-list">
          {assignedQrCredentials.map((cred) => (
            <QrPoolRow key={cred.id} cred={cred} />
          ))}
          {assignedQrCredentials.length === 0 && (
            <p className="helper-text">Még nincs foglalt azonosító.</p>
          )}
        </div>
      </section>

      {/* Revoked */}
      <section className="panel">
        <h4 className="card-title" style={{ marginBottom: '6px' }}>Visszavont azonosítók ({revokedQrCredentials.length})</h4>
        <p className="helper-text" style={{ marginBottom: '10px' }}>Végleg inaktivált azonosítók, nem rendelhetők újra.</p>
        <div className="qr-pool-list">
          {revokedQrCredentials.map((cred) => (
            <QrPoolRow key={cred.id} cred={cred} pending={pending} onDelete={onDeleteCredential} />
          ))}
          {revokedQrCredentials.length === 0 && (
            <p className="helper-text">Nincs visszavont azonosító.</p>
          )}
        </div>
      </section>
    </div>
  )
}

// ── Main export ────────────────────────────────────────────────────────────
export function PeopleManagementPanel({ eventId, actorUid, view = 'personas', allowManualAdjustment = true }) {
  const [people, setPeople] = useState([])
  const [accounts, setAccounts] = useState([])
  const [qrCredentials, setQrCredentials] = useState([])
  const [importText, setImportText] = useState('')
  const [importFeedback, setImportFeedback] = useState(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [selectedPersonId, setSelectedPersonId] = useState(null)
  const [editState, setEditState] = useState(emptyEditState)
  const [accountSearch, setAccountSearch] = useState('')
  const [personaSearch, setPersonaSearch] = useState('')
  const [qrInput, setQrInput] = useState('')
  const [qrScanActive, setQrScanActive] = useState(false)
  const [qrGenerationCount, setQrGenerationCount] = useState('20')
  const [qrManualInput, setQrManualInput] = useState('')
  const [qrImportText, setQrImportText] = useState('')
  const [customTopupAmount, setCustomTopupAmount] = useState('')
  const [manualAmount, setManualAmount] = useState('')
  const [manualReason, setManualReason] = useState('')
  const [showDeleted, setShowDeleted] = useState(false)
  const [pending, setPending] = useState(false)
  const [activePersonTab, setActivePersonTab] = useState('profile')
  const activeTopTab = view === 'qrpool' ? 'qrpool' : view === 'topup' ? 'topup' : 'personas'
  const isPersonaScannerView = activeTopTab === 'personas' || activeTopTab === 'topup'
  const selectedPersonTargetTabRef = useRef('profile')
  const personaQrAutoSelectRef = useRef('')
  const keyboardScannerBufferRef = useRef('')
  const keyboardScannerLastKeyAtRef = useRef(0)
  const keyboardScannerFlushTimerRef = useRef(null)
  const hiddenPersonaScannerInputRef = useRef(null)
  const qrImportFileRef = useRef(null)

  useEffect(() => {
    return subscribeToPeople(eventId, setPeople, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    return subscribeToAccountsDirectory(setAccounts, (error) => setErrorMessage(error.message))
  }, [])

  useEffect(() => {
    if (activeTopTab === 'topup') {
      setQrCredentials([])
      return undefined
    }

    return subscribeToQrCredentials(eventId, setQrCredentials, (error) => setErrorMessage(error.message))
  }, [activeTopTab, eventId])

  const visiblePeople = useMemo(() => {
    return people
      .filter((person) => showDeleted || person.recordStatus !== PERSON_RECORD_STATUSES.deleted)
      .toSorted((a, b) => huCollator.compare(a.displayName || '', b.displayName || ''))
  }, [people, showDeleted])

  const filteredVisiblePeople = useMemo(() => {
    const search = personaSearch.trim().toLowerCase()
    if (!search) return visiblePeople

    return visiblePeople.filter((person) => {
      const haystack = [
        person.displayName,
        person.team,
        person.attendeeType,
        person.shibboleth,
        person.internalId,
        person.assignedQrId,
        person.qrCodeId,
        person.assignedQrLink,
        getPersonDisplayId(person),
      ].filter(Boolean).join(' ').toLowerCase()

      return haystack.includes(search)
    })
  }, [personaSearch, visiblePeople])

  const selectedPerson = useMemo(() => {
    return people.find((person) => person.id === selectedPersonId) || null
  }, [people, selectedPersonId])

  const linkedAccountIds = useMemo(() => {
    return new Set(
      people
        .map((person) => person.linkedAccountId || person.linkedAuthUid)
        .filter(Boolean),
    )
  }, [people])

  const userAccounts = useMemo(() => {
    return accounts.filter((account) => account.role === 'user' && account.status === 'active')
  }, [accounts])

  const availableAccounts = useMemo(() => {
    const search = accountSearch.trim().toLowerCase()
    const selectedLinkedAccountId = selectedPerson?.linkedAccountId || selectedPerson?.linkedAuthUid || null

    return userAccounts.filter((account) => {
      const isLinkedElsewhere = linkedAccountIds.has(account.uid) && account.uid !== selectedLinkedAccountId
      if (isLinkedElsewhere) return false
      if (!search) return true
      const haystack = `${account.displayName || ''} ${account.email || ''} ${account.shibboleth || ''}`.toLowerCase()
      return haystack.includes(search)
    }).slice(0, 8)
  }, [accountSearch, linkedAccountIds, selectedPerson, userAccounts])

  const unlinkedAccounts = useMemo(() => {
    return userAccounts.filter((account) => !linkedAccountIds.has(account.uid))
  }, [linkedAccountIds, userAccounts])

  const unassignedQrCredentials = useMemo(() => {
    return qrCredentials.filter((credential) => credential.status === QR_CREDENTIAL_STATUSES.unassigned)
  }, [qrCredentials])

  const assignedQrCredentials = useMemo(() => {
    return qrCredentials.filter((credential) => credential.status === QR_CREDENTIAL_STATUSES.assigned)
  }, [qrCredentials])

  const peopleById = useMemo(() => {
    const map = new Map()
    people.forEach((person) => map.set(person.id, person))
    return map
  }, [people])

  const revokedQrCredentials = useMemo(() => {
    return qrCredentials.filter((credential) => credential.status === QR_CREDENTIAL_STATUSES.revoked)
  }, [qrCredentials])

  const selectedQrCredential = useMemo(() => {
    const qrCode = selectedPerson?.assignedQrId || selectedPerson?.qrCodeId || null
    if (!qrCode) return null
    return qrCredentials.find((credential) => credential.code === qrCode || credential.id === qrCode) || null
  }, [qrCredentials, selectedPerson])

  const linkedAccount = useMemo(() => {
    const uid = selectedPerson?.linkedAccountId || selectedPerson?.linkedAuthUid
    if (!uid) return null
    return accounts.find((a) => a.uid === uid) || null
  }, [accounts, selectedPerson])

  const findPersonByQrCode = useCallback((qrCode) => {
    return people.find((person) => {
      return person.assignedQrId === qrCode
        || person.qrCodeId === qrCode
        || person.assignedQrLink?.includes(`/qr/${qrCode}`)
    }) || null
  }, [people])

  const personaCounts = useMemo(() => {
    return visiblePeople.reduce((summary, person) => {
      const completeness = buildPersonaCompleteness(person)
      summary[completeness] += 1
      return summary
    }, { complete: 0, partial: 0, incomplete: 0 })
  }, [visiblePeople])

  const { videoRef, scannerSupported } = useQrScanner({
    active: qrScanActive,
    onDetected: async (rawValue) => {
      if (!selectedPerson) return
      setQrInput(rawValue)
      setQrScanActive(false)
      await handleAssignQr(rawValue)
    },
    onError: (error) => {
      setQrScanActive(false)
      setErrorMessage(error.message || 'Camera QR scanning is not available on this device.')
    },
  })

  const selectPerson = useCallback((personId, targetTab = 'profile') => {
    selectedPersonTargetTabRef.current = targetTab
    setSelectedPersonId(personId)

    if (personId === selectedPersonId) {
      setActivePersonTab(targetTab)
    }
  }, [selectedPersonId])

  const focusHiddenPersonaScannerInput = useCallback((force = false) => {
    if (!isPersonaScannerView || qrScanActive) {
      return
    }

    const activeElement = document.activeElement
    const hiddenInput = hiddenPersonaScannerInputRef.current
    const tagName = activeElement?.tagName?.toLowerCase()
    const activeElementIsTextEntry = tagName === 'input' || tagName === 'textarea' || tagName === 'select' || activeElement?.isContentEditable

    if (!hiddenInput || activeElement === hiddenInput || (!force && activeElementIsTextEntry)) {
      return
    }

    hiddenInput.focus({ preventScroll: true })
  }, [isPersonaScannerView, qrScanActive])

  const trySelectPersonaFromQr = useCallback((rawValue) => {
    const trimmedValue = String(rawValue || '').trim()
    if (!trimmedValue || pending) {
      return false
    }

    let normalizedQr = ''
    try {
      normalizedQr = normalizeQrInput(trimmedValue)
    } catch {
      return false
    }

    if (personaQrAutoSelectRef.current === normalizedQr) {
      return true
    }

    personaQrAutoSelectRef.current = normalizedQr
    setErrorMessage('')
    setStatusMessage('')

    const cachedPerson = findPersonByQrCode(normalizedQr)
    if (cachedPerson) {
      selectPerson(cachedPerson.id, 'balance')
      setPersonaSearch('')
      personaQrAutoSelectRef.current = ''
      window.setTimeout(() => focusHiddenPersonaScannerInput(true), 0)
      return true
    }

    ;(async () => {
      try {
        const result = await resolveAssignedQrToPerson({ eventId, qrInput: normalizedQr })
        const person = result?.person

        if (!person?.id) {
          throw new Error('A QR kód nem található az aktív eseményben.')
        }

        selectPerson(person.id, 'balance')
        setPersonaSearch('')
      } catch (error) {
        setErrorMessage(normalizeFunctionError(error, 'A QR kód nem található az aktív eseményben.'))
      } finally {
        personaQrAutoSelectRef.current = ''
        window.setTimeout(() => focusHiddenPersonaScannerInput(true), 0)
      }
    })()

    return true
  }, [eventId, findPersonByQrCode, focusHiddenPersonaScannerInput, pending, selectPerson])

  useEffect(() => {
    trySelectPersonaFromQr(personaSearch)
  }, [personaSearch, trySelectPersonaFromQr])

  useEffect(() => {
    const focusTimer = window.setTimeout(focusHiddenPersonaScannerInput, 0)
    const scheduleScannerFocus = () => window.setTimeout(focusHiddenPersonaScannerInput, 0)

    window.addEventListener('pointerup', scheduleScannerFocus)
    window.addEventListener('focus', scheduleScannerFocus)

    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('pointerup', scheduleScannerFocus)
      window.removeEventListener('focus', scheduleScannerFocus)
    }
  }, [focusHiddenPersonaScannerInput, selectedPersonId])

  useEffect(() => {
    if (!isPersonaScannerView) {
      return undefined
    }

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
        trySelectPersonaFromQr(bufferedValue)
      }
    }

    function isTextEntryElement(element) {
      const tagName = element?.tagName?.toLowerCase()
      return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || element?.isContentEditable
    }

    function handleGlobalKeyDown(event) {
      if (event.ctrlKey || event.altKey || event.metaKey || qrScanActive || isTextEntryElement(document.activeElement)) {
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

    window.addEventListener('keydown', handleGlobalKeyDown, true)
    return () => {
      clearKeyboardScannerFlushTimer()
      window.removeEventListener('keydown', handleGlobalKeyDown, true)
    }
  }, [isPersonaScannerView, qrScanActive, trySelectPersonaFromQr])

  function handleHiddenPersonaScannerInputBlur() {
    window.setTimeout(focusHiddenPersonaScannerInput, 0)
  }

  function handleHiddenPersonaScannerInputChange(event) {
    const nextValue = event.target.value

    if (trySelectPersonaFromQr(nextValue)) {
      event.target.value = ''
    } else if (nextValue.length > 512) {
      event.target.value = nextValue.slice(-512)
    }
  }

  function handleHiddenPersonaScannerInputKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== 'Tab') {
      return
    }

    const input = event.currentTarget
    if (input.value && trySelectPersonaFromQr(input.value)) {
      event.preventDefault()
      input.value = ''
    }
  }

  // Reset per-person state when selection changes
  useEffect(() => {
    setActivePersonTab(selectedPersonTargetTabRef.current || (activeTopTab === 'topup' ? 'balance' : 'profile'))
    selectedPersonTargetTabRef.current = 'profile'
    setAccountSearch('')
    setQrInput('')
    setQrScanActive(false)
    setManualAmount('')
    setManualReason('')
    setCustomTopupAmount('')
  }, [activeTopTab, selectedPersonId])

  useEffect(() => {
    if (!selectedPerson) {
      setEditState(emptyEditState)
      return
    }
    setEditState(buildSelectedPersonState(selectedPerson))
    setQrInput(selectedPerson.assignedQrId || selectedPerson.qrCodeId || '')
  }, [selectedPerson])

  async function runAction(action, fallbackMessage = 'A művelet sikertelen.') {
    setPending(true)
    setErrorMessage('')
    setStatusMessage('')
    try {
      const result = await action()
      return result
    } catch (error) {
      setErrorMessage(normalizeFunctionError(error, fallbackMessage))
      throw error
    } finally {
      setPending(false)
    }
  }

  async function handleImport(event) {
    event.preventDefault()
    try {
      const result = await runAction(
        () => importPeopleFromText({ eventId, actorUid, text: importText }),
        'Az importálás sikertelen.',
      )
      setImportFeedback(result)
      setImportText('')
      setStatusMessage(`${result.importedCount} persona importálva. Áthozott egyenleg alkalmazva: ${result.carryoverAppliedCount || 0}.`)
    } catch { /* handled */ }
  }

  async function handleExcelImport(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const rows = parsePersonaExcelRows(workbook)

      if (!rows.length) {
        setErrorMessage('Excel import sikertelen: az első munkalapon nincs sor.')
        return
      }

      const result = await runAction(
        () => importPeopleFromRows({ eventId, actorUid, rows }),
        'Excel import sikertelen.',
      )
      setImportFeedback(result)
      setStatusMessage(`${result.importedCount} persona importálva Excelből. Áthozott egyenleg alkalmazva: ${result.carryoverAppliedCount || 0}.`)
    } catch (error) {
      setErrorMessage(error?.message || 'Excel import sikertelen.')
    }
  }

  async function handleSavePerson() {
    if (!selectedPerson) return
    try {
      await runAction(
        () => updatePersonRecord({ eventId, actorUid, personId: selectedPerson.id, ...editState }),
        'A persona mentése sikertelen.',
      )
      setStatusMessage('Persona adatai frissítve.')
    } catch { /* handled */ }
  }

  async function handleDeletePerson() {
    if (!selectedPerson) return
    try {
      await runAction(
        () => deletePersonRecord({ eventId, actorUid, personId: selectedPerson.id }),
        'A persona törlése sikertelen.',
      )
      setStatusMessage('Persona törölve.')
    } catch { /* handled */ }
  }

  async function handleRestorePerson() {
    if (!selectedPerson) return
    try {
      await runAction(
        () => restorePersonRecord({ eventId, actorUid, personId: selectedPerson.id }),
        'A persona visszaállítása sikertelen.',
      )
      setStatusMessage('Persona visszaállítva.')
    } catch { /* handled */ }
  }

  async function handleLinkAccount(linkedAuthUid) {
    if (!selectedPerson) return
    try {
      await runAction(
        () =>
          linkRegisteredUserToPerson({
            eventId,
            personId: selectedPerson.id,
            linkedAuthUid,
            linkedBy: actorUid,
            displayName: selectedPerson.displayName,
            team: selectedPerson.team,
            attendeeType: selectedPerson.attendeeType,
            shibboleth: selectedPerson.shibboleth || '',
          }),
        'A fiók hozzárendelése sikertelen.',
      )
      setStatusMessage(linkedAuthUid ? 'Fiók hozzárendelve a personához.' : 'Fiók leválasztva.')
    } catch { /* handled */ }
  }

  async function handleGenerateQrBatch() {
    const count = Number.parseInt(qrGenerationCount, 10)
    if (!Number.isInteger(count) || count <= 0) {
      setErrorMessage('A QR adag darabszámának pozitív egész számnak kell lennie.')
      return
    }
    try {
      const result = await runAction(
        () => generateQrCredentials({ eventId, count }),
        'A QR azonosítók generálása sikertelen.',
      )
      setStatusMessage(`${result.count} szabad QR azonosító generálva.`)
    } catch { /* handled */ }
  }

  async function importQrCodeList(codes, successPrefix) {
    if (!codes.length) {
      setErrorMessage('Nincs importálható QR kód.')
      return null
    }

    try {
      const result = await runAction(
        () => importQrCredentials({ eventId, codes }),
        'A QR import sikertelen.',
      )
      setStatusMessage(`${successPrefix}: ${result.count} QR hozzáadva, ${result.skippedCount || 0} kihagyva.`)
      return result
    } catch {
      return null
    }
  }

  async function handleManualQrAdd() {
    const result = await importQrCodeList(splitQrImportInput(qrManualInput), 'Kézi QR hozzáadás')
    if (result) {
      setQrManualInput('')
    }
  }

  async function handleQrTextImport() {
    const result = await importQrCodeList(splitQrImportInput(qrImportText), 'QR lista import')
    if (result) {
      setQrImportText('')
    }
  }

  async function handleQrExcelImport(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      await importQrCodeList(parseQrExcelCodes(workbook), 'QR Excel import')
    } catch (error) {
      setErrorMessage(error?.message || 'QR Excel import sikertelen.')
    }
  }

  function handleExportUnusedQrs() {
    if (!unassignedQrCredentials.length) {
      setErrorMessage('Nincs exportálható szabad QR.')
      return
    }

    const rows = unassignedQrCredentials.map((credential) => ({
      Code: credential.code || '',
      Link: credential.link || buildQrCredentialLink(credential.code) || '',
      Status: credential.status || QR_CREDENTIAL_STATUSES.unassigned,
    }))
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: ['Code', 'Link', 'Status'] })
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Unused QRs')
    const stamp = new Date().toISOString().slice(0, 10)
    XLSX.writeFile(workbook, `unused-qrs-${eventId}-${stamp}.xlsx`)
    setStatusMessage(`${rows.length} szabad QR exportálva.`)
  }

  async function handleDeleteQrCredential(credential) {
    if (!credential?.code) return
    const confirmed = window.confirm(`${credential.code} QR azonosító törlése?`)
    if (!confirmed) return

    try {
      await runAction(
        () => deleteQrCredential({ eventId, qrInput: credential.code }),
        'A QR azonosító törlése sikertelen.',
      )
      setStatusMessage(`${credential.code} QR azonosító törölve.`)
    } catch { /* handled */ }
  }

  async function handleAssignQr(rawValue = qrInput) {
    if (!selectedPerson) return
    try {
      const result = await runAction(
        () => assignQrToPerson({ eventId, personId: selectedPerson.id, qrInput: rawValue }),
        'A QR azonosító hozzárendelése sikertelen.',
      )
      const code = result?.credential?.code || `${rawValue}`.trim()
      setQrInput(code)
      setStatusMessage(`${code} QR azonosító hozzárendelve.`)
    } catch { /* handled */ }
  }

  async function handleRevokeQr() {
    if (!selectedPerson) return
    try {
      await runAction(
        () => revokeQrForPerson({ eventId, personId: selectedPerson.id }),
        'A QR azonosító visszavonása sikertelen.',
      )
      setQrInput('')
      setStatusMessage('QR azonosító visszavonva.')
    } catch { /* handled */ }
  }

  async function handleQuickTopup(amount) {
    if (!selectedPerson) return
    try {
      await runAction(
        () => topUpPersonBalance({ eventId, actorUid, personId: selectedPerson.id, amount }),
        'A feltöltés sikertelen.',
      )
      setStatusMessage(`${formatHuf(amount)} feltöltés jóváírva.`)
    } catch { /* handled */ }
  }

  async function handleCustomTopup() {
    if (!selectedPerson) return
    const amount = parseHufInteger(customTopupAmount)
    if (!Number.isInteger(amount) || amount <= 0) {
      setErrorMessage('Az egyedi feltöltés összegének pozitív egész HUF értéknek kell lennie.')
      return
    }
    try {
      await runAction(
        () => topUpPersonBalance({ eventId, actorUid, personId: selectedPerson.id, amount }),
        'Az egyedi feltöltés sikertelen.',
      )
      setCustomTopupAmount('')
      setStatusMessage(`${formatHuf(amount)} egyedi feltöltés jóváírva.`)
    } catch { /* handled */ }
  }

  function handleExportPersonas() {
    if (visiblePeople.length === 0) {
      setErrorMessage('Nincs exportálható persona.')
      return
    }
    try {
      const rows = visiblePeople.map((person) => ({
        Nev: person.displayName || '',
        Csapat: person.team || '',
        Tipus: getAttendeeTypeLabel(person.attendeeType),
        Shibboleth: person.shibboleth || '',
      }))
      const sheet = XLSX.utils.json_to_sheet(rows, {
        header: ['Nev', 'Csapat', 'Tipus', 'Shibboleth'],
      })
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, sheet, 'Personas')
      const stamp = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(workbook, `personas-${eventId}-${stamp}.xlsx`)
      setStatusMessage(`${rows.length} persona exportálva.`)
    } catch (error) {
      setErrorMessage(error?.message || 'Persona export sikertelen.')
    }
  }

  async function handleManualAdjustment() {
    if (!selectedPerson) return
    const amount = parseHufInteger(manualAmount)
    if (!Number.isInteger(amount) || amount === 0) {
      setErrorMessage('A kézi korrekció összegének nullától eltérő egész HUF értéknek kell lennie.')
      return
    }
    try {
      await runAction(
        () => adjustPersonBalance({ eventId, actorUid, personId: selectedPerson.id, amount, reason: manualReason }),
        'A kézi egyenlegkorrekció sikertelen.',
      )
      setManualAmount('')
      setManualReason('')
      setStatusMessage('Kézi egyenlegkorrekció jóváírva.')
    } catch { /* handled */ }
  }

  const personSubTabs = [
    { id: 'profile', label: 'Profil' },
    { id: 'account', label: 'Fiók' },
    { id: 'qr', label: 'QR' },
    { id: 'balance', label: 'Egyenleg' },
  ]

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="admin-section">
      {/* Banners */}
      {errorMessage ? <div className="error-banner" style={{ marginBottom: '12px' }}>{errorMessage}</div> : null}
      {statusMessage ? <div className="status-inline" style={{ marginBottom: '12px' }}>{statusMessage}</div> : null}

      {isPersonaScannerView ? (
        <input
          ref={hiddenPersonaScannerInputRef}
          className="pos-hidden-scanner-input"
          type="text"
          autoComplete="off"
          inputMode="none"
          aria-hidden="true"
          tabIndex={-1}
          onBlur={handleHiddenPersonaScannerInputBlur}
          onChange={handleHiddenPersonaScannerInputChange}
          onKeyDown={handleHiddenPersonaScannerInputKeyDown}
        />
      ) : null}

      {/* ── PERSONAS TAB ── */}
      {activeTopTab === 'personas' && (
        <>
          {/* Three-column grid */}
          <div className="three-column-grid">
            {/* Col 1: Import */}
            <section className="panel personas-list-panel">
              <h4 className="card-title">Personák importálása</h4>
              <p className="helper-text">
                Soronként egy résztvevő: <strong>név, csapat, típus, shibboleth</strong> (tab, pontosvessző vagy vessző).
              </p>
              <form className="form-grid" onSubmit={handleImport} style={{ marginTop: '12px' }}>
                <div className="field">
                  <label htmlFor="peopleImportExcel">Excel fájl</label>
                  <input
                    id="peopleImportExcel"
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleExcelImport}
                    disabled={pending}
                  />
                  <p className="helper-text">
                    Az első munkalapot használja. A fejléc lehet name, team, type, shibboleth.
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="peopleImport">Sorok beillesztése</label>
                  <textarea
                    id="peopleImport"
                    className="text-area"
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder={'Birtalan Katalin, Shinto wo sasageyo, gólya, birka2'}
                    rows={10}
                  />
                </div>
                <div className="button-row">
                  <button type="submit" className="primary-button" disabled={pending || !importText.trim()}>
                    Importálás
                  </button>
                </div>
              </form>
              {importFeedback && (
                <div className="stack-block" style={{ gap: '8px', marginTop: '12px' }}>
                  <p className="helper-text">
                    {importFeedback.importedCount} sor importálva. Áthozott egyenleg alkalmazva: {importFeedback.carryoverAppliedCount || 0}. Elutasítva: {importFeedback.rejectedRows.length}.
                  </p>
                  {importFeedback.rejectedRows.length > 0 && (
                    <ul className="detail-list">
                      {importFeedback.rejectedRows.slice(0, 5).map((row) => (
                        <li key={`${row.lineNumber}-${row.reason}`}>
                          <strong>{row.lineNumber}. sor</strong>
                          <span>{row.reason}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>

            {/* Col 2: People list */}
            <section className="panel">
              <div className="split-header personas-list-header" style={{ marginBottom: '10px' }}>
                <div className="personas-list-title">
                  <h4 className="card-title">Personák</h4>
                </div>
                <div className="personas-list-actions">
                  <button
                    type="button"
                    className="secondary-button btn-sm"
                    onClick={handleExportPersonas}
                    disabled={visiblePeople.length === 0}
                    title="Personák exportálása Excelbe"
                  >
                    Export
                  </button>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={showDeleted}
                      onChange={(e) => setShowDeleted(e.target.checked)}
                    />
                    <span style={{ fontSize: '0.78rem' }}>Töröltek</span>
                  </label>
                </div>
              </div>
              <div className="personas-counter-strip" aria-label="Persona számlálók">
                <span className="event-pill personas-counter-pill complete">C {personaCounts.complete}</span>
                <span className="event-pill personas-counter-pill partial">P {personaCounts.partial}</span>
                <span className="event-pill personas-counter-pill">I {personaCounts.incomplete}</span>
                <span className="event-pill personas-counter-pill">Fiók nélkül {unlinkedAccounts.length}</span>
              </div>
              <div className="field personas-search-field">
                <label htmlFor="personaSearch">Keresés vagy QR beolvasás</label>
                <input
                  id="personaSearch"
                  value={personaSearch}
                  onChange={(event) => setPersonaSearch(event.target.value)}
                  placeholder="Név, csapat, shibboleth, QR kód vagy QR link"
                  autoComplete="off"
                />
              </div>
              <div className="record-list personas-scroll-list">
                {filteredVisiblePeople.map((person) => {
                  const completeness = buildPersonaCompleteness(person)
                  const colors = COMPLETENESS_COLORS[completeness]
                  return (
                    <button
                      key={person.id}
                      type="button"
                      className={`record-row${selectedPersonId === person.id ? ' selected' : ''}`}
                      onClick={() => selectPerson(person.id)}
                    >
                      <span style={{ display: 'flex', alignItems: 'flex-start', gap: '7px' }}>
                        <CompletenessDot completeness={completeness} />
                        <span>
                          <strong>{person.displayName}</strong>
                          <small>
                            {getPersonDisplayId(person)}
                            {person.team ? ` · ${person.team}` : ''}
                          </small>
                        </span>
                      </span>
                      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px', flexShrink: 0 }}>
                        <small style={{ fontWeight: 700 }}>{formatHuf(person.balance || 0)}</small>
                        <small
                          style={{
                            fontSize: '0.68rem',
                            padding: '1px 6px',
                            borderRadius: '999px',
                            border: `1px solid ${colors.border}`,
                            background: colors.background,
                            color: colors.color,
                            fontWeight: 600,
                          }}
                        >
                          {COMPLETENESS_LABELS[completeness]}
                        </small>
                      </span>
                    </button>
                  )
                })}
                {visiblePeople.length === 0 && (
                  <p className="helper-text">Még nincs persona. Importálj a bal oldali panelen.</p>
                )}
                {visiblePeople.length > 0 && filteredVisiblePeople.length === 0 && (
                  <p className="helper-text">Nincs a keresésnek megfelelő persona.</p>
                )}
              </div>
            </section>

            {/* Col 3: Person detail */}
            <section className="panel">
              {!selectedPerson ? (
                <StatusCard
                  title="Válassz personát"
                  tone="warning"
                  body="Kattints egy personára a listában a profil, fiókkapcsolat, QR azonosító és egyenleg kezeléséhez."
                />
              ) : (
                <>
                  {/* Person header */}
                  <div className="split-header" style={{ marginBottom: '0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <CompletenessDot completeness={buildPersonaCompleteness(selectedPerson)} />
                      <div>
                        <div style={{ fontWeight: 800, fontSize: '1rem' }}>{selectedPerson.displayName}</div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>
                          {selectedPerson.team || 'Nincs csapat'} · {getAttendeeTypeLabel(selectedPerson.attendeeType)}
                          {selectedPerson.shibboleth ? ` · ${selectedPerson.shibboleth}` : ''} · {formatHuf(selectedPerson.balance || 0)}
                        </div>
                      </div>
                    </div>
                    <span className="event-pill" style={{ textTransform: 'capitalize', flexShrink: 0 }}>
                      {getStatusLabel(selectedPerson.recordStatus)}
                    </span>
                  </div>

                  {/* Sub-tab bar */}
                  <SubTabBar
                    tabs={personSubTabs}
                    active={activePersonTab}
                    onChange={setActivePersonTab}
                  />

                  {/* Sub-tab content */}
                  {activePersonTab === 'profile' && (
                    <PersonProfileTab
                      selectedPerson={selectedPerson}
                      editState={editState}
                      setEditState={setEditState}
                      pending={pending}
                      onSave={handleSavePerson}
                      onDelete={handleDeletePerson}
                      onRestore={handleRestorePerson}
                    />
                  )}

                  {activePersonTab === 'account' && (
                    <PersonAccountTab
                      selectedPerson={selectedPerson}
                      linkedAccount={linkedAccount}
                      availableAccounts={availableAccounts}
                      accountSearch={accountSearch}
                      setAccountSearch={setAccountSearch}
                      pending={pending}
                      onLink={handleLinkAccount}
                      onUnlink={() => handleLinkAccount(null)}
                    />
                  )}

                  {activePersonTab === 'qr' && (
                    <PersonQrTab
                      selectedPerson={selectedPerson}
                      selectedQrCredential={selectedQrCredential}
                      unassignedQrCredentials={unassignedQrCredentials}
                      qrInput={qrInput}
                      setQrInput={setQrInput}
                      qrScanActive={qrScanActive}
                      setQrScanActive={setQrScanActive}
                      scannerSupported={scannerSupported}
                      videoRef={videoRef}
                      pending={pending}
                      onAssign={handleAssignQr}
                      onRevoke={handleRevokeQr}
                      onError={setErrorMessage}
                    />
                  )}

                  {activePersonTab === 'balance' && (
                    <PersonBalanceTab
                      selectedPerson={selectedPerson}
                      customTopupAmount={customTopupAmount}
                      setCustomTopupAmount={setCustomTopupAmount}
                      manualAmount={manualAmount}
                      setManualAmount={setManualAmount}
                      manualReason={manualReason}
                      setManualReason={setManualReason}
                      pending={pending}
                      onQuickTopup={handleQuickTopup}
                      onCustomTopup={handleCustomTopup}
                      onManualAdjustment={handleManualAdjustment}
                    />
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}

      {/* ── QR POOL TAB ── */}
      {activeTopTab === 'topup' && (
        <div className="topup-page-grid">
          <section className="panel personas-list-panel">
            <div className="split-header personas-list-header" style={{ marginBottom: '10px' }}>
              <div className="personas-list-title">
                <h4 className="card-title">Persona feltöltés</h4>
                <p className="helper-text">Keress névre, vagy olvass be QR-t. A QR automatikusan az egyenleg panelre vált.</p>
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={showDeleted}
                  onChange={(e) => setShowDeleted(e.target.checked)}
                />
                <span style={{ fontSize: '0.78rem' }}>Töröltek</span>
              </label>
            </div>

            <div className="field personas-search-field">
              <label htmlFor="topupPersonaSearch">Keresés vagy QR beolvasás</label>
              <input
                id="topupPersonaSearch"
                value={personaSearch}
                onChange={(event) => setPersonaSearch(event.target.value)}
                placeholder="Név, csapat, shibboleth, QR kód vagy QR link"
                autoComplete="off"
              />
            </div>

            <div className="record-list personas-scroll-list">
              {filteredVisiblePeople.map((person) => {
                const completeness = buildPersonaCompleteness(person)
                const colors = COMPLETENESS_COLORS[completeness]
                return (
                  <button
                    key={person.id}
                    type="button"
                    className={`record-row${selectedPersonId === person.id ? ' selected' : ''}`}
                    onClick={() => selectPerson(person.id, 'balance')}
                  >
                    <span style={{ display: 'flex', alignItems: 'flex-start', gap: '7px' }}>
                      <CompletenessDot completeness={completeness} />
                      <span>
                        <strong>{person.displayName}</strong>
                        <small>
                          {getPersonDisplayId(person)}
                          {person.team ? ` · ${person.team}` : ''}
                        </small>
                      </span>
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px', flexShrink: 0 }}>
                      <small style={{ fontWeight: 700 }}>{formatHuf(person.balance || 0)}</small>
                      <small
                        style={{
                          fontSize: '0.68rem',
                          padding: '1px 6px',
                          borderRadius: '999px',
                          border: `1px solid ${colors.border}`,
                          background: colors.background,
                          color: colors.color,
                          fontWeight: 600,
                        }}
                      >
                        {COMPLETENESS_LABELS[completeness]}
                      </small>
                    </span>
                  </button>
                )
              })}
              {visiblePeople.length === 0 && (
                <p className="helper-text">Még nincs persona.</p>
              )}
              {visiblePeople.length > 0 && filteredVisiblePeople.length === 0 && (
                <p className="helper-text">Nincs a keresésnek megfelelő persona.</p>
              )}
            </div>
          </section>

          <section className="panel">
            {!selectedPerson ? (
              <StatusCard
                title="Válassz personát"
                tone="warning"
                body="Kattints egy personára, keress, vagy olvass be QR-t a feltöltéshez."
              />
            ) : (
              <div className="stack-block" style={{ gap: '16px' }}>
                <div className="split-header" style={{ marginBottom: 0 }}>
                  <div>
                    <h4 className="card-title">{selectedPerson.displayName}</h4>
                    <p className="helper-text">
                      {getPersonDisplayId(selectedPerson)}
                      {selectedPerson.team ? ` · ${selectedPerson.team}` : ''}
                      {selectedPerson.shibboleth ? ` · ${selectedPerson.shibboleth}` : ''}
                    </p>
                  </div>
                  <span className="event-pill">{formatHuf(selectedPerson.balance || 0)}</span>
                </div>

                <PersonBalanceTab
                  selectedPerson={selectedPerson}
                  customTopupAmount={customTopupAmount}
                  setCustomTopupAmount={setCustomTopupAmount}
                  manualAmount={manualAmount}
                  setManualAmount={setManualAmount}
                  manualReason={manualReason}
                  setManualReason={setManualReason}
                  pending={pending}
                  onQuickTopup={handleQuickTopup}
                  onCustomTopup={handleCustomTopup}
                  onManualAdjustment={handleManualAdjustment}
                  allowManualAdjustment={allowManualAdjustment}
                />
              </div>
            )}
          </section>
        </div>
      )}

      {activeTopTab === 'qrpool' && (
        <QrPoolTab
          qrCredentials={qrCredentials}
          unassignedQrCredentials={unassignedQrCredentials}
          assignedQrCredentials={assignedQrCredentials}
          revokedQrCredentials={revokedQrCredentials}
          peopleById={peopleById}
          qrManualInput={qrManualInput}
          setQrManualInput={setQrManualInput}
          qrImportText={qrImportText}
          setQrImportText={setQrImportText}
          qrImportFileRef={qrImportFileRef}
          qrGenerationCount={qrGenerationCount}
          setQrGenerationCount={setQrGenerationCount}
          pending={pending}
          onGenerateBatch={handleGenerateQrBatch}
          onManualAdd={handleManualQrAdd}
          onImportText={handleQrTextImport}
          onImportFile={handleQrExcelImport}
          onExportUnused={handleExportUnusedQrs}
          onDeleteCredential={handleDeleteQrCredential}
        />
      )}
    </div>
  )
}
