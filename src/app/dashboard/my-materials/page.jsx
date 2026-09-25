"use client";

import { useState } from "react";
import { useWallet } from "@/hooks/useWallet";
import { useUserMaterials, useUpdateMaterial } from "@/hooks/api/useMaterials";
import { FaEdit, FaSave, FaTimes, FaSpinner, FaCheckCircle, FaExclamationTriangle } from "react-icons/fa";
import ResourceStatusBadge from "@/components/materials/ResourceStatusBadge";
import { IMMUTABLE_MATERIAL_FIELDS } from "@/lib/backend/schemaContracts";

function EditModal({ material, isOpen, onClose }) {
  const updateMutation = useUpdateMaterial();
  const [form, setForm] = useState({
    title: material?.title || "",
    description: material?.description || "",
    price: material?.price?.toString() || "0",
    usageRights: material?.usageRights || "Standard License (download only)",
    visibility: material?.visibility || "public",
    thumbnailUrl: material?.thumbnailUrl || "",
    changeReason: "",
  });
  const [error, setError] = useState(null);

  if (!isOpen) return null;

  const handleSave = async () => {
    setError(null);
    const updates = {};
    if (form.title !== material.title) updates.title = form.title;
    if (form.description !== (material.description || "")) updates.description = form.description;
    if (Number(form.price) !== Number(material.price)) updates.price = Number(form.price);
    if (form.usageRights !== material.usageRights) updates.usageRights = form.usageRights;
    if (form.visibility !== material.visibility) updates.visibility = form.visibility;
    if (form.thumbnailUrl !== (material.thumbnailUrl || "")) updates.thumbnailUrl = form.thumbnailUrl || null;

    if (Object.keys(updates).length === 0) {
      setError("No changes detected.");
      return;
    }

    updates.changeReason = form.changeReason || null;

    try {
      await updateMutation.mutateAsync({ id: material._id, data: updates });
      onClose();
    } catch (err) {
      setError(err.message || "Update failed. Please try again.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-[90%] max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-start mb-5">
          <h2 className="text-lg font-semibold text-gray-900">Edit Material</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <FaTimes />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md flex items-start gap-2">
            <FaExclamationTriangle className="text-red-500 mt-0.5 shrink-0" />
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Title *</label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Price (XLM)</label>
            <input
              type="number"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              min="0"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Usage Rights</label>
            <select
              value={form.usageRights}
              onChange={(e) => setForm({ ...form, usageRights: e.target.value })}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
            >
              <option>Standard License (download only)</option>
              <option>Creative Commons</option>
              <option>Private Use Only</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Visibility</label>
            <select
              value={form.visibility}
              onChange={(e) => setForm({ ...form, visibility: e.target.value })}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
            >
              <option value="public">Public</option>
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Thumbnail URL</label>
            <input
              type="text"
              value={form.thumbnailUrl}
              onChange={(e) => setForm({ ...form, thumbnailUrl: e.target.value })}
              placeholder="https://..."
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
            />
          </div>

          <div className="border-t border-gray-200 pt-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">Change Reason (optional)</label>
            <input
              type="text"
              value={form.changeReason}
              onChange={(e) => setForm({ ...form, changeReason: e.target.value })}
              placeholder="e.g. Updated price, fixed typo"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
            />
          </div>

          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
            <p className="text-xs text-gray-500 font-medium mb-1">Immutable Fields</p>
            {IMMUTABLE_MATERIAL_FIELDS.map((field) => (
              <p key={field} className="text-xs text-gray-400">
                <span className="font-mono">{field}</span> — cannot be changed after publishing
              </p>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={updateMutation.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-60 text-sm font-medium flex items-center gap-2"
          >
            {updateMutation.isPending ? <FaSpinner className="animate-spin" /> : <FaSave />}
            {updateMutation.isPending ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MyMaterialsPage() {
  const { address } = useWallet();
  const { data: materials, isLoading, error: queryError } = useUserMaterials();
  const [editMaterial, setEditMaterial] = useState(null);

  const materialCount = materials?.length || 0;
  const publicCount = materials?.filter((material) => material.visibility === "public").length || 0;
  const paidCount = materials?.filter((material) => Number(material.price) > 0).length || 0;
  const estimatedRevenue = materials?.reduce((sum, material) => sum + Number(material.price || 0), 0) || 0;

  if (!address) {
    return (
      <div className="flex items-center justify-center py-24">
        <p className="text-gray-600 text-sm">
          Connect your wallet to view your uploaded materials.
        </p>
      </div>
    );
  }

  return (
    <div className="text-gray-900">
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1">My Materials</h1>
        <p className="text-sm text-gray-500">
          Manage your published educational materials. Editable fields can be updated after publishing.
        </p>
      </div>

      <div className="mb-8 grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Published materials</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{materialCount}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Public listings</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{publicCount}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Estimated revenue</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{estimatedRevenue.toFixed(2)} XLM</p>
          <p className="mt-1 text-xs text-slate-500">{paidCount} paid resources available</p>
        </div>
      </div>

      {isLoading && (
        <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse">
              <div className="h-32 bg-gray-200 rounded-lg mb-4" />
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
              <div className="h-3 bg-gray-200 rounded w-1/2 mb-4" />
              <div className="h-8 bg-gray-200 rounded-lg w-full" />
            </div>
          ))}
        </div>
      )}

      {queryError && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-600">{queryError.message}</p>
        </div>
      )}

      {!isLoading && !queryError && materials?.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-4">
            <FaEdit className="text-blue-400 text-2xl" />
          </div>
          <h2 className="text-xl font-semibold text-gray-800 mb-2">No materials yet</h2>
          <p className="text-sm text-gray-500 max-w-xs mb-6">
            Upload your first educational material to start sharing with the community.
          </p>
          <a
            href="/dashboard/upload"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-full hover:bg-blue-700 transition-colors"
          >
            Upload Material
          </a>
        </div>
      )}

      {materials?.length > 0 && (
        <>
          <div className="mb-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">Sales snapshot</h2>
                <p className="text-sm text-slate-500">Track the pricing and visibility of the materials you&apos;ve published.</p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="px-3 py-2 font-medium">Material</th>
                    <th className="px-3 py-2 font-medium">Price</th>
                    <th className="px-3 py-2 font-medium">Visibility</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {materials.map((material) => (
                    <tr key={material._id} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-3 font-medium text-slate-800">{material.title}</td>
                      <td className="px-3 py-3 text-slate-600">{material.price ? `${material.price} XLM` : "Free"}</td>
                      <td className="px-3 py-3 text-slate-600 capitalize">{material.visibility || "public"}</td>
                      <td className="px-3 py-3 text-slate-600">{material.updatedAt ? "Updated" : "Published"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {materials.map((material) => (
              <div
                key={material._id}
                className="bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow flex flex-col"
              >
              <div className="w-full h-36 bg-linear-to-br from-blue-50 to-purple-50 rounded-t-xl flex items-center justify-center overflow-hidden">
                {material.thumbnailUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={material.thumbnailUrl}
                    alt={material.title}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <FaEdit className="text-blue-300 text-4xl" />
                )}
              </div>

              <div className="p-5 flex flex-col flex-1">
                <h3 className="font-semibold text-gray-900 text-sm leading-snug mb-1 line-clamp-2">
                  {material.title}
                </h3>

                <ResourceStatusBadge material={material} max={3} className="mb-2" />

                {material.description && (
                  <p className="text-xs text-gray-500 line-clamp-2 mb-3">{material.description}</p>
                )}

                <div className="mt-auto space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">
                      {material.price ? `${material.price} XLM` : "Free"}
                    </span>
                    <span className={`flex items-center gap-1 ${
                      material.visibility === "public" ? "text-green-600" : "text-amber-600"
                    }`}>
                      <FaCheckCircle size={10} />
                      {material.visibility}
                    </span>
                  </div>

                  {material.updatedAt && (
                    <p className="text-xs text-gray-400">
                      Updated: {new Date(material.updatedAt).toLocaleDateString()}
                    </p>
                  )}

                  <button
                    onClick={() => setEditMaterial(material)}
                    className="w-full flex items-center justify-center gap-2 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    <FaEdit size={14} />
                    Edit Material
                  </button>
                </div>
              </div>
            </div>
            ))}
          </div>
        </>
      )}

      <EditModal
        material={editMaterial}
        isOpen={!!editMaterial}
        onClose={() => setEditMaterial(null)}
      />
    </div>
  );
}
