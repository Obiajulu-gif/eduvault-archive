import { describe, it, expect } from 'vitest';
import { canAccess, isAdmin, withAdminGuard, withPermissionGuard } from '../adminAuth';

const adminCapabilities = [
  'admin:access',
  'admin:disputes:read',
  'admin:disputes:manage',
  'admin:users:manage',
  'admin:verification:read',
  'admin:verification:manage',
  'admin:moderation:audit',
];

const creatorCapabilities = [
  'creator:publish',
  'creator:manage',
  'creator:analytics:read',
  'creator:payouts:manage',
];

describe('Admin Authentication Guard (Issue #558)', () => {
  it('denies access when user object is undefined or null', () => {
    expect(isAdmin(undefined)).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });

  it('denies access when user role is not admin (e.g. creator, learner, guest)', () => {
    expect(isAdmin({ role: 'learner' })).toBe(false);
    expect(isAdmin({ role: 'creator' })).toBe(false);
    expect(isAdmin({ role: 'user' })).toBe(false);
    expect(isAdmin({ role: '' })).toBe(false);
  });

  it('grants access only when user role is explicitly admin', () => {
    expect(isAdmin({ role: 'admin' })).toBe(true);
    expect(isAdmin({ sub: 'admin-123', role: 'admin' })).toBe(true);
  });

  it('applies the role capability matrix and denies unknown roles', () => {
    expect(canAccess({ role: 'learner' }, 'purchase:create')).toBe(true);
    expect(canAccess({ role: 'learner' }, 'creator:publish')).toBe(false);
    expect(canAccess({ role: 'creator' }, 'creator:publish')).toBe(true);
    expect(canAccess({ role: 'creator' }, 'admin:users:manage')).toBe(false);
    expect(canAccess({ role: 'service' }, 'storage:maintain')).toBe(true);
    expect(canAccess({ role: 'service' }, 'operations:read')).toBe(true);
    expect(canAccess({ role: 'service' }, 'admin:users:manage')).toBe(false);
    expect(canAccess({ role: 'unknown' }, 'marketplace:use')).toBe(false);
  });

  it('grants every declared admin capability only to administrators', () => {
    for (const capability of adminCapabilities) {
      expect(canAccess({ role: 'admin' }, capability)).toBe(true);
      expect(canAccess({ role: 'learner' }, capability)).toBe(false);
      expect(canAccess({ role: 'creator' }, capability)).toBe(false);
      expect(canAccess({ role: 'service' }, capability)).toBe(false);
    }
  });

  it('grants every declared creator capability only to creators and administrators', () => {
    for (const capability of creatorCapabilities) {
      expect(canAccess({ role: 'creator' }, capability)).toBe(true);
      expect(canAccess({ role: 'admin' }, capability)).toBe(true);
      expect(canAccess({ role: 'learner' }, capability)).toBe(false);
      expect(canAccess({ role: 'service' }, capability)).toBe(false);
    }
  });

  it('uses shared permissions for non-admin UI guards', () => {
    const DummyComponent = () => 'Creator Content';
    const Guarded = withPermissionGuard('creator:publish', DummyComponent);
    expect(Guarded({ user: { role: 'learner' } }).props.role).toBe('alert');
    expect(Guarded({ user: { role: 'creator' } }).type).toBe(DummyComponent);
  });

  it('withAdminGuard denies unauthenticated requests without defaulting to admin', () => {
    const DummyComponent = () => 'Secret Admin Content';
    const Guarded = withAdminGuard(DummyComponent);

    // Call without props (empty user)
    const res = Guarded({});
    expect(res).not.toEqual('Secret Admin Content');
    expect(res.props.role).toBe('alert');

    // Call with non-admin user
    const resLearner = Guarded({ user: { role: 'learner' } });
    expect(resLearner).not.toEqual('Secret Admin Content');
  });

  it('withAdminGuard renders page when user is admin', () => {
    const DummyComponent = (props) => `Welcome Admin: ${props.user.sub}`;
    const Guarded = withAdminGuard(DummyComponent);

    const res = Guarded({ user: { sub: 'admin-1', role: 'admin' } });
    expect(res.type).toBe(DummyComponent);
  });
});
