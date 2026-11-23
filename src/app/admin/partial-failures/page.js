'use client';

import { useState, useEffect, useCallback } from 'react';

export default function PartialFailuresDashboardPage() {
  const [data, setData] = useState({ items: [], summary: {} });
  const [loading, setLoading] = useState(true);
  const [domainFilter, setDomainFilter] = useState('all');
  const [severityFilter, setSeverityFilter] = useState('');
  const [userActionFilter, setUserActionFilter] = useState('');
  const [selectedFailure, setSelectedFailure] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [triage, setTriage] = useState({ summary: {}, items: [] });
  const [triageLoading, setTriageLoading] = useState(true);

  const fetchFailures = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (domainFilter && domainFilter !== 'all') params.set('domain', domainFilter);
      if (severityFilter) params.set('severity', severityFilter);
      if (userActionFilter !== '') params.set('requiresUserAction', userActionFilter);

      const res = await fetch(`/api/admin/partial-failures?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data || { items: [], summary: {} });
      }
    } catch (err) {
      console.error('Failed to load partial failures:', err);
    } finally {
      setLoading(false);
    }
  }, [domainFilter, severityFilter, userActionFilter]);

  useEffect(() => {
    fetchFailures();
  }, [fetchFailures]);

  // Unresolved-only triage view (#1101): SLA age and recommended next action.
  const fetchTriage = useCallback(async () => {
    setTriageLoading(true);
    try {
      const res = await fetch('/api/admin/partial-failures/triage');
      if (res.ok) {
        const json = await res.json();
        setTriage(json.data || { summary: {}, items: [] });
      }
    } catch (err) {
      console.error('Failed to load unresolved-failures triage:', err);
    } finally {
      setTriageLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTriage();
  }, [fetchTriage]);

  const handleRetry = async (failureId) => {
    setActionLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/partial-failures/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ failureId }),
      });
      const result = await res.json();
      if (res.ok) {
        setMessage({ type: 'success', text: result.data?.message || 'Retry queued successfully!' });
        fetchFailures();
      } else {
        setMessage({ type: 'error', text: result.error || 'Retry failed' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setActionLoading(false);
    }
  };

  const handleResolve = async (failureId, resolution) => {
    setActionLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/partial-failures', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ failureId, resolution }),
      });
      const result = await res.json();
      if (res.ok) {
        setMessage({ type: 'success', text: `Marked as ${resolution}` });
        setSelectedFailure(null);
        fetchFailures();
      } else {
        setMessage({ type: 'error', text: result.error || 'Failed to update status' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 md:p-10 font-sans">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Partial-Failure Operations Dashboard</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Monitor, inspect causes, safely retry, and resolve partial failures across async background jobs, integration side-effects, and user operations.
          </p>
        </div>

        {/* Message Banner */}
        {message && (
          <div className={`p-4 rounded-xl border text-sm flex items-center justify-between ${
            message.type === 'success' ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-200' : 'bg-rose-950/60 border-rose-500/40 text-rose-200'
          }`}>
            <span>{message.text}</span>
            <button onClick={() => setMessage(null)} className="ml-4 text-xs font-mono opacity-70 hover:opacity-100">Dismiss</button>
          </div>
        )}

        {/* Summary Stat Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="p-4 bg-zinc-900/60 border border-zinc-800 rounded-xl">
            <div className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Unresolved Failures</div>
            <div className="text-2xl font-bold mt-1 text-white">{data.summary?.unresolved || 0}</div>
          </div>
          <div className="p-4 bg-amber-950/20 border border-amber-900/40 rounded-xl">
            <div className="text-xs font-medium text-amber-400 uppercase tracking-wider">Requires User Action</div>
            <div className="text-2xl font-bold mt-1 text-amber-300">{data.summary?.requiresUserActionCount || 0}</div>
          </div>
          <div className="p-4 bg-zinc-900/60 border border-zinc-800 rounded-xl">
            <div className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Async Jobs</div>
            <div className="text-2xl font-bold mt-1 text-zinc-200">{data.summary?.byDomain?.async_jobs || 0}</div>
          </div>
          <div className="p-4 bg-zinc-900/60 border border-zinc-800 rounded-xl">
            <div className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Integrations</div>
            <div className="text-2xl font-bold mt-1 text-zinc-200">{data.summary?.byDomain?.integrations || 0}</div>
          </div>
        </div>

        {/* Unresolved triage queue (#1101) */}
        <section className="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4" aria-label="Unresolved failure triage">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-sm font-semibold text-white uppercase tracking-wider">Unresolved Triage Queue</h2>
              <p className="text-xs text-zinc-500 mt-1">
                Oldest and most severe open failures first, with a recommended next action and SLA status.
              </p>
            </div>
            <button
              onClick={fetchTriage}
              disabled={triageLoading}
              className="text-xs font-medium px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-zinc-200 border border-zinc-700 transition disabled:opacity-50"
            >
              Refresh triage
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 text-xs">
            <div className="p-3 rounded-lg bg-rose-950/30 border border-rose-900/40">
              <div className="text-rose-400 uppercase tracking-wider">SLA breached</div>
              <div className="text-lg font-bold text-rose-200 mt-1">{triage.summary?.slaBreached || 0}</div>
            </div>
            <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-900/40">
              <div className="text-amber-400 uppercase tracking-wider">Needs user action</div>
              <div className="text-lg font-bold text-amber-200 mt-1">{triage.summary?.requiresUserAction || 0}</div>
            </div>
            <div className="p-3 rounded-lg bg-indigo-950/30 border border-indigo-900/40">
              <div className="text-indigo-400 uppercase tracking-wider">Safe to retry</div>
              <div className="text-lg font-bold text-indigo-200 mt-1">{triage.summary?.retryable || 0}</div>
            </div>
            <div className="p-3 rounded-lg bg-zinc-950/60 border border-zinc-800">
              <div className="text-zinc-400 uppercase tracking-wider">Oldest open</div>
              <div className="text-lg font-bold text-zinc-200 mt-1">
                {triage.summary?.oldestAgeMs ? `${Math.round(triage.summary.oldestAgeMs / 60000)}m` : '—'}
              </div>
            </div>
          </div>

          {triageLoading ? (
            <div className="p-6 text-center text-xs text-zinc-500">Loading triage queue...</div>
          ) : triage.items?.length === 0 ? (
            <div className="p-6 text-center text-xs text-zinc-500">No unresolved failures need triage.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-zinc-500 uppercase tracking-wider border-b border-zinc-800">
                  <tr>
                    <th className="py-2 px-3">Failure</th>
                    <th className="py-2 px-3">Severity</th>
                    <th className="py-2 px-3">Age</th>
                    <th className="py-2 px-3">SLA</th>
                    <th className="py-2 px-3">Next action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {triage.items.map((item) => (
                    <tr key={`triage-${item.failureId}`} className="hover:bg-zinc-800/30">
                      <td className="py-2 px-3 font-mono text-zinc-200">
                        <div>{item.operation}</div>
                        <div className="text-[10px] text-zinc-500">{item.failureId}</div>
                      </td>
                      <td className="py-2 px-3 text-zinc-300">{item.severity}</td>
                      <td className="py-2 px-3 text-zinc-300">{Math.round(item.ageMs / 60000)}m</td>
                      <td className="py-2 px-3">
                        {item.slaBreached ? (
                          <span className="text-rose-300">Breached</span>
                        ) : (
                          <span className="text-emerald-300">Within target</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-zinc-300" title={item.nextAction?.reason}>
                        {item.nextAction?.label || 'Inspect'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Filter Controls */}
        <div className="flex flex-wrap gap-4 items-center justify-between bg-zinc-900/40 p-4 border border-zinc-800/80 rounded-xl">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="text-xs text-zinc-400 font-medium">Domain:</div>
            <select
              value={domainFilter}
              onChange={(e) => setDomainFilter(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 text-xs rounded-lg px-3 py-1.5 text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="all">All Domains</option>
              <option value="async_jobs">Async Jobs</option>
              <option value="integrations">Integrations (Outbox/Indexer)</option>
              <option value="user_operations">User Operations</option>
            </select>

            <div className="text-xs text-zinc-400 font-medium ml-2">Severity:</div>
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 text-xs rounded-lg px-3 py-1.5 text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">All Severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>

            <div className="text-xs text-zinc-400 font-medium ml-2">User Action:</div>
            <select
              value={userActionFilter}
              onChange={(e) => setUserActionFilter(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 text-xs rounded-lg px-3 py-1.5 text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">Any</option>
              <option value="true">User Action Required</option>
              <option value="false">Automatic/Operator Fixable</option>
            </select>
          </div>

          <button
            onClick={fetchFailures}
            className="text-xs font-medium px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-zinc-200 border border-zinc-700 transition"
          >
            Refresh
          </button>
        </div>

        {/* Failures Table */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl overflow-hidden shadow-xl">
          {loading ? (
            <div className="p-12 text-center text-sm text-zinc-500">Loading partial failure records...</div>
          ) : data.items?.length === 0 ? (
            <div className="p-12 text-center text-sm text-zinc-500">No unresolved partial failures matching criteria.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-zinc-950/60 border-b border-zinc-800 text-zinc-400 uppercase tracking-wider">
                  <tr>
                    <th className="py-3 px-4">Operation & ID</th>
                    <th className="py-3 px-4">Domain</th>
                    <th className="py-3 px-4">Severity</th>
                    <th className="py-3 px-4">Cause / Error</th>
                    <th className="py-3 px-4">User Action</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {data.items.map((item) => (
                    <tr key={item.failureId} className="hover:bg-zinc-800/30 transition">
                      <td className="py-3 px-4 font-mono font-medium text-white">
                        <div>{item.operation}</div>
                        <div className="text-[10px] text-zinc-500 font-normal">{item.failureId}</div>
                      </td>
                      <td className="py-3 px-4 text-zinc-300">
                        <span className="px-2 py-0.5 rounded-full bg-zinc-800 text-[11px]">
                          {item.domain}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${
                          item.severity === 'critical' ? 'bg-rose-950/80 text-rose-300 border border-rose-800/40' :
                          item.severity === 'high' ? 'bg-orange-950/80 text-orange-300 border border-orange-800/40' :
                          'bg-zinc-800 text-zinc-300'
                        }`}>
                          {item.severity}
                        </span>
                      </td>
                      <td className="py-3 px-4 max-w-xs truncate text-zinc-300" title={item.errorCause?.message}>
                        {item.errorCause?.message}
                      </td>
                      <td className="py-3 px-4">
                        {item.requiresUserAction ? (
                          <span className="inline-flex items-center gap-1 text-amber-400 font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                            Required
                          </span>
                        ) : (
                          <span className="text-zinc-500">None</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right space-x-2">
                        <button
                          onClick={() => setSelectedFailure(item)}
                          className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded text-xs transition"
                        >
                          Inspect
                        </button>
                        {item.canRetrySafely && (
                          <button
                            disabled={actionLoading}
                            onClick={() => handleRetry(item.failureId)}
                            className="px-2.5 py-1 bg-indigo-600/80 hover:bg-indigo-600 text-white rounded text-xs transition font-medium disabled:opacity-50"
                          >
                            Retry
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Failure Inspection Modal */}
        {selectedFailure && (
          <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 backdrop-blur-sm">
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-2xl w-full p-6 space-y-6 shadow-2xl">
              <div className="flex items-start justify-between border-b border-zinc-800 pb-4">
                <div>
                  <h3 className="text-lg font-bold text-white">Failure Inspection: {selectedFailure.operation}</h3>
                  <div className="text-xs text-zinc-400 font-mono mt-0.5">{selectedFailure.failureId}</div>
                </div>
                <button
                  onClick={() => setSelectedFailure(null)}
                  className="text-zinc-400 hover:text-white text-lg font-bold"
                >
                  ✕
                </button>
              </div>

              {/* User Action Callout if Required */}
              {selectedFailure.requiresUserAction && (
                <div className="p-4 bg-amber-950/40 border border-amber-600/40 rounded-xl space-y-1">
                  <div className="text-xs font-bold text-amber-300 uppercase tracking-wider flex items-center gap-2">
                    <span>⚠️ User Action Required</span>
                    {selectedFailure.userActionType && (
                      <span className="px-1.5 py-0.5 bg-amber-900/60 rounded text-[10px] font-mono lowercase">
                        {selectedFailure.userActionType}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-amber-200">
                    {selectedFailure.userActionGuidance || 'User must take action before this operation can complete.'}
                  </div>
                </div>
              )}

              {/* Error Details */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Error Cause & Stack</div>
                <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800 font-mono text-xs text-rose-300 overflow-x-auto">
                  {selectedFailure.errorCause?.message}
                </div>
              </div>

              {/* Context Metadata */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Redacted Execution Context</div>
                <pre className="p-3 bg-zinc-950 rounded-lg border border-zinc-800 font-mono text-xs text-zinc-300 overflow-x-auto max-h-48">
                  {JSON.stringify(selectedFailure.context, null, 2)}
                </pre>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-between pt-4 border-t border-zinc-800">
                <div className="flex gap-2">
                  <button
                    disabled={actionLoading}
                    onClick={() => handleResolve(selectedFailure.failureId, 'resolved')}
                    className="px-3 py-1.5 bg-emerald-600/80 hover:bg-emerald-600 text-white rounded-lg text-xs font-medium transition"
                  >
                    Mark Resolved
                  </button>
                  <button
                    disabled={actionLoading}
                    onClick={() => handleResolve(selectedFailure.failureId, 'abandoned')}
                    className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-medium transition"
                  >
                    Abandon
                  </button>
                </div>
                {selectedFailure.canRetrySafely && (
                  <button
                    disabled={actionLoading}
                    onClick={() => {
                      handleRetry(selectedFailure.failureId);
                      setSelectedFailure(null);
                    }}
                    className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition shadow-lg"
                  >
                    Safe Retry Now
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
