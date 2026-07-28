"use client";

import Image from "next/image";
import { useState } from "react";
import { FaCloudUploadAlt } from "react-icons/fa";
import Cropper from "react-easy-crop";
import { useWallet } from "@/hooks/useWallet";
import { WalletStatus } from "@/providers/WalletProvider";
import { useUploadFile, useCreateMaterial } from "@/hooks/api/useMaterials";
import { getCroppedImageBlob } from "./cropImage";
import TransactionStatusPanel from "@/components/transactions/TransactionStatusPanel";
import DragDropUpload from "@/components/DragDropUpload";
import { useTransactionCenter } from "@/providers/TransactionProvider";
import { TransactionStatus } from "@/lib/transactions/transaction";
import PayoutSplits from "@/components/PayoutSplits";

export default function UploadForm() {
  const { state } = useWallet();
  const address =
    state.status === WalletStatus.Connected ? state.session.address : null;
  const uploadFileMutation = useUploadFile();
  const createMaterialMutation = useCreateMaterial();
  const {
    activeTransaction,
    beginTransaction,
    markStatus,
    confirmTransaction,
    failTransaction,
    clearTransaction,
  } = useTransactionCenter();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [price, setPrice] = useState("");
  const [usageRights, setUsageRights] = useState(
    "Standard License (download only)",
  );
  const [visibility, setVisibility] = useState("public");
  const [level, setLevel] = useState("");

  const [savedUploadData, setSavedUploadData] = useState(null);

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
  const [fieldErrors, setFieldErrors] = useState({});
  const [payoutSplits, setPayoutSplits] = useState(null);
  const [payoutSplitsValid, setPayoutSplitsValid] = useState(true);

  const handleDocChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 50 * 1024 * 1024) {
        setFieldErrors((prev) => ({
          ...prev,
          file: `File size ${(file.size / (1024 * 1024)).toFixed(2)}MB exceeds the 50MB limit.`,
        }));
        return;
      }
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next.file;
        return next;
      });
      setDocFile(file);
      setDocFileName(file.name);
    }
  };

  const handleThumbChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        setFieldErrors((prev) => ({
          ...prev,
          thumb: `File size ${(file.size / (1024 * 1024)).toFixed(2)}MB exceeds the 5MB limit.`,
        }));
        return;
      }
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next.thumb;
        return next;
      });
      setThumbFile(file);
      setThumbPreview(URL.createObjectURL(file));
      setShowCropper(true);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setFieldErrors({});

    const errors = {};

    if (!title.trim()) {
      errors.title = "Title is required.";
    }
    if (!docFile) {
      errors.file = "Please upload a document file.";
    }
    if (price) {
      const priceNum = Number(price);
      if (isNaN(priceNum) || priceNum < 0.1) {
        errors.price = "Price must be at least 0.1 XLM.";
      }
    }

    if (!payoutSplitsValid) {
      errors.payoutSplits = "Payout splits must be valid and total 100%.";
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      failTransaction(new Error(Object.values(errors).join(" ")), {
        title: "Validation failed",
        message: "Please fix the highlighted fields before submitting.",
        retryable: false,
      });
      return;
    }

    beginTransaction({
      scope: "publish",
      title: "Publishing material",
      message: "Preparing your material for upload and wallet approval.",
    });

    if (!address) {
      setError("Please connect your wallet to upload a material.");
      failTransaction(
        new Error("Please connect your wallet to upload a material."),
        {
          title: "Wallet required",
          message: "Connect your wallet before publishing this material.",
          retryable: true,
        },
      );
      return;
    }

    try {
      markStatus(TransactionStatus.Submitting, {
        title: "Uploading material",
        message: "Uploading files and creating the on-chain record.",
      });

      let uploadData = savedUploadData;
      if (!uploadData) {
        const formData = new FormData();
        formData.append("file", docFile);
        if (thumbFile && thumbPreview && croppedPixels) {
          const croppedBlob = await getCroppedImageBlob(
            thumbPreview,
            croppedPixels,
            thumbFile.type || "image/jpeg",
          );
          formData.append(
            "thumbnail",
            croppedBlob,
            `thumb-cropped.${thumbFile.type?.split("/")[1] || "jpg"}`,
          );
        } else if (thumbFile) {
          formData.append("thumbnail", thumbFile);
        }
        formData.append("name", title);
        formData.append("description", description);
        formData.append("price", price);
        formData.append("usageRights", usageRights);
        formData.append("visibility", visibility);
        formData.append("owner", address);

        // 1. Upload to Pinata with retry logic
        let attempt = 0;
        const maxAttempts = 3;
        const initialDelay = 1000;

        while (true) {
          attempt++;
          try {
            uploadData = await uploadFileMutation.mutateAsync(formData);
            
            if (uploadData?.metadata) {
              break; // Success!
            }
            throw new Error("File upload failed: No metadata returned");
          } catch (err) {
            const isRetriableStatus = !err.status || [429, 500, 502, 503, 504].includes(err.status);
            if (attempt >= maxAttempts || !isRetriableStatus) {
              throw err;
            }
          }

          const backoffDelay = initialDelay * Math.pow(2, attempt - 1);
          console.warn(`Upload attempt ${attempt} failed. Retrying in ${backoffDelay}ms...`);
          setError(`Upload attempt ${attempt} failed. Retrying...`);
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          setError(null);
        }

        setSavedUploadData(uploadData);
      }

      markStatus(TransactionStatus.PendingConfirmation, {
        title: "Awaiting confirmation",
        message: "The upload succeeded. We are finalizing the material record.",
      });

      // 2. Create database record
      await createMaterialMutation.mutateAsync({
        title,
        description,
        category: category || undefined,
        price,
        usageRights,
        visibility,
        level: level || undefined,
        storageKey: uploadData.storageKey,
        thumbnail: uploadData.image,
        metadataUrl: uploadData.metadata,
        creator: address,
        payoutSplits: payoutSplits || undefined,
      });

      confirmTransaction({
        title: "Material published",
        message: "Your material is now available in the marketplace.",
      });

      setSuccess("Document uploaded successfully and record created!");
      // Reset form
      setTitle("");
      setDescription("");
      setCategory("");
      setPrice("");
      setLevel("");
      setDocFile(null);
      setDocFileName(null);
      setThumbFile(null);
      setThumbPreview(null);
      setShowCropper(false);
      setThumbCrop({ x: 0, y: 0 });
      setThumbZoom(1);
      setCroppedPixels(null);
      setSavedUploadData(null);
    } catch (err) {
      console.error("Upload Error:", err);
      let friendlyError = err?.message || "Something went wrong. Please try again.";
      if (friendlyError.includes("exceeds the 10MB limit") || friendlyError.includes("exceeds the 50MB limit")) {
        friendlyError = "The selected document exceeds the file size limit. Please choose a smaller file.";
      } else if (friendlyError.includes("exceeds the 5MB limit")) {
        friendlyError = "The selected thumbnail exceeds the 5MB limit. Please choose a smaller image.";
      } else if (friendlyError.includes("Unsupported file type") || friendlyError.includes("Unsupported file format")) {
        friendlyError = "The file type is not supported. Please upload a PDF, Word document, Excel sheet, PowerPoint presentation, text file, or ZIP archive.";
      } else if (friendlyError.includes("Unsupported thumbnail type")) {
        friendlyError = "The thumbnail image format is not supported. Please use JPG, PNG, or WEBP.";
      } else if (friendlyError.includes("fetch") || friendlyError.includes("Failed to fetch") || friendlyError.toLowerCase().includes("network")) {
        friendlyError = "Network error: Could not reach the upload server. Please check your internet connection.";
      } else if (friendlyError.toLowerCase().includes("too many requests") || friendlyError.toLowerCase().includes("rate limit") || friendlyError.includes("429")) {
        friendlyError = "Rate limit exceeded: You've made too many requests. Please wait a bit and try again.";
      }
      setError(friendlyError);
      failTransaction(err instanceof Error ? err : new Error(String(err)), {
        title: "Publish failed",
        message: friendlyError,
        retryable: true,
      });
    }
  };

  const submitting =
    uploadFileMutation.isPending || createMaterialMutation.isPending;

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm"
    >
      <h2 className="text-xl font-bold mb-6">Create a New Study Resource</h2>
      <p className="text-sm text-gray-600 mb-8">
        Upload lecture notes, projects, or past questions. The active chain
        layer is moving to Soroban, so this form handles file storage and
        cataloging.
      </p>

      <div className="mb-5">
        <label htmlFor="material-title" className="block text-sm font-medium mb-2">Document Title</label>
        <input
          id="material-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. ECO 304 - Development Economics Lecture Notes"
          className={`w-full border rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500 ${fieldErrors.title ? "border-red-500" : "border-gray-300"}`}
          maxLength={160}
          required
          aria-describedby={fieldErrors.title ? "title-error" : undefined}
        />
        {fieldErrors.title && (
          <p id="title-error" className="text-red-600 text-xs mt-1">
            {fieldErrors.title}
          </p>
        )}
      </div>

      <div className="mb-5">
        <label htmlFor="material-description" className="block text-sm font-medium mb-2">
          Short Description
        </label>
        <textarea
          id="material-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Comprehensive lecture notes covering key development theories and examples."
          rows={3}
          maxLength={5000}
          className={`w-full border rounded-md px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500 ${fieldErrors.description ? "border-red-500" : "border-gray-300"}`}
          aria-describedby={
            fieldErrors.description ? "description-error" : undefined
          }
        />
        {fieldErrors.description && (
          <p id="description-error" className="text-red-600 text-xs mt-1">
            {fieldErrors.description}
          </p>
        )}
      </div>

      <div className="mb-5">
        <label className="block text-sm font-medium mb-2">Cover Image</label>
        <div className="flex flex-col gap-4">
          {!thumbPreview && (
            <DragDropUpload
              onFileSelect={(file) =>
                handleThumbChange({ target: { files: [file] } })
              }
              error={fieldErrors.thumb}
            />
          )}
          {fieldErrors.thumb && (
            <p id="thumb-error" className="text-red-600 text-xs mt-1">
              {fieldErrors.thumb}
            </p>
          )}
          {thumbPreview && showCropper && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <p className="text-xs text-gray-600 mb-2">
                Crop cover image (locked 16:9 ratio for marketplace cards)
              </p>
              <div className="relative h-56 w-full overflow-hidden rounded-md bg-gray-900">
                <Cropper
                  image={thumbPreview}
                  crop={thumbCrop}
                  zoom={thumbZoom}
                  aspect={16 / 9}
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
                alt="Final Cover Preview"
                width={160}
                height={90}
                className="rounded object-cover border"
              />
              <button
                type="button"
                onClick={() => setShowCropper(true)}
                className="rounded-md border border-gray-300 px-3 py-2 text-xs hover:bg-gray-100"
              >
                Re-crop cover
              </button>
              <button
                type="button"
                onClick={() => {
                  setThumbFile(null);
                  setThumbPreview(null);
                  setShowCropper(false);
                }}
                className="rounded-md border border-gray-300 px-3 py-2 text-xs hover:bg-gray-100 text-red-600"
              >
                Remove
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mb-5">
        <label className="block text-sm font-medium mb-2">
          Upload Your File
        </label>
        <p className="text-xs text-gray-500 mb-2">
          Max file size: 50MB. Accepted types: PDF, ZIP, EPUB, MP4.
        </p>
        <div
          className={`border-2 border-dashed rounded-lg p-6 text-center transition ${fieldErrors.file ? "border-red-500 hover:border-red-600 bg-red-50" : "border-gray-300 hover:border-blue-400"}`}
        >
          <input
            type="file"
            id="file-upload"
            className="hidden"
            onChange={handleDocChange}
            accept=".pdf,.zip,.epub,.mp4"
            aria-label="Upload document file"
            aria-describedby={fieldErrors.file ? "file-error" : undefined}
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
                    (.pdf, .zip, .epub, .mp4 | 50MB max)
                  </span>
                </>
              )}
            </p>
            <div className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">
              Choose File
            </div>
          </label>
        </div>
        {fieldErrors.file && (
          <p id="file-error" className="text-red-600 text-xs mt-1">
            {fieldErrors.file}
          </p>
        )}
      </div>

      <div className="grid sm:grid-cols-3 gap-4 mb-5">
        <div>
          <label htmlFor="material-category" className="block text-sm font-medium mb-2">Category</label>
          <select
            id="material-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
          >
            <option value="">Select a category</option>
            <option value="STEM">STEM</option>
            <option value="Business">Business</option>
            <option value="Law">Law</option>
            <option value="Arts">Arts</option>
            <option value="Humanities">Humanities</option>
            <option value="Professional Development">Professional Development</option>
          </select>
        </div>
        <div>
          <label htmlFor="material-price" className="block text-sm font-medium mb-2">
            Set Your Price (optional)
          </label>
          <input
            id="material-price"
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="amount"
            min="0"
            step="0.01"
            className={`w-full border rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500 ${fieldErrors.price ? "border-red-500" : "border-gray-300"}`}
            aria-describedby={fieldErrors.price ? "price-error" : undefined}
          />
          {fieldErrors.price && (
            <p id="price-error" className="text-red-600 text-xs mt-1">
              {fieldErrors.price}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="material-usage-rights" className="block text-sm font-medium mb-2">Usage Rights</label>
          <select
            id="material-usage-rights"
            value={usageRights}
            onChange={(e) => setUsageRights(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
          >
            <option>Standard License (download only)</option>
            <option>Creative Commons</option>
            <option>Private Use Only</option>
          </select>
        </div>
        <div>
          <label htmlFor="material-level" className="block text-sm font-medium mb-2">Level</label>
          <select
            id="material-level"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
          >
            <option value="">Select Level</option>
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
            <option value="all-levels">All Levels</option>
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

      <div className="mb-6">
        <PayoutSplits
          onChange={(splits, isValid) => {
            setPayoutSplits(splits);
            setPayoutSplitsValid(isValid);
          }}
          initialSplits={payoutSplits || []}
        />
        {fieldErrors.payoutSplits && (
          <p className="text-red-600 text-xs mt-2">
            {fieldErrors.payoutSplits}
          </p>
        )}
      </div>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
      {success && <p className="text-green-600 text-sm mb-4">{success}</p>}

      <div className="mb-5">
        <TransactionStatusPanel
          transaction={activeTransaction}
          onRetry={handleSubmit}
          onClear={clearTransaction}
        />
      </div>

      <div className="flex justify-end gap-4">
        <button
          type="submit"
          disabled={submitting}
          className="px-5 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition text-sm font-medium disabled:opacity-60"
        >
          {activeTransaction.status === TransactionStatus.PendingConfirmation
            ? "Awaiting confirmation..."
            : submitting
              ? "Processing..."
              : savedUploadData
                ? "Retry Publishing"
                : "Submit Upload"}
        </button>
      </div>
    </form>
  );
}
