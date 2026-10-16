export const ROLE_PERMISSIONS = Object.freeze({
  user: Object.freeze([
    'profile:manage',
    'marketplace:use',
    'purchase:create',
    'learning:manage',
  ]),
  learner: Object.freeze([
    'profile:manage',
    'marketplace:use',
    'purchase:create',
    'learning:manage',
  ]),
  creator: Object.freeze([
    'profile:manage',
    'marketplace:use',
    'purchase:create',
    'learning:manage',
    'creator:publish',
    'creator:manage',
    'creator:analytics:read',
    'creator:payouts:manage',
  ]),
  admin: Object.freeze(['*']),
  service: Object.freeze([
    'operations:read',
    'storage:maintain',
  ]),
});

export function hasPermission(user, permission) {
  if (!user || typeof permission !== 'string') return false;
  const permissions = ROLE_PERMISSIONS[user.role];
  return Boolean(permissions?.includes('*') || permissions?.includes(permission));
}