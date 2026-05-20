export const ROLES = {
  user: 'user',
  staff: 'staff',
  posStaff: 'pos_staff',
  topupStaff: 'topup_staff',
  admin: 'admin',
}

export const PRIVILEGED_ROLES = [
  ROLES.staff,
  ROLES.posStaff,
  ROLES.topupStaff,
  ROLES.admin,
]

export function getRoleFromClaims(claims) {
  const claimedRole = claims?.role

  if (
    claimedRole === ROLES.admin ||
    claimedRole === ROLES.staff ||
    claimedRole === ROLES.posStaff ||
    claimedRole === ROLES.topupStaff ||
    claimedRole === ROLES.user
  ) {
    return claimedRole
  }

  return null
}

export function isStaffLike(role) {
  return role === ROLES.staff || role === ROLES.posStaff || role === ROLES.admin
}

export function canManageCatalog(role) {
  return role === ROLES.staff || role === ROLES.admin
}

export function canUseTopup(role) {
  return role === ROLES.topupStaff || role === ROLES.admin
}

export function getDefaultRouteForRole(role) {
  if (role === ROLES.admin) return '/admin'
  if (role === ROLES.staff || role === ROLES.posStaff) return '/staff'
  if (role === ROLES.topupStaff) return '/topup'
  return '/app'
}
