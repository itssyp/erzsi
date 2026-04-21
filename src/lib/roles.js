export const ROLES = {
  user: 'user',
  staff: 'staff',
  admin: 'admin',
}

export function getRoleFromClaims(claims) {
  const claimedRole = claims?.role

  if (claimedRole === ROLES.admin || claimedRole === ROLES.staff || claimedRole === ROLES.user) {
    return claimedRole
  }

  return null
}

export function isStaffLike(role) {
  return role === ROLES.staff || role === ROLES.admin
}

export function getDefaultRouteForRole(role) {
  if (role === ROLES.admin) return '/admin'
  if (role === ROLES.staff) return '/staff'
  return '/app'
}
