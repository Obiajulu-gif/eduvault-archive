"use client";

import { useState } from "react";
import Image from "next/image";
import { FaCloudUploadAlt } from "react-icons/fa";
import { useAccount } from "wagmi";
import {
  createFormState,
  setFieldState,
  setSubmitting,
  validateUpload,
} from "@/lib/forms/validation";

export default function UploadForm() {
  const { address } = useAccount();
  const [success, setSuccess] = useState(null);
  const [formState, setFormState] = useState(
    createFormState({
      title: "",
      description: "",
      price: "",
      usageRights: "Standard License (download only)",
      visibility: "public",
      docFile: null,
      docFileName: "",
      thumbFile: null,
      thumbPreview: null,
    })
  );

  const handleDocChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFormState((state) => ({
      ...state,
      values: { ...state.values, docFileName: file.name, docFile: file },
    }));
  };

  const handleThumbChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFormState((state) => ({
      ...state,
      values: {
        ...state.values,
        thumbFile: file,
        thumbPreview: URL.createObjectURL(file),
      },
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSuccess(null);

    const errors = validateUpload(formState.values);
    if (Object.keys(errors).length > 0) {
      setFormState((state) => ({ ...state, errors, submitError: null }));
      return;
    }

    if (!address) {
      setFormState((state) => ({
        ...state,
        submitError: "Please connect your wallet to upload a material.",
      }));
      return;
    }

    setFormState((state) => setSubmitting(state, true));

    try {
      const formData = new FormData();
      formData.append("file", formState.values.docFile);
      if (formState.values.thumbFile) formData.append("thumbnail", formState.values.thumbFile);
      formData.append("name", formState.values.title);
      formData.append("description", formState.values.description);
      formData.append("price", formState.values.price);
      formData.append("usageRights", formState.values.usageRights);
      formData.append("visibility", formState.values.visibility);
      formData.append("owner", address);

      const uploadRes = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      const uploadData = await uploadRes.json();

      if (!uploadRes.ok || !uploadData?.metadata) {
        throw new Error(uploadData?.error || "File upload failed");
      }

      setFormState((state) => ({
        ...state,
        submitError: null,
        isSubmitting: false,
      }));
      setSuccess("Document uploaded successfully. Soroban-backed publishing will replace the legacy mint path.");
    } catch (err) {
      setFormState((state) => ({
        ...state,
        submitError: err?.message || "Something went wrong. Please try again.",
        isSubmitting: false,
      }));
    } finally {
      setFormState((state) => setSubmitting(state, false));
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm">
      <h2 className="text-xl font-bold mb-6">Create a New Study Resource</h2>
      <p className="text-sm text-gray-600 mb-8">
        Upload lecture notes, projects, or past questions. The active chain layer is moving to Soroban, so this form only handles file and metadata submission today.
      </p>

      <div className="mb-5">
        <label className="block text-sm font-medium mb-2">Document Title</label>
        <input
          type="text"
          value={formState.values.title}
          onChange={(e) => setFormState((state) => setFieldState(state, "title", e.target.value))}
          placeholder="e.g. ECO 304 - Development Economics Lecture Notes"
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
          required
        />
        {formState.errors.title && <p className="text-red-600 text-xs mt-1">{formState.errors.title}</p>}
      </div>

      <div className="mb-5">
        <label className="block text-sm font-medium mb-2">Short Description</label>
        <textarea
          value={formState.values.description}
          onChange={(e) => setFormState((state) => setFieldState(state, "description", e.target.value))}
          placeholder="Comprehensive lecture notes covering key development theories and examples."
          rows={3}
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
        />
        {formState.errors.description && <p className="text-red-600 text-xs mt-1">{formState.errors.description}</p>}
      </div>

      <div className="mb-5">
        <label className="block text-sm font-medium mb-2">Thumbnail Image</label>
        <div className="flex items-center gap-4">
          <input type="file" accept="image/*" onChange={handleThumbChange} className="text-sm" />
          {formState.values.thumbPreview && (
            <Image
              src={formState.values.thumbPreview}
              alt="Thumbnail Preview"
              width={64}
              height={64}
              className="rounded object-cover border"
            />
          )}
        </div>
      </div>

      <div className="mb-5">
        <label className="block text-sm font-medium mb-2">Upload Your File</label>
        <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-blue-400 transition">
          <input
            type="file"
            id="file-upload"
            className="hidden"
            onChange={handleDocChange}
            accept=".pdf,.doc,.docx,.ppt,.pptx,.zip"
          />
          <label htmlFor="file-upload" className="cursor-pointer flex flex-col items-center justify-center">
            <FaCloudUploadAlt className="text-3xl text-blue-500 mb-2" />
            <p className="text-sm text-gray-600 mb-2">
              {formState.values.docFileName ? (
                <span className="font-medium text-gray-800">{formState.values.docFileName}</span>
              ) : (
                <>
                  Tap to Upload{" "}
                  <span className="text-gray-400">(.pdf, .docx, .pptx, .zip | 10MB max)</span>
                </>
              )}
            </p>
            <button type="button" className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">
              Choose File
            </button>
          </label>
        </div>
        {formState.errors.docFile && <p className="text-red-600 text-xs mt-1">{formState.errors.docFile}</p>}
      </div>

      <div className="grid sm:grid-cols-2 gap-4 mb-5">
        <div>
          <label className="block text-sm font-medium mb-2">Set Your Price (optional)</label>
          <input
            type="number"
            value={formState.values.price}
            onChange={(e) => setFormState((state) => setFieldState(state, "price", e.target.value))}
            placeholder="amount"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
          />
          {formState.errors.price && <p className="text-red-600 text-xs mt-1">{formState.errors.price}</p>}
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">Usage Rights</label>
          <select
            value={formState.values.usageRights}
            onChange={(e) => setFormState((state) => setFieldState(state, "usageRights", e.target.value))}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
          >
            <option>Standard License (download only)</option>
            <option>Creative Commons</option>
            <option>Private Use Only</option>
          </select>
        </div>
      </div>

      <div className="mb-6">
        <label className="block text-sm font-medium mb-2">Visibility</label>
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="visibility"
              checked={formState.values.visibility === "public"}
              onChange={() => setFormState((state) => setFieldState(state, "visibility", "public"))}
              className="accent-blue-600"
            />
            Public (default) - Anyone can view or download.
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="visibility"
              checked={formState.values.visibility === "private"}
              onChange={() => setFormState((state) => setFieldState(state, "visibility", "private"))}
              className="accent-blue-600"
            />
            Private - Only you and invited users can access.
          </label>
        </div>
      </div>

      {formState.submitError && <p className="text-red-600 text-sm mb-4">{formState.submitError}</p>}
      {success && <p className="text-green-600 text-sm mb-4">{success}</p>}

      <div className="flex justify-end gap-4">
        <button
          type="submit"
          disabled={formState.isSubmitting}
          className="px-5 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition text-sm font-medium disabled:opacity-60"
        >
          {formState.isSubmitting ? "Uploading..." : "Submit Upload"}
        </button>
      </div>
    </form>
  );
}
