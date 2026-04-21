const staffSessionStorageKey = 'erzsi-staff-session-id'

export function getStaffSessionId() {
  const existing = window.localStorage.getItem(staffSessionStorageKey)

  if (existing) {
    return existing
  }

  const created = crypto.randomUUID()
  window.localStorage.setItem(staffSessionStorageKey, created)

  return created
}
