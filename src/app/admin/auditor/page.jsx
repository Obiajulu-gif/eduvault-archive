'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

export default function AuditorProvenancePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('provenance'); // 'provenance' | 'entitlements' | 'integrity'

  // Filter states
  const [materialIdFilter, setMaterialIdFilter] = useState('');
  const [buyerAddressFilter, setBuyerAddressFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [batchIdFilter, setBatchIdFilter] = useState('');

  const fetchAuditorData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (materialIdFilter.trim()) params.set('materialId', materialIdFilter.trim());
      if (buyerAddressFilter.trim()) params.set('buyerAddress', buyerAddressFilter.trim());
      if (kindFilter && kindFilter !== 'all') params.set('kind', kindFilter);
      if (batchIdFilter.trim()) params.set('importBatchId', batchIdFilter.trim());

      const res = await fetch(`/api/admin/auditor?${params.toString()}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}: Failed to fetch auditor records`);
      }

      const json = await res.json();
      setData(json.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [materialIdFilter, buyerAddressFilter, kindFilter, batchIdFilter]);

  useEffect(() => {
    fetchAuditorData();
  }, [fetchAuditorData]);

  const handleExportCsv = () => {
    const params = new URLSearchParams();
    if (materialIdFilter.trim()) params.set('materialId', materialIdFilter.trim());
    if (buyerAddressFilter.trim()) params.set('buyerAddress', buyerAddressFilter.trim());
    if (kindFilter && kindFilter !== 'all') params.set('kind', kindFilter);
    if (batchIdFilter.trim()) params.set('importBatchId', batchIdFilter.trim());
    params.set('format', 'csv');

    window.open(`/api/admin/auditor?${params.toString()}`, '_blank');
  };

  const handleExportJson = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `auditor-evidence-bundle-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-6 md:p-10 font-sans">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
          <div>
            <div className="flex items-center gap-2 text-sm text-indigo-400 mb-1">
              <Link href="/admin" className="hover:underline">Admin</Link>
              <span>/</span>
              <span className="text-slate-400">Auditor Portal</span>
            </div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-white">
              Material Provenance & Entitlement Changes
            </h1>
            <p className="text-slate-400 text-sm mt-1">
              Cryptographic ancestry verification, import tracking, and entitlement transition audit logs.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleExportCsv}
              disabled={loading || !data}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium rounded-lg border border-slate-700 transition disabled:opacity-50"
            >
              Export CSV
            </button>
            <button
              onClick={handleExportJson}
              disabled={loading || !data}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg shadow-sm transition disabled:opacity-50"
            >
              Export Evidence Bundle
            </button>
          </div>
        </div>

        {/* Metrics Overview Cards */}
        {data && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-5">
              <div className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Materials Scanned</div>
              <div className="text-3xl font-bold text-white mt-2">{data.meta?.scannedMaterials ?? 0}</div>
              <div className="text-xs text-slate-500 mt-1">
                Imports: {data.provenance?.summary?.import ?? 0} | Derived: {data.provenance?.summary?.derived ?? 0}
              </div>
            </div>

            <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-5">
              <div className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Active Entitlements</div>
              <div className="text-3xl font-bold text-emerald-400 mt-2">{data.entitlements?.activeCount ?? 0}</div>
              <div className="text-xs text-slate-500 mt-1">
                Total tracked: {data.entitlements?.totalCount ?? 0}
              </div>
            </div>

            <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-5">
              <div className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Revoked / Inactive</div>
              <div className="text-3xl font-bold text-amber-400 mt-2">{data.entitlements?.revokedCount ?? 0}</div>
              <div className="text-xs text-slate-500 mt-1">Refunds & policy revocations</div>
            </div>

            <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-5">
              <div className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Chain Integrity</div>
              <div className="text-2xl font-bold mt-2 flex items-center gap-2">
                {data.integrity?.verified ? (
                  <span className="text-emerald-400 flex items-center gap-1.5 text-xl">
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
                    Verified Intact
                  </span>
                ) : (
                  <span className="text-rose-400 flex items-center gap-1.5 text-xl">
                    <span className="h-2.5 w-2.5 rounded-full bg-rose-400"></span>
                    Issues Detected ({data.integrity?.brokenChains ?? 0})
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {data.integrity?.issues?.length ? `${data.integrity.issues.length} warnings reported` : 'Zero gaps or tampered hashes'}
              </div>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-5">
          <div className="text-sm font-semibold text-slate-200 mb-3">Filter Auditor Search</div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Material ID</label>
              <input
                type="text"
                placeholder="e.g. 64f1..."
                value={materialIdFilter}
                onChange={(e) => setMaterialIdFilter(e.target.value)}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Buyer Wallet Address</label>
              <input
                type="text"
                placeholder="e.g. GAB..."
                value={buyerAddressFilter}
                onChange={(e) => setBuyerAddressFilter(e.target.value)}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Provenance Kind</label>
              <select
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value)}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="all">All Kinds</option>
                <option value="original">Original Listings</option>
                <option value="import">Bulk Imports</option>
                <option value="derived">Derivatives & Forks</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Import Batch ID</label>
              <input
                type="text"
                placeholder="e.g. batch-2026..."
                value={batchIdFilter}
                onChange={(e) => setBatchIdFilter(e.target.value)}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 space-x-6 text-sm font-medium">
          <button
            onClick={() => setActiveTab('provenance')}
            className={`pb-3 border-b-2 transition ${
              activeTab === 'provenance'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Material Provenance ({data?.provenance?.rows?.length ?? 0})
          </button>
          <button
            onClick={() => setActiveTab('entitlements')}
            className={`pb-3 border-b-2 transition ${
              activeTab === 'entitlements'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Entitlement Changes ({data?.entitlements?.rows?.length ?? 0})
          </button>
          <button
            onClick={() => setActiveTab('integrity')}
            className={`pb-3 border-b-2 transition ${
              activeTab === 'integrity'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Integrity Verification & Issues ({data?.integrity?.issues?.length ?? 0})
          </button>
        </div>

        {/* Content Area */}
        {error && (
          <div className="p-4 bg-rose-950/40 border border-rose-800/80 rounded-xl text-rose-200 flex items-center justify-between">
            <div>
              <div className="font-semibold text-sm">Failed to Load Auditor Records</div>
              <div className="text-xs mt-1 text-rose-300">{error}</div>
            </div>
            <button
              onClick={fetchAuditorData}
              className="px-3 py-1.5 bg-rose-800 hover:bg-rose-700 text-white rounded text-xs font-medium transition"
            >
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center text-slate-500 space-y-3">
            <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
            <div className="text-sm">Fetching cryptographically verified audit records...</div>
          </div>
        ) : (
          <>
            {/* Tab: Provenance */}
            {activeTab === 'provenance' && (
              <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm text-slate-300">
                    <thead className="bg-slate-800/80 text-xs uppercase text-slate-400 font-semibold border-b border-slate-700">
                      <tr>
                        <th className="px-5 py-3">Material Title & ID</th>
                        <th className="px-5 py-3">Kind</th>
                        <th className="px-5 py-3">Origin / Batch</th>
                        <th className="px-5 py-3">Actor Wallet</th>
                        <th className="px-5 py-3">Revisions</th>
                        <th className="px-5 py-3">Transform</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {data?.provenance?.rows?.length === 0 ? (
                        <tr>
                          <td colSpan="6" className="px-5 py-8 text-center text-slate-500">
                            No provenance records match the specified filters.
                          </td>
                        </tr>
                      ) : (
                        data?.provenance?.rows?.map((row) => (
                          <tr key={row.materialId} className="hover:bg-slate-800/30 transition">
                            <td className="px-5 py-4">
                              <div className="font-medium text-white">{row.title || 'Untitled'}</div>
                              <div className="text-xs font-mono text-slate-500">{row.materialId}</div>
                            </td>
                            <td className="px-5 py-4">
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                  row.kind === 'import'
                                    ? 'bg-blue-900/60 text-blue-300 border border-blue-700'
                                    : row.kind === 'derived'
                                    ? 'bg-purple-900/60 text-purple-300 border border-purple-700'
                                    : 'bg-slate-800 text-slate-300 border border-slate-700'
                                }`}
                              >
                                {row.kind || 'none'}
                              </span>
                            </td>
                            <td className="px-5 py-4 text-xs text-slate-400">
                              {row.originSummary || row.origin?.importBatchId || 'Direct upload'}
                            </td>
                            <td className="px-5 py-4 text-xs font-mono text-slate-400">
                              {row.actorAddress || row.actor?.walletAddress || '—'}
                            </td>
                            <td className="px-5 py-4 text-xs text-slate-400">
                              {row.revisionCount ? `${row.revisionCount} changes` : '0 revisions'}
                            </td>
                            <td className="px-5 py-4 text-xs font-mono text-slate-500">
                              {row.transformVersion || '—'}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Tab: Entitlements */}
            {activeTab === 'entitlements' && (
              <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm text-slate-300">
                    <thead className="bg-slate-800/80 text-xs uppercase text-slate-400 font-semibold border-b border-slate-700">
                      <tr>
                        <th className="px-5 py-3">Material ID</th>
                        <th className="px-5 py-3">Buyer Address</th>
                        <th className="px-5 py-3">Status</th>
                        <th className="px-5 py-3">Granted At</th>
                        <th className="px-5 py-3">Revoked At / Reason</th>
                        <th className="px-5 py-3">Receipt / Tx Hash</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {data?.entitlements?.rows?.length === 0 ? (
                        <tr>
                          <td colSpan="6" className="px-5 py-8 text-center text-slate-500">
                            No entitlement changes found for current criteria.
                          </td>
                        </tr>
                      ) : (
                        data?.entitlements?.rows?.map((row) => (
                          <tr key={`${row.materialId}-${row.buyerAddress}-${row.grantedAt}`} className="hover:bg-slate-800/30 transition">
                            <td className="px-5 py-4 font-mono text-xs text-slate-300">
                              {row.materialId}
                            </td>
                            <td className="px-5 py-4 font-mono text-xs text-slate-400">
                              {row.buyerAddress || '—'}
                            </td>
                            <td className="px-5 py-4">
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                  row.active
                                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                                    : 'bg-rose-950 text-rose-300 border border-rose-800'
                                }`}
                              >
                                {row.status}
                              </span>
                            </td>
                            <td className="px-5 py-4 text-xs text-slate-400">
                              {row.grantedAt ? new Date(row.grantedAt).toLocaleString() : '—'}
                            </td>
                            <td className="px-5 py-4 text-xs text-slate-400">
                              {row.revokedAt ? (
                                <div>
                                  <span className="text-rose-400 font-medium">Revoked:</span> {row.revokedReason || 'No reason specified'}
                                </div>
                              ) : (
                                <span className="text-slate-500">None</span>
                              )}
                            </td>
                            <td className="px-5 py-4 text-xs font-mono text-slate-500">
                              {row.transactionHash ? (
                                <span title={row.transactionHash}>
                                  {row.transactionHash.slice(0, 10)}...{row.transactionHash.slice(-8)}
                                </span>
                              ) : (
                                'Direct Grant'
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Tab: Integrity & Issues */}
            {activeTab === 'integrity' && (
              <div className="space-y-4">
                <div className="p-5 bg-slate-800/60 border border-slate-700/60 rounded-xl">
                  <h3 className="text-base font-semibold text-white mb-2">Cryptographic Integrity Summary</h3>
                  <p className="text-sm text-slate-400">
                    Verifies hash ancestry chains, parent-child references, and validates that no unlinked derivatives or orphaned records exist.
                  </p>

                  <div className="mt-4 flex gap-6 text-sm">
                    <div>
                      <span className="text-slate-400">Total Records Inspected:</span>{' '}
                      <span className="font-semibold text-white">{data?.integrity?.totalRecords ?? 0}</span>
                    </div>
                    <div>
                      <span className="text-slate-400">Broken Ancestry Chains:</span>{' '}
                      <span className={`font-semibold ${data?.integrity?.brokenChains ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {data?.integrity?.brokenChains ?? 0}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl p-5">
                  <h4 className="text-sm font-semibold text-slate-200 mb-3">Integrity Findings & Warnings</h4>
                  {data?.integrity?.issues?.length === 0 ? (
                    <div className="text-sm text-emerald-400 py-4 flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-emerald-400"></span>
                      All provenance chains and entitlement hashes verified intact. No anomalies detected.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {data?.integrity?.issues?.map((issue, idx) => (
                        <div key={idx} className="p-3 bg-slate-900 border border-slate-800 rounded-lg text-xs flex justify-between items-center">
                          <div>
                            <span className="font-mono text-indigo-400 font-semibold">{issue.materialId}</span>:{' '}
                            <span className={issue.error ? 'text-rose-300' : 'text-amber-300'}>
                              {issue.error || issue.warning}
                            </span>
                          </div>
                          <span className={`px-2 py-0.5 rounded uppercase font-bold text-[10px] ${
                            issue.error ? 'bg-rose-950 text-rose-300' : 'bg-amber-950 text-amber-300'
                          }`}>
                            {issue.error ? 'Error' : 'Warning'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
