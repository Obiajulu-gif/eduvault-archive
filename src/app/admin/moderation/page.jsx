                    <button
                      className="action-btn deny"
                      onClick={() => handleAction(itemId, 'propose')}
                    >
                      Propose suspension
                    </button>
                    <button
                      className="action-btn suspend"
                      onClick={() => handleAction(itemId, 'approve')}
                    >
                      Approve sanction
                    </button>
                    <button
                      className="action-btn approve"
                      onClick={() => handleAction(itemId, 'approve')}
                    >
                      Approve / sanction
                    </button>
"use client";

import React, { useState, useEffect } from 'react';
import './moderation.css';
import { withAdminGuard, isAdmin } from '@/lib/auth/adminAuth';

/**
 * Fetch flagged items from the server-side admin moderation route.
 */
const fetchFlagged = async () => {
  const res = await fetch('/api/admin/moderation');
  if (!res.ok) {
    throw new Error('Unauthorized or failed to fetch moderation cases');
  }
  const data = await res.json();
  return data.cases || [];
};

function ModerationDashboard({ user }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [currentUser, setCurrentUser] = useState(user || null);
  const [authChecked, setAuthChecked] = useState(Boolean(user));

  useEffect(() => {
    if (user) {
      setCurrentUser(user);
      setAuthChecked(true);
      return;
    }

    // Check user session from API if not passed via props
    fetch('/api/profile')
      .then((res) => {
        if (!res.ok) throw new Error('Unauthenticated');
        return res.json();
      })
      .then((data) => {
        const u = data.user || data;
        setCurrentUser(u);
        setAuthChecked(true);
      })
      .catch(() => {
        setCurrentUser(null);
        setAuthChecked(true);
        setLoading(false);
      });
  }, [user]);

  useEffect(() => {
    if (!authChecked) return;

    if (!isAdmin(currentUser)) {
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchFlagged()
      .then((data) => {
        setItems(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [authChecked, currentUser]);

  const handleAction = async (id, action) => {
    try {
      const res = await fetch('/api/admin/moderation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, caseId: id, sanction: action === 'propose' ? 'suspend_material' : undefined }),
      });
      if (!res.ok) throw new Error('Failed to perform moderation action');
      setItems((prev) => prev.filter((i) => (i._id || i.id) !== id));
    } catch (e) {
      alert(`Action failed: ${e.message}`);
    }
  };

  if (!authChecked || loading) {
    return <p className="loading">Loading flagged content...</p>;
  }

  if (!isAdmin(currentUser)) {
    return (
      <div className="admin-access-denied p-8 text-center" role="alert">
        <h2 className="text-xl font-bold text-red-600 mb-2">Access Denied</h2>
        <p className="text-gray-700 dark:text-gray-300">
          Administrators only. You do not have permission to view this page.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="admin-moderation p-6">
        <p className="text-red-500 font-medium">Error loading moderation dashboard: {error}</p>
      </div>
    );
  }

  return (
    <section className="admin-moderation">
      <h2 className="title">Content Moderation Dashboard</h2>
      {items.length === 0 ? (
        <p className="empty">No flagged items at the moment.</p>
      ) : (
        <table className="mod-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>Reason</th>
              <th>Reporter</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const itemId = item._id || item.id;
              return (
                <tr key={itemId}>
                  <td>{itemId}</td>
                  <td>{item.title || item.resourceTitle || `Case #${itemId}`}</td>
                  <td>{item.reason || item.flagReason || 'Flagged content'}</td>
                  <td>{item.reporter || item.reportedBy || 'Anonymous'}</td>
                  <td className="action-cell">
                    <button
                      className="action-btn deny"
                      onClick={() => handleAction(itemId, 'propose')}
                    >
                      Propose suspension
                    </button>
                    <button
                      className="action-btn suspend"
                      onClick={() => handleAction(itemId, 'approve')}
                    >
                      Approve sanction
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default withAdminGuard(ModerationDashboard);
