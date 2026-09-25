// src/lib/auth/adminAuth.js
import React from 'react';

/**
 * Admin authorization utility.
 * Single source of truth for checking admin role on user objects.
 */
export function isAdmin(user) {
  return Boolean(user && user.role === 'admin');
}

/**
 * Higher-order component (HOC) to protect admin pages.
 * Fails closed: missing user data or non-admin roles are denied access.
 */
export function withAdminGuard(PageComponent) {
  return function AdminGuarded(props) {
    const user = props.user || null;
    if (!isAdmin(user)) {
      return React.createElement(
        'div',
        { className: 'admin-access-denied p-8 text-center', role: 'alert' },
        React.createElement('h2', { className: 'text-xl font-bold text-red-600 mb-2' }, 'Access Denied'),
        React.createElement(
          'p',
          { className: 'text-gray-700 dark:text-gray-300' },
          'Administrators only. You do not have permission to view this page.'
        )
      );
    }
    return React.createElement(PageComponent, props);
  };
}
