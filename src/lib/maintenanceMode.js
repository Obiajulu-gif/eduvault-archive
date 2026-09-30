/**
 * Configurable user-facing maintenance mode banners — Issue #891
 *
 * Provides maintenance banner configuration, scoping, active state exposure,
 * and audit trail for enabling/disabling maintenance mode.
 *
 * Design:
 *   - Banners are stored in memory (Map) with no external dependencies
 *   - A banner is active when: enabled AND now >= startsAt AND now <= endsAt
 *   - Expired banners are automatically treated as inactive
 *   - Scopes: 'global', 'marketplace', 'upload', 'checkout', 'dashboard'
 *   - Every enable/disable action is recorded in an audit log
 */

export const MAINTENANCE_SCOPES = Object.freeze([
  'global',
  'marketplace',
  'upload',
  'checkout',
  'dashboard',
]);

const banners = new Map();
const auditLog = [];
const MAX_AUDIT_LOG = 500;

export function configureMaintenanceBanner(config) {
  if (!config || !config.id) {
    throw new Error('Banner id is required');
  }
  if (!config.message || typeof config.message !== 'string') {
    throw new Error('Banner message is required and must be a string');
  }
  if (config.scope && !MAINTENANCE_SCOPES.includes(config.scope)) {
    throw new Error(`Invalid scope: ${config.scope}. Must be one of: ${MAINTENANCE_SCOPES.join(', ')}`);
  }

  const banner = {
    id: config.id,
    message: config.message,
    scope: config.scope || 'global',
    startsAt: config.startsAt ? new Date(config.startsAt) : new Date(),
    endsAt: config.endsAt ? new Date(config.endsAt) : null,
    enabled: config.enabled !== undefined ? Boolean(config.enabled) : true,
    createdAt: banners.get(config.id)?.createdAt || new Date(),
    updatedAt: new Date(),
  };

  banners.set(config.id, banner);
  return { ...banner };
}

export function enableMaintenanceBanner(id, actor) {
  if (!actor) {
    throw new Error('Actor is required to enable maintenance mode');
  }
  const banner = banners.get(id);
  if (!banner) {
    throw new Error(`Banner not found: ${id}`);
  }

  banner.enabled = true;
  banner.updatedAt = new Date();

  const entry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    action: 'enabled',
    bannerId: id,
    actor,
    timestamp: new Date().toISOString(),
  };
  auditLog.push(entry);
  if (auditLog.length > MAX_AUDIT_LOG) auditLog.shift();

  return { ...banner };
}

export function disableMaintenanceBanner(id, actor) {
  if (!actor) {
    throw new Error('Actor is required to disable maintenance mode');
  }
  const banner = banners.get(id);
  if (!banner) {
    throw new Error(`Banner not found: ${id}`);
  }

  banner.enabled = false;
  banner.updatedAt = new Date();

  const entry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    action: 'disabled',
    bannerId: id,
    actor,
    timestamp: new Date().toISOString(),
  };
  auditLog.push(entry);
  if (auditLog.length > MAX_AUDIT_LOG) auditLog.shift();

  return { ...banner };
}

export function getActiveMaintenanceBanners(scope = null) {
  const now = new Date();
  const active = [];

  for (const banner of banners.values()) {
    if (!banner.enabled) continue;
    if (banner.startsAt && now < banner.startsAt) continue;
    if (banner.endsAt && now > banner.endsAt) continue;
    if (scope && banner.scope !== scope && banner.scope !== 'global') continue;
    active.push({ ...banner });
  }

  return active;
}

export function isMaintenanceActive(scope) {
  const now = new Date();

  for (const banner of banners.values()) {
    if (!banner.enabled) continue;
    if (banner.startsAt && now < banner.startsAt) continue;
    if (banner.endsAt && now > banner.endsAt) continue;
    if (banner.scope === scope || banner.scope === 'global') {
      return true;
    }
  }

  return false;
}

export function getMaintenanceAuditLog(limit = 100) {
  return auditLog.slice(-limit);
}

export function clearMaintenanceAuditLog() {
  auditLog.length = 0;
}

export function resetMaintenanceMode() {
  banners.clear();
  auditLog.length = 0;
}

export function getBanner(id) {
  const banner = banners.get(id);
  return banner ? { ...banner } : null;
}

export function deleteMaintenanceBanner(id, actor) {
  if (!actor) {
    throw new Error('Actor is required to delete a maintenance banner');
  }
  const existed = banners.delete(id);
  if (!existed) {
    throw new Error(`Banner not found: ${id}`);
  }
  return { deleted: true, id };
}
