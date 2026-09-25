"use client";

import { useState, useCallback, useRef } from "react";
import Cropper from "react-easy-crop";
import { FaUpload, FaCheck, FaTimes } from "react-icons/fa";

export default function BannerUpload({ onUpload }) {
  const [file, setFile] = useState(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const validateFile = (selectedFile) => {
    const maxSize = 10 * 1024 * 1024;
    if (selectedFile.size > maxSize) {
      setError("File size exceeds 10MB limit");
      return false;
    }
    if (!selectedFile.type.startsWith("image/")) {
      setError("File must be an image");
      return false;
    }
    return true;
  };

  const handleFileSelect = (e) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && validateFile(selectedFile)) {
      setFile(selectedFile);
      setError(null);
      setCrop({ x: 0, y: 0 });
      setZoom(1);
    }
  };

  const onCropComplete = useCallback((croppedArea, croppedAreaPixels) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  const getCroppedImage = useCallback(async () => {
    if (!file || !croppedAreaPixels) return null;

    const canvas = await new Promise((resolve) => {
      const image = new window.Image();
      image.src = URL.createObjectURL(file);

      image.onload = () => {
        const ctx = canvas.getContext("2d");
        canvas.width = croppedAreaPixels.width;
        canvas.height = croppedAreaPixels.height;

        ctx.drawImage(
          image,
          croppedAreaPixels.x,
          croppedAreaPixels.y,
          croppedAreaPixels.width,
          croppedAreaPixels.height,
          0,
          0,
          croppedAreaPixels.width,
          croppedAreaPixels.height
        );
        resolve(canvas);
      };
    });

    return canvas;
  }, [file, croppedAreaPixels]);

  const handleCropAndUpload = async () => {
    try {
      setUploading(true);
      setError(null);

      const canvas = await getCroppedImage();
      if (!canvas) {
        setError("Failed to process image");
        return;
      }

      canvas.toBlob(async (blob) => {
        try {
          const formData = new FormData();
          formData.append("file", blob, "banner.jpg");

          const res = await fetch("/api/profile/banner", {
            method: "POST",
            body: formData,
          });

          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || "Upload failed");
          }

          const data = await res.json();
          onUpload?.(data);
          setFile(null);
          setCroppedAreaPixels(null);
        } catch (err) {
          setError(err.message);
        } finally {
          setUploading(false);
        }
      }, "image/jpeg", 0.9);
    } catch (err) {
      setError(err.message);
      setUploading(false);
    }
  };

  if (!file) {
    return (
      <div
        onClick={() => fileInputRef.current?.click()}
        className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-blue-500 hover:bg-blue-50 transition-colors"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileSelect}
          className="hidden"
        />
        <FaUpload className="mx-auto text-4xl text-gray-400 mb-3" />
        <p className="text-sm font-medium text-gray-700">
          Click to upload or drag and drop
        </p>
        <p className="text-xs text-gray-500 mt-1">
          PNG, JPG, GIF up to 10MB (aspect ratio 3:1)
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="relative w-full bg-gray-100 rounded-lg overflow-hidden" style={{ aspectRatio: "3/1" }}>
        <Cropper
          image={URL.createObjectURL(file)}
          crop={crop}
          zoom={zoom}
          aspect={3}
          cropShape="rect"
          showGrid={false}
          onCropChange={setCrop}
          onCropComplete={onCropComplete}
          onZoomChange={setZoom}
        />
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700">Zoom</label>
        <input
          type="range"
          min="1"
          max="3"
          step="0.1"
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="w-full"
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
          <FaTimes className="text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => setFile(null)}
          disabled={uploading}
          className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleCropAndUpload}
          disabled={uploading}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          {uploading ? "Uploading..." : <><FaCheck size={14} /> Upload</>}
        </button>
      </div>
    </div>
  );
}
