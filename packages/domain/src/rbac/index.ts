import { UserRole, ApprovalLevel } from '@prisma/client'

export { UserRole }
export { ApprovalLevel }

export type PermissionAction =
  | 'tenant:read'
  | 'tenant:write'
  | 'tenant:delete'
  | 'user:read'
  | 'user:write'
  | 'user:delete'
  | 'user:invite'
  | 'agent:read'
  | 'agent:write'
  | 'agent:delete'
  | 'agent:deploy'
  | 'skill:read'
  | 'skill:write'
  | 'skill:delete'
  | 'knowledge:read'
  | 'knowledge:write'
  | 'knowledge:delete'
  | 'workflow:read'
  | 'workflow:write'
  | 'workflow:delete'
  | 'workflow:execute'
  | 'integration:read'
  | 'integration:write'
  | 'integration:delete'
  | 'billing:read'
  | 'billing:write'
  | 'audit:read'
  | 'settings:read'
  | 'settings:write'
  | 'monitoring:read'

export type Role = UserRole

const ROLE_PERMISSIONS: Record<Role, PermissionAction[]> = {
  PLATFORM_ADMIN: [
    'tenant:read', 'tenant:write', 'tenant:delete',
    'user:read', 'user:write', 'user:delete', 'user:invite',
    'agent:read', 'agent:write', 'agent:delete', 'agent:deploy',
    'skill:read', 'skill:write', 'skill:delete',
    'knowledge:read', 'knowledge:write', 'knowledge:delete',
    'workflow:read', 'workflow:write', 'workflow:delete', 'workflow:execute',
    'integration:read', 'integration:write', 'integration:delete',
    'billing:read', 'billing:write',
    'audit:read',
    'settings:read', 'settings:write',
    'monitoring:read',
  ],
  PLATFORM_OPERATOR: [
    'tenant:read', 'tenant:write',
    'user:read', 'user:write', 'user:invite',
    'agent:read', 'agent:write', 'agent:deploy',
    'skill:read', 'skill:write',
    'knowledge:read', 'knowledge:write',
    'workflow:read', 'workflow:write', 'workflow:execute',
    'integration:read', 'integration:write',
    'billing:read',
    'audit:read',
    'settings:read',
    'monitoring:read',
  ],
  CUSTOMER_ADMIN: [
    'tenant:read',
    'user:read', 'user:write', 'user:invite',
    'agent:read', 'agent:write', 'agent:deploy',
    'skill:read', 'skill:write',
    'knowledge:read', 'knowledge:write', 'knowledge:delete',
    'workflow:read', 'workflow:write', 'workflow:execute',
    'integration:read', 'integration:write', 'integration:delete',
    'billing:read',
    'audit:read',
    'settings:read', 'settings:write',
    'monitoring:read',
  ],
  CUSTOMER_STAFF: [
    'tenant:read',
    'user:read',
    'agent:read',
    'skill:read',
    'knowledge:read',
    'workflow:read', 'workflow:execute',
    'integration:read',
    'audit:read',
  ],
}

export function getPermissionsForRole(role: Role): PermissionAction[] {
  return ROLE_PERMISSIONS[role] || []
}

export function hasPermission(role: Role, permission: PermissionAction): boolean {
  return getPermissionsForRole(role).includes(permission)
}

export function hasAnyPermission(role: Role, permissions: PermissionAction[]): boolean {
  const rolePerms = getPermissionsForRole(role)
  return permissions.some(p => rolePerms.includes(p))
}

export function hasAllPermissions(role: Role, permissions: PermissionAction[]): boolean {
  const rolePerms = getPermissionsForRole(role)
  return permissions.every(p => rolePerms.includes(p))
}

export const APPROVAL_HIERARCHY: Record<ApprovalLevel, number> = {
  AUTOMATIC: 0,
  NOTIFY: 1,
  CUSTOMER_APPROVAL: 2,
  OPERATOR_APPROVAL: 3,
  PROHIBITED: 4,
}

export function canApprove(userRole: Role, requiredLevel: ApprovalLevel): boolean {
  if (requiredLevel === ApprovalLevel.AUTOMATIC) return true
  if (requiredLevel === ApprovalLevel.PROHIBITED) return false

  const userLevel = userRole === 'PLATFORM_ADMIN' || userRole === 'PLATFORM_OPERATOR'
    ? APPROVAL_HIERARCHY.OPERATOR_APPROVAL
    : userRole === 'CUSTOMER_ADMIN'
    ? APPROVAL_HIERARCHY.CUSTOMER_APPROVAL
    : APPROVAL_HIERARCHY.NOTIFY

  return userLevel >= APPROVAL_HIERARCHY[requiredLevel]
}

export function getHighestApprovalLevel(role: Role): ApprovalLevel {
  switch (role) {
    case 'PLATFORM_ADMIN':
    case 'PLATFORM_OPERATOR':
      return 'OPERATOR_APPROVAL'
    case 'CUSTOMER_ADMIN':
      return 'CUSTOMER_APPROVAL'
    case 'CUSTOMER_STAFF':
      return 'NOTIFY'
    default:
      return 'PROHIBITED'
  }
}

export function canAccessTenant(userRole: Role, userTenantId: string, targetTenantId: string): boolean {
  if (userRole === 'PLATFORM_ADMIN' || userRole === 'PLATFORM_OPERATOR') {
    return true
  }
  return userTenantId === targetTenantId
}

export function assertPermission(role: Role, permission: PermissionAction): void {
  if (!hasPermission(role, permission)) {
    throw new Error(`Permission denied: ${permission} required for role ${role}`)
  }
}

export function assertTenantAccess(userRole: Role, userTenantId: string, targetTenantId: string): void {
  if (!canAccessTenant(userRole, userTenantId, targetTenantId)) {
    throw new Error('Access denied: insufficient tenant permissions')
  }
}