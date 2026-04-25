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
    }),
  );

  const handleDocChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFormState((state) => ({
      ...state,
      values: {
        ...state.values,
        docFile: file,
        docFileName: file.name,
      },
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
      if (formState.values.thumbFile) {
        formData.append("thumbnail", formState.values.thumbFile);
      }
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
      setSuccess(
        "Document uploaded successfully. Soroban-backed publishing will replace the legacy mint path.",
      );
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
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm"
    >
      <h2 className="mb-6 text-xl font-bold">Create a New Study Resource</h2>
      <p className="mb-8 text-sm text-gray-600">
        Upload lecture notes, projects, or past questions. The active chain
        layer is moving to Soroban, so this form only handles file and metadata
        submission today.
      </p>

      <div className="mb-5">
        <label className="mb-2 block text-sm font-medium">Document Title</label>
        <input
          type="text"
          value={formState.values.title}
          onChange={(e) =>
            setFormState((state) => setFieldState(state, "title", e.target.value))
          }
          placeholder="e.g. ECO 304 - Development Economics Lecture Notes"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          required
        />
        {formState.errors.title && (
          <p className="mt-1 text-xs text-red-600">{formState.errors.title}</p>
        )}
      </div>

      <div className="mb-5">
        <label className="mb-2 block text-sm font-medium">Short Description</label>
        <textarea
          value={formState.values.description}
          onChange={(e) =>
            setFormState((state) =>
              setFieldState(state, "description", e.target.value),
            )
          }
          placeholder="Comprehensive lecture notes covering key development theories and examples."
          rows={3}
          className="w-full resize-none rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        />
        {formState.errors.description && (
          <p className="mt-1 text-xs text-red-600">
            {formState.errors.description}
          </p>
        )}
      </div>

      <div className="mb-5">
        <label className="mb-2 block text-sm font-medium">Thumbnail Image</label>
        <div className="flex items-center gap-4">
          <input type="file" accept="image/*" onChange={handleThumbChange} />
          {formState.values.thumbPreview && (
            <Image
              src={formState.values.thumbPreview}
              alt="Thumbnail preview"
              width={64}
              height={64}
              className="rounded border object-cover"
            />
          )}
        </div>
      </div>

      <div className="mb-5">
        <label className="mb-2 block text-sm font-medium">Upload Your File</label>
        <div className="rounded-lg border-2 border-dashed border-gray-300 p-6 text-center transition hover:border-blue-400">
          <input
            type="file"
            id="file-upload"
            className="hidden"
            onChange={handleDocChange}
            accept=".pdf,.doc,.docx,.ppt,.pptx,.zip"
          />
          <label
            htmlFor="file-upload"
            className="flex cursor-pointer flex-col items-center justify-center"
          >
            <FaCloudUploadAlt className="mb-2 text-3xl text-blue-500" />
            <p className="mb-2 text-sm text-gray-600">
              {formState.values.docFileName ? (
                <span className="font-medium text-gray-800">
                  {formState.values.docFileName}
                </span>
              ) : (
                <>
                  Tap to Upload{" "}
                  <span className="text-gray-400">
                    (.pdf, .docx, .pptx, .zip | 10MB max)
                  </span>
                </>
              )}
            </p>
            <button
              type="button"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
            >
              Choose File
            </button>
          </label>
        </div>
        {formState.errors.docFile && (
          <p className="mt-1 text-xs text-red-600">{formState.errors.docFile}</p>
        )}
      </div>

      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-2 block text-sm font-medium">
            Set Your Price (optional)
          </label>
          <input
            type="number"
            value={formState.values.price}
            onChange={(e) =>
              setFormState((state) => setFieldState(state, "price", e.target.value))
            }
            placeholder="amount"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
          {formState.errors.price && (
            <p className="mt-1 text-xs text-red-600">{formState.errors.price}</p>
          )}
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium">Usage Rights</label>
          <select
            value={formState.values.usageRights}
            onChange={(e) =>
              setFormState((state) =>
                setFieldState(state, "usageRights", e.target.value),
              )
            }
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          >
            <option>Standard License (download only)</option>
            <option>Creative Commons</option>
            <option>Private Use Only</option>
          </select>
        </div>
      </div>

      <div className="mb-6">
        <label className="mb-2 block text-sm font-medium">Visibility</label>
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="visibility"
              checked={formState.values.visibility === "public"}
              onChange={() =>
                setFormState((state) =>
                  setFieldState(state, "visibility", "public"),
                )
              }
              className="accent-blue-600"
            />
            Public (default) - Anyone can view or download.
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="visibility"
              checked={formState.values.visibility === "private"}
              onChange={() =>
                setFormState((state) =>
                  setFieldState(state, "visibility", "private"),
                )
              }
              className="accent-blue-600"
            />
            Private - Only you and invited users can access.
          </label>
        </div>
      </div>

      {formState.submitError && (
        <p className="mb-4 text-sm text-red-600">{formState.submitError}</p>
      )}
      {success && <p className="mb-4 text-sm text-green-600">{success}</p>}

      <div className="flex justify-end gap-4">
        <button
          type="submit"
          disabled={formState.isSubmitting}
          className="rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-60"
        >
          {formState.isSubmitting ? "Uploading..." : "Submit Upload"}
        </button>
      </div>
    </form>
  );
}
