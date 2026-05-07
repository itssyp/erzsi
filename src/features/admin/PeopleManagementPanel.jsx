import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import * as XLSX from 'xlsx'
import { StatusCard } from '../../components/StatusCard'
import { formatHuf, parseHufInteger } from '../../lib/money'
import { ATTENDEE_TYPES, PERSON_RECORD_STATUSES } from '../people/personModels'
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
  assignQrToPerson,
  revokeQrForPerson,
  subscribeToQrCredentials,
  QR_CREDENTIAL_STATUSES,
} from '../qr/qrService'
import { useQrScanner } from '../qr/useQrScanner'

const quickTopupAmounts = [2000, 5000, 10000, 20000]

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
      return 'Admin permissions are required for this action.'
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

const COMPLETENESS_LABELS = { complete: 'Complete', partial: 'Partial', incomplete: 'Incomplete' }
const COMPLETENESS_COLORS = {
  complete:   { background: 'color-mix(in srgb, var(--success) 12%, transparent)', color: '#15803d', border: '#86efac' },
  partial:    { background: '#fefce8', color: '#92400e', border: '#fde047' },
  incomplete: { background: 'var(--surface)', color: 'var(--muted)', border: 'var(--border)' },
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
        <label htmlFor="personName">Display name</label>
        <input
          id="personName"
          value={editState.displayName}
          onChange={(e) => setEditState((s) => ({ ...s, displayName: e.target.value }))}
        />
      </div>
      <div className="field">
        <label htmlFor="personTeam">Team</label>
        <input
          id="personTeam"
          value={editState.team}
          onChange={(e) => setEditState((s) => ({ ...s, team: e.target.value }))}
          placeholder="Red, Blue, Org…"
        />
      </div>
      <div className="field">
        <label htmlFor="personAttendeeType">Attendee type</label>
        <select
          id="personAttendeeType"
          value={editState.attendeeType}
          onChange={(e) => setEditState((s) => ({ ...s, attendeeType: e.target.value }))}
        >
          <option value={ATTENDEE_TYPES.freshman}>Freshman</option>
          <option value={ATTENDEE_TYPES.organizer}>Organizer</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="personShibboleth">Shibboleth</label>
        <input
          id="personShibboleth"
          value={editState.shibboleth}
          onChange={(e) => setEditState((s) => ({ ...s, shibboleth: e.target.value }))}
          placeholder="External identifier"
        />
      </div>
      <div className="button-row">
        <button type="button" className="primary-button" onClick={onSave} disabled={pending}>
          Save changes
        </button>
        {isDeleted ? (
          <button type="button" className="secondary-button" onClick={onRestore} disabled={pending}>
            Restore persona
          </button>
        ) : (
          <button type="button" className="danger-button" onClick={onDelete} disabled={pending}>
            Delete persona
          </button>
        )}
      </div>
      <ul className="detail-list" style={{ fontSize: '0.8rem', marginTop: '4px' }}>
        <li><strong>Internal ID</strong> <span style={{ fontFamily: 'monospace' }}>{selectedPerson.internalId}</span></li>
        <li><strong>Status</strong> <span style={{ textTransform: 'capitalize' }}>{selectedPerson.recordStatus}</span></li>
        <li><strong>Created</strong> <span>{formatTimestamp(selectedPerson.createdAt)}</span></li>
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
            <li><strong>Role</strong> <span>{linkedAccount.role || 'user'}</span></li>
          </ul>
          <div className="button-row">
            <button type="button" className="danger-button" onClick={onUnlink} disabled={pending}>
              Unlink account
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="helper-text">No account linked. Search and click an account below to link it.</p>
          <div className="field">
            <label htmlFor="accountSearch">Search by name or email</label>
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
              <p className="helper-text">No matching unlinked attendee accounts.</p>
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
              <li><strong>Status</strong> <span style={{ textTransform: 'capitalize' }}>{selectedQrCredential?.status || 'assigned'}</span></li>
              <li><strong>Assigned</strong> <span>{formatTimestamp(selectedQrCredential?.assignedAt)}</span></li>
            </ul>
          </div>
          <div className="button-row">
            <button type="button" className="danger-button" onClick={onRevoke} disabled={pending}>
              Revoke QR credential
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="helper-text">No QR credential assigned. Pick one from the pool below, scan a physical QR, or enter a code manually.</p>

          <div className="lookup-toolbar">
            <input
              id="qrValue"
              value={qrInput}
              onChange={(e) => setQrInput(e.target.value)}
              placeholder="5-digit code or QR link"
            />
            <button
              type="button"
              className={`icon-button${qrScanActive ? ' active' : ''}`}
              onClick={() => {
                if (!scannerSupported) {
                  onError('Camera QR scanning is not supported on this device.')
                  return
                }
                setQrScanActive((v) => !v)
              }}
              aria-label={qrScanActive ? 'Close scanner' : 'Scan QR'}
              title={qrScanActive ? 'Close scanner' : 'Scan QR'}
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
              Assign manually
            </button>
          </div>

          {unassignedQrCredentials.length > 0 && (
            <>
              <p className="helper-text" style={{ marginBottom: 0 }}>
                Or pick from the unassigned pool ({unassignedQrCredentials.length} available):
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
                      {cred.link || 'link pending'}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {unassignedQrCredentials.length === 0 && (
            <StatusCard
              title="No unassigned credentials"
              tone="warning"
              body="Generate a new batch from the QR Pool tab first."
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
}) {
  return (
    <div className="stack-block" style={{ gap: '20px' }}>
      <div style={{ textAlign: 'center', padding: '16px 0' }}>
        <div className="balance-label">Current balance</div>
        <div className="balance-value">{formatHuf(selectedPerson.balance || 0)}</div>
      </div>

      <div>
        <p className="helper-text" style={{ marginBottom: '10px' }}>Quick top-up</p>
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
        <p className="helper-text" style={{ marginBottom: 0 }}>Custom top-up</p>
        <div className="field">
          <label htmlFor="customTopup">Amount (HUF)</label>
          <input
            id="customTopup"
            value={customTopupAmount}
            onChange={(e) => setCustomTopupAmount(e.target.value)}
            placeholder="e.g. 3500"
          />
        </div>
        <div className="button-row">
          <button type="button" className="primary-button" onClick={onCustomTopup} disabled={pending}>
            Apply top-up
          </button>
        </div>
      </div>

      <div className="stack-block" style={{ gap: '10px', paddingTop: '4px', borderTop: '1px dashed var(--border)' }}>
        <p className="helper-text" style={{ marginBottom: 0 }}>Manual adjustment (can be negative)</p>
        <div className="field">
          <label htmlFor="manualAmount">Amount (HUF)</label>
          <input
            id="manualAmount"
            value={manualAmount}
            onChange={(e) => setManualAmount(e.target.value)}
            placeholder="-500 or 1000"
          />
        </div>
        <div className="field">
          <label htmlFor="manualReason">Reason (optional)</label>
          <input
            id="manualReason"
            value={manualReason}
            onChange={(e) => setManualReason(e.target.value)}
            placeholder="Cash correction, event bonus…"
          />
        </div>
        <div className="button-row">
          <button type="button" className="primary-button" onClick={onManualAdjustment} disabled={pending}>
            Apply adjustment
          </button>
        </div>
      </div>
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

function QrPoolRow({ cred }) {
  const [expanded, setExpanded] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const value = cred.link || cred.code

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
      console.error('QR download failed', error)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className={`qr-pool-row${expanded ? ' expanded' : ''}`}>
      <div className="qr-pool-row-main">
        <span className="qr-pool-row-info">
          <strong>{cred.code}</strong>
          <small>{cred.link || 'Link pending'}</small>
        </span>
        <span className="qr-pool-row-actions">
          <button
            type="button"
            className="secondary-button btn-sm"
            onClick={() => setExpanded((v) => !v)}
            disabled={!value}
          >
            {expanded ? 'Hide' : 'View'}
          </button>
          <button
            type="button"
            className="secondary-button btn-sm"
            onClick={handleDownload}
            disabled={downloading || !value}
          >
            {downloading ? '…' : '↓ PNG'}
          </button>
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

function buildPrintHtml(items) {
  const cells = items
    .map(({ code, dataUrl }) =>
      `<div class="cell"><img src="${dataUrl}" alt="${code}"><div class="lbl">${code}</div></div>`,
    )
    .join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>QR Codes — ${items.length} codes</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #fff; }
  .grid {
    display: grid;
    grid-template-columns: repeat(11, 15mm);
    gap: 2.5mm;
  }
  .cell {
    break-inside: avoid;
    text-align: center;
  }
  .cell img {
    width: 15mm;
    height: 15mm;
    display: block;
  }
  .lbl {
    font-size: 6pt;
    font-family: 'Courier New', monospace;
    letter-spacing: 0.04em;
    margin-top: 0.8mm;
    line-height: 1.2;
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
  revokedQrCredentials,
  qrGenerationCount,
  setQrGenerationCount,
  pending,
  onGenerateBatch,
}) {
  const [printLoading, setPrintLoading] = useState(false)
  const assignedCount = qrCredentials.filter((c) => c.status === QR_CREDENTIAL_STATUSES.assigned).length

  async function handlePrint() {
    const eligible = unassignedQrCredentials.filter((c) => c.link || c.code)
    if (!eligible.length) return
    setPrintLoading(true)
    try {
      const items = await Promise.all(
        eligible.map(async (cred) => {
          const value = cred.link || cred.code
          const dataUrl = await QRCode.toDataURL(value, { width: 200, margin: 1, errorCorrectionLevel: 'M' })
          return { code: cred.code, dataUrl }
        }),
      )
      const html = buildPrintHtml(items)
      const win = window.open('', '_blank', 'width=900,height=700')
      if (!win) return
      win.document.write(html)
      win.document.close()
      win.focus()
      setTimeout(() => win.print(), 400)
    } catch (error) {
      console.error('Print failed', error)
    } finally {
      setPrintLoading(false)
    }
  }

  return (
    <div className="stack-block" style={{ gap: '20px' }}>
      {/* Stats */}
      <div className="detail-grid">
        <span className="event-pill" style={{ background: 'color-mix(in srgb, var(--success) 10%, transparent)', borderColor: '#86efac', color: '#15803d' }}>
          Assigned: {assignedCount}
        </span>
        <span className="event-pill" style={{ background: '#fefce8', borderColor: '#fde047', color: '#92400e' }}>
          Unassigned: {unassignedQrCredentials.length}
        </span>
        <span className="event-pill" style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
          Revoked: {revokedQrCredentials.length}
        </span>
        <span className="event-pill">
          Total pool: {qrCredentials.length}
        </span>
      </div>

      {/* Generate batch */}
      <section className="panel">
        <h4 className="card-title">Generate new batch</h4>
        <p className="helper-text">
          Creates N unassigned QR credentials in the pool. These can then be assigned to personas individually.
        </p>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '12px' }}>
          <div className="field" style={{ margin: 0, flex: '0 0 120px' }}>
            <label htmlFor="qrBatchCount">Count</label>
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
            Generate QR credentials
          </button>
        </div>
      </section>

      {/* Unassigned pool */}
      <section className="panel">
        <div className="split-header" style={{ marginBottom: '10px' }}>
          <div>
            <h4 className="card-title">Unassigned pool ({unassignedQrCredentials.length})</h4>
            <p className="helper-text">Ready to be assigned to a persona.</p>
          </div>
          {unassignedQrCredentials.length > 0 ? (
            <button
              type="button"
              className="secondary-button btn-sm"
              onClick={handlePrint}
              disabled={printLoading}
              title="Generate print-ready A4 sheet of all unassigned QR codes"
            >
              {printLoading ? 'Generating…' : '🖨 Print sheet'}
            </button>
          ) : null}
        </div>
        <div className="qr-pool-list">
          {unassignedQrCredentials.map((cred) => (
            <QrPoolRow key={cred.id} cred={cred} />
          ))}
          {unassignedQrCredentials.length === 0 && (
            <p className="helper-text">No unassigned credentials. Generate a batch above.</p>
          )}
        </div>
      </section>

      {/* Revoked */}
      <section className="panel">
        <h4 className="card-title" style={{ marginBottom: '6px' }}>Revoked credentials ({revokedQrCredentials.length})</h4>
        <p className="helper-text" style={{ marginBottom: '10px' }}>Permanently inactivated, cannot be reassigned.</p>
        <div className="qr-pool-list">
          {revokedQrCredentials.map((cred) => (
            <QrPoolRow key={cred.id} cred={cred} />
          ))}
          {revokedQrCredentials.length === 0 && (
            <p className="helper-text">No revoked credentials.</p>
          )}
        </div>
      </section>
    </div>
  )
}

// ── Main export ────────────────────────────────────────────────────────────
export function PeopleManagementPanel({ eventId, actorUid }) {
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
  const [qrInput, setQrInput] = useState('')
  const [qrScanActive, setQrScanActive] = useState(false)
  const [qrGenerationCount, setQrGenerationCount] = useState('20')
  const [customTopupAmount, setCustomTopupAmount] = useState('')
  const [manualAmount, setManualAmount] = useState('')
  const [manualReason, setManualReason] = useState('')
  const [showDeleted, setShowDeleted] = useState(false)
  const [pending, setPending] = useState(false)
  const [activeTopTab, setActiveTopTab] = useState('personas')
  const [activePersonTab, setActivePersonTab] = useState('profile')

  useEffect(() => {
    return subscribeToPeople(eventId, setPeople, (error) => setErrorMessage(error.message))
  }, [eventId])

  useEffect(() => {
    return subscribeToAccountsDirectory(setAccounts, (error) => setErrorMessage(error.message))
  }, [])

  useEffect(() => {
    return subscribeToQrCredentials(eventId, setQrCredentials, (error) => setErrorMessage(error.message))
  }, [eventId])

  const visiblePeople = useMemo(() => {
    return people.filter((person) => showDeleted || person.recordStatus !== PERSON_RECORD_STATUSES.deleted)
  }, [people, showDeleted])

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

  const appBaseUrl = useMemo(() => {
    if (typeof window === 'undefined') return ''
    return window.location.origin
  }, [])

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

  // Reset per-person state when selection changes
  useEffect(() => {
    setActivePersonTab('profile')
    setAccountSearch('')
    setQrInput('')
    setQrScanActive(false)
    setManualAmount('')
    setManualReason('')
    setCustomTopupAmount('')
  }, [selectedPersonId])

  useEffect(() => {
    if (!selectedPerson) {
      setEditState(emptyEditState)
      return
    }
    setEditState(buildSelectedPersonState(selectedPerson))
    setQrInput(selectedPerson.assignedQrId || selectedPerson.qrCodeId || '')
  }, [selectedPerson])

  async function runAction(action, fallbackMessage = 'Action failed.') {
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
        'Import failed.',
      )
      setImportFeedback(result)
      setImportText('')
      setStatusMessage(`Imported ${result.importedCount} persona record${result.importedCount === 1 ? '' : 's'}. Carry-over applied to ${result.carryoverAppliedCount || 0}.`)
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
        setErrorMessage('Excel import failed: the first sheet has no rows.')
        return
      }

      const result = await runAction(
        () => importPeopleFromRows({ eventId, actorUid, rows }),
        'Excel import failed.',
      )
      setImportFeedback(result)
      setStatusMessage(`Imported ${result.importedCount} persona record${result.importedCount === 1 ? '' : 's'} from Excel. Carry-over applied to ${result.carryoverAppliedCount || 0}.`)
    } catch (error) {
      setErrorMessage(error?.message || 'Excel import failed.')
    }
  }

  async function handleSavePerson() {
    if (!selectedPerson) return
    try {
      await runAction(
        () => updatePersonRecord({ eventId, actorUid, personId: selectedPerson.id, ...editState }),
        'Saving the persona failed.',
      )
      setStatusMessage('Persona details updated.')
    } catch { /* handled */ }
  }

  async function handleDeletePerson() {
    if (!selectedPerson) return
    try {
      await runAction(
        () => deletePersonRecord({ eventId, actorUid, personId: selectedPerson.id }),
        'Deleting the persona failed.',
      )
      setStatusMessage('Persona deleted.')
    } catch { /* handled */ }
  }

  async function handleRestorePerson() {
    if (!selectedPerson) return
    try {
      await runAction(
        () => restorePersonRecord({ eventId, actorUid, personId: selectedPerson.id }),
        'Restoring the persona failed.',
      )
      setStatusMessage('Persona restored.')
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
        'Linking the account failed.',
      )
      setStatusMessage(linkedAuthUid ? 'Account linked to persona.' : 'Account link removed.')
    } catch { /* handled */ }
  }

  async function handleGenerateQrBatch() {
    const count = Number.parseInt(qrGenerationCount, 10)
    if (!Number.isInteger(count) || count <= 0) {
      setErrorMessage('QR batch count must be a positive integer.')
      return
    }
    try {
      const result = await runAction(
        () => generateQrCredentials({ eventId, count, appBaseUrl }),
        'Generating QR credentials failed.',
      )
      setStatusMessage(`Generated ${result.count} unassigned QR credential${result.count === 1 ? '' : 's'}.`)
    } catch { /* handled */ }
  }

  async function handleAssignQr(rawValue = qrInput) {
    if (!selectedPerson) return
    try {
      const result = await runAction(
        () => assignQrToPerson({ eventId, personId: selectedPerson.id, qrInput: rawValue, appBaseUrl }),
        'Assigning the QR credential failed.',
      )
      const code = result?.credential?.code || `${rawValue}`.trim()
      setQrInput(code)
      setStatusMessage(`QR credential ${code} assigned.`)
    } catch { /* handled */ }
  }

  async function handleRevokeQr() {
    if (!selectedPerson) return
    try {
      await runAction(
        () => revokeQrForPerson({ eventId, personId: selectedPerson.id }),
        'Revoking the QR credential failed.',
      )
      setQrInput('')
      setStatusMessage('QR credential revoked.')
    } catch { /* handled */ }
  }

  async function handleQuickTopup(amount) {
    if (!selectedPerson) return
    try {
      await runAction(
        () => topUpPersonBalance({ eventId, actorUid, personId: selectedPerson.id, amount }),
        'Top-up failed.',
      )
      setStatusMessage(`Applied ${formatHuf(amount)} top-up.`)
    } catch { /* handled */ }
  }

  async function handleCustomTopup() {
    if (!selectedPerson) return
    const amount = parseHufInteger(customTopupAmount)
    if (!Number.isInteger(amount) || amount <= 0) {
      setErrorMessage('Custom top-up amount must be a positive integer HUF value.')
      return
    }
    try {
      await runAction(
        () => topUpPersonBalance({ eventId, actorUid, personId: selectedPerson.id, amount }),
        'Custom top-up failed.',
      )
      setCustomTopupAmount('')
      setStatusMessage(`Applied custom top-up of ${formatHuf(amount)}.`)
    } catch { /* handled */ }
  }

  async function handleManualAdjustment() {
    if (!selectedPerson) return
    const amount = parseHufInteger(manualAmount)
    if (!Number.isInteger(amount) || amount === 0) {
      setErrorMessage('Manual adjustment amount must be a non-zero integer HUF value.')
      return
    }
    try {
      await runAction(
        () => adjustPersonBalance({ eventId, actorUid, personId: selectedPerson.id, amount, reason: manualReason }),
        'Manual balance adjustment failed.',
      )
      setManualAmount('')
      setManualReason('')
      setStatusMessage('Manual balance adjustment applied.')
    } catch { /* handled */ }
  }

  const personSubTabs = [
    { id: 'profile', label: 'Profile' },
    { id: 'account', label: 'Account' },
    { id: 'qr', label: 'QR' },
    { id: 'balance', label: 'Balance' },
  ]

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="admin-section">
      {/* Banners */}
      {errorMessage ? <div className="error-banner" style={{ marginBottom: '12px' }}>{errorMessage}</div> : null}
      {statusMessage ? <div className="status-inline" style={{ marginBottom: '12px' }}>{statusMessage}</div> : null}

      {/* Top-level tab bar */}
      <div className="tab-bar" style={{ marginBottom: '20px' }}>
        <button
          type="button"
          className={`tab-btn${activeTopTab === 'personas' ? ' active' : ''}`}
          onClick={() => setActiveTopTab('personas')}
        >
          Personas
        </button>
        <button
          type="button"
          className={`tab-btn${activeTopTab === 'qrpool' ? ' active' : ''}`}
          onClick={() => setActiveTopTab('qrpool')}
        >
          QR Pool
          {unassignedQrCredentials.length > 0 && (
            <span className="kds-count-pill" style={{ marginLeft: '6px' }}>{unassignedQrCredentials.length}</span>
          )}
        </button>
      </div>

      {/* ── PERSONAS TAB ── */}
      {activeTopTab === 'personas' && (
        <>
          {/* Stats row */}
          <div className="detail-grid" style={{ marginBottom: '16px' }}>
            <span className="event-pill" style={{ background: 'color-mix(in srgb, var(--success) 10%, transparent)', borderColor: '#86efac', color: '#15803d' }}>
              Complete: {personaCounts.complete}
            </span>
            <span className="event-pill" style={{ background: '#fefce8', borderColor: '#fde047', color: '#92400e' }}>
              Partial: {personaCounts.partial}
            </span>
            <span className="event-pill">
              Incomplete: {personaCounts.incomplete}
            </span>
            <span className="event-pill">
              Unlinked accounts: {unlinkedAccounts.length}
            </span>
          </div>

          {/* Three-column grid */}
          <div className="three-column-grid">
            {/* Col 1: Import */}
            <section className="panel">
              <h4 className="card-title">Import personas</h4>
              <p className="helper-text">
                One attendee per line: <strong>name, team, type, shibboleth</strong> (tab, semicolon, or comma).
              </p>
              <form className="form-grid" onSubmit={handleImport} style={{ marginTop: '12px' }}>
                <div className="field">
                  <label htmlFor="peopleImportExcel">Excel file</label>
                  <input
                    id="peopleImportExcel"
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleExcelImport}
                    disabled={pending}
                  />
                  <p className="helper-text">
                    Uses the first sheet. Header row can be name, team, type, shibboleth.
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="peopleImport">Paste rows</label>
                  <textarea
                    id="peopleImport"
                    className="text-area"
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder={'John Doe\tRed\tfreshman\tSHIB-123'}
                    rows={10}
                  />
                </div>
                <div className="button-row">
                  <button type="submit" className="primary-button" disabled={pending || !importText.trim()}>
                    Import
                  </button>
                </div>
              </form>
              {importFeedback && (
                <div className="stack-block" style={{ gap: '8px', marginTop: '12px' }}>
                  <p className="helper-text">
                    Imported {importFeedback.importedCount} rows. Carry-over applied to {importFeedback.carryoverAppliedCount || 0}. Rejected {importFeedback.rejectedRows.length}.
                  </p>
                  {importFeedback.rejectedRows.length > 0 && (
                    <ul className="detail-list">
                      {importFeedback.rejectedRows.slice(0, 5).map((row) => (
                        <li key={`${row.lineNumber}-${row.reason}`}>
                          <strong>Line {row.lineNumber}</strong>
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
              <div className="split-header" style={{ marginBottom: '10px' }}>
                <div>
                  <h4 className="card-title">Personas</h4>
                  <p className="helper-text">{visiblePeople.length} record{visiblePeople.length !== 1 ? 's' : ''}</p>
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={showDeleted}
                    onChange={(e) => setShowDeleted(e.target.checked)}
                  />
                  <span style={{ fontSize: '0.78rem' }}>Deleted</span>
                </label>
              </div>
              <div className="record-list">
                {visiblePeople.map((person) => {
                  const completeness = buildPersonaCompleteness(person)
                  const colors = COMPLETENESS_COLORS[completeness]
                  return (
                    <button
                      key={person.id}
                      type="button"
                      className={`record-row${selectedPersonId === person.id ? ' selected' : ''}`}
                      onClick={() => setSelectedPersonId(person.id)}
                    >
                      <span style={{ display: 'flex', alignItems: 'flex-start', gap: '7px' }}>
                        <CompletenessDot completeness={completeness} />
                        <span>
                          <strong>{person.displayName}</strong>
                          <small>
                            {person.internalId}
                            {person.team ? ` · ${person.team}` : ''}
                            {person.shibboleth ? ` · ${person.shibboleth}` : ''}
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
                  <p className="helper-text">No personas yet. Import from the left panel.</p>
                )}
              </div>
            </section>

            {/* Col 3: Person detail */}
            <section className="panel">
              {!selectedPerson ? (
                <StatusCard
                  title="Select a persona"
                  tone="warning"
                  body="Click a persona from the list to view and edit their profile, account link, QR credential, and balance."
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
                          {selectedPerson.team || 'No team'} · {selectedPerson.attendeeType}
                          {selectedPerson.shibboleth ? ` · ${selectedPerson.shibboleth}` : ''} · {formatHuf(selectedPerson.balance || 0)}
                        </div>
                      </div>
                    </div>
                    <span className="event-pill" style={{ textTransform: 'capitalize', flexShrink: 0 }}>
                      {selectedPerson.recordStatus}
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
      {activeTopTab === 'qrpool' && (
        <QrPoolTab
          qrCredentials={qrCredentials}
          unassignedQrCredentials={unassignedQrCredentials}
          revokedQrCredentials={revokedQrCredentials}
          qrGenerationCount={qrGenerationCount}
          setQrGenerationCount={setQrGenerationCount}
          pending={pending}
          onGenerateBatch={handleGenerateQrBatch}
        />
      )}
    </div>
  )
}
