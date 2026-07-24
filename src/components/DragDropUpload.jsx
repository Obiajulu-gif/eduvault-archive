import React, { useCallback, useState, useRef } from "react";
import { FaImage } from "react-icons/fa";

export default function DragDropUpload({ onFileSelect, error }) {
  const [isDragActive, setIsDragActive] = useState(false);
  const [fileName, setFileName] = useState("");
  const inputRef = useRef(null);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragActive(false);

      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith("image/")) {
        setFileName(file.name);
        onFileSelect(file);
      }
    },
    [onFileSelect]
  );

  const handleChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setFileName(file.name);
      onFileSelect(file);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inputRef.current?.click();
    }
  };

  const dropZoneId = "cover-image-dropzone";

  return (
    <>
    <div
      id={dropZoneId}
      role="button"
      tabIndex={0}
      aria-label="Upload cover image. Drag and drop or press Enter to browse."
      aria-describedby={error ? "thumb-error" : fileName ? "file-selected" : undefined}
      aria-disabled={false}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onKeyDown={handleKeyDown}
      onClick={() => inputRef.current?.click()}
      className={`border-2 border-dashed rounded-lg p-6 text-center transition cursor-pointer flex flex-col items-center justify-center min-h-[140px] focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none ${
        isDragActive
          ? "border-blue-500 bg-blue-50"
          : error
          ? "border-red-500 bg-red-50 hover:border-red-600"
          : "border-gray-300 hover:border-blue-400"
      }`}
    >
      {error && (
        <div id="thumb-error" role="alert" className="sr-only">
          {error}
        </div>
      )}

      {fileName && (
        <div id="file-selected" role="status" className="sr-only">
          File selected: {fileName}
        </div>
      )}

      <FaImage
        className={`text-3xl mb-3 ${
          isDragActive ? "text-blue-500" : "text-gray-400"
        }`}
        aria-hidden="true"
      />
      <p className="text-sm text-gray-700 font-medium mb-1">
        {fileName ? `Selected: ${fileName}` : "Drag cover image here or click to browse"}
      </p>
      <p className="text-xs text-gray-500">Max size: 5MB (16:9 recommended)</p>
    </div>
    <input
      ref={inputRef}
      id="cover-image-upload"
      type="file"
      accept="image/*"
      onChange={handleChange}
      className="sr-only"
      aria-hidden="true"
      tabIndex={-1}
    />
    </>
  );
}
