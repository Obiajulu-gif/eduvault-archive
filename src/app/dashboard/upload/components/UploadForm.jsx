"use client";

import Image from "next/image";
import { useState } from "react";
import { FaCloudUploadAlt } from "react-icons/fa";
import Cropper from "react-easy-crop";
import { useWallet } from "@/hooks/useWallet";
import { WalletStatus } from "@/providers/WalletProvider";
import { useUploadFile, useCreateMaterial } from "@/hooks/api/useMaterials";
import { getCroppedImageBlob } from "./cropImage";

export default function UploadForm() {
  const { state } = useWallet();
  const address = state.status === WalletStatus.Connected ? state.session.address : null;
  const uploadFileMutation = useUploadFile();
  const createMaterialMutation = useCreateMaterial();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [usageRights, setUsageRights] = useState("Standard License (download only)");
  const [visibility, setVisibility] = useState("public");

  const [docFile, setDocFile] = useState(null);
  const [docFileName, setDocFileName] = useState(null);
  const [thumbFile, setThumbFile] = useState(null);
  const [thumbPreview, setThumbPreview] = useState(null);
  const [thumbCrop, setThumbCrop] = useState({ x: 0, y: 0 });
  const [thumbZoom, setThumbZoom] = useState(1);
  const [croppedPixels, setCroppedPixels] = useState(null);
  const [showCropper, setShowCropper] = useState(false);

  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const handleDocChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setDocFile(file);
      setDocFileName(file.name);
    }
  };

  const handleThumbChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setThumbFile(file);
      setThumbPreview(URL.createObjectURL(file));
      setShowCropper(true);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!title || !docFile) {
      setError("Title and document file are required.");
      return;
    }

    if (!address) {
      setError("Please connect your wallet to upload a material.");
      return;
    }

    try {
      const formData = new FormData();
      formData.append("file", docFile);
      if (thumbFile && thumbPreview && croppedPixels) {
        const croppedBlob = await getCroppedImageBlob(
          thumbPreview,
          croppedPixels,
          thumbFile.type || "image/jpeg",
        );
        formData.append("thumbnail", croppedBlob, `thumb-cropped.${thumbFile.type?.split("/")[1] || "jpg"}`);
      } else if (thumbFile) {
        formData.append("thumbnail", thumbFile);
      }
      formData.append("name", title);
      formData.append("description", description);
      formData.append("price", price);
      formData.append("usageRights", usageRights);
      formData.append("visibility", visibility);
      formData.append("owner", address);

      // 1. Upload to Pinata
      const uploadData = await uploadFileMutation.mutateAsync(formData);

      if (!uploadData?.metadata) {
        throw new Error("File upload failed");
      }

      // 2. Create database record
      await createMaterialMutation.mutateAsync({
        title,
        description,
        price,
        usageRights,
        visibility,
        storageKey: uploadData.storageKey,
        thumbnail: uploadData.image,
        metadataUrl: uploadData.metadata,
        creator: address,
      });

      setSuccess(
        "Document uploaded successfully and record created!"
      );
      // Reset form
      setTitle("");
      setDescription("");
      setPrice("");
      setDocFile(null);
      setDocFileName(null);
      setThumbFile(null);
      setThumbPreview(null);
      setShowCropper(false);
      setThumbCrop({ x: 0, y: 0 });
      setThumbZoom(1);
      setCroppedPixels(null);
    } catch (err) {
      console.error("Upload Error:", err);
      setError(err?.message || "Something went wrong. Please try again.");
    }
  };

  const submitting = uploadFileMutation.isPending || createMaterialMutation.isPending;

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm"
    >
      <h2 className="text-xl font-bold mb-6">Create a New Study Resource</h2>
      <p className="text-sm text-gray-600 mb-8">
        Upload lecture notes, projects, or past questions. The active chain layer is moving to Soroban, so this form handles file storage and cataloging.
      </p>

      <div className="mb-5">
        <label className="block text-sm font-medium mb-2">Document Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. ECO 304 - Development Economics Lecture Notes"
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
          required
        />
      </div>

      <div className="mb-5">
        <label className="block text-sm font-medium mb-2">Short Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Comprehensive lecture notes covering key development theories and examples."
          rows={3}
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
        />
      </div>

      <div className="mb-5">
        <label className="block text-sm font-medium mb-2">Thumbnail Image</label>
        <div className="flex flex-col gap-4">
          <input type="file" accept="image/*" onChange={handleThumbChange} className="text-sm" />
          {thumbPreview && showCropper && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <p className="text-xs text-gray-600 mb-2">
                Crop thumbnail (locked 4:3 ratio for marketplace cards)
              </p>
              <div className="relative h-56 w-full overflow-hidden rounded-md bg-gray-900">
                <Cropper
                  image={thumbPreview}
                  crop={thumbCrop}
                  zoom={thumbZoom}
                  aspect={4 / 3}
                  onCropChange={setThumbCrop}
                  onZoomChange={setThumbZoom}
                  onCropComplete={(_, croppedAreaPixels) =>
                    setCroppedPixels(croppedAreaPixels)
                  }
                />
              </div>
              <div className="mt-3 flex items-center gap-3">
                <label className="text-xs text-gray-600">Zoom</label>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.1}
                  value={thumbZoom}
                  onChange={(event) => setThumbZoom(Number(event.target.value))}
                />
                <button
                  type="button"
                  onClick={() => setShowCropper(false)}
                  className="ml-auto rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-white"
                >
                  Use Crop
                </button>
              </div>
            </div>
          )}
          {thumbPreview && !showCropper && (
            <div className="flex items-center gap-4">
              <Image
                src={thumbPreview}
                alt="Final Thumbnail Preview"
                width={128}
                height={96}
                className="rounded object-cover border"
              />
              <button
                type="button"
                onClick={() => setShowCropper(true)}
                className="rounded-md border border-gray-300 px-3 py-2 text-xs hover:bg-gray-100"
              >
                Re-crop thumbnail
              </button>
            </div>
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
          <label
            htmlFor="file-upload"
            className="cursor-pointer flex flex-col items-center justify-center"
          >
            <FaCloudUploadAlt className="text-3xl text-blue-500 mb-2" />
            <p className="text-sm text-gray-600 mb-2">
              {docFileName ? (
                <span className="font-medium text-gray-800">{docFileName}</span>
              ) : (
                <>
                  Tap to Upload{" "}
                  <span className="text-gray-400">
                    (.pdf, .docx, .pptx, .zip | 10MB max)
                  </span>
                </>
              )}
            </p>
            <div
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Choose File
            </div>
          </label>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4 mb-5">
        <div>
          <label className="block text-sm font-medium mb-2">Set Your Price (optional)</label>
          <input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="amount"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">Usage Rights</label>
          <select
            value={usageRights}
            onChange={(e) => setUsageRights(e.target.value)}
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
              id="public"
              name="visibility"
              checked={visibility === "public"}
              onChange={() => setVisibility("public")}
              className="accent-blue-600"
            />
            Public (default) - Anyone can view or download.
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              id="private"
              name="visibility"
              checked={visibility === "private"}
              onChange={() => setVisibility("private")}
              className="accent-blue-600"
            />
            Private - Only you and invited users can access.
          </label>
        </div>
      </div>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
      {success && <p className="text-green-600 text-sm mb-4">{success}</p>}

      <div className="flex justify-end gap-4">
        <button
          type="submit"
          disabled={submitting}
          className="px-5 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition text-sm font-medium disabled:opacity-60"
        >
          {submitting ? "Processing..." : "Submit Upload"}
        </button>
      </div>
    </form>
  );
}
