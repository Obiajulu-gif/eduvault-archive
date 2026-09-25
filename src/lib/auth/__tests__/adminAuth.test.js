import { describe, it, expect } from 'vitest';
import { isAdmin, withAdminGuard } from '../adminAuth';

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
