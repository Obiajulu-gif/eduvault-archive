"use client";

import { useState } from "react";
import { FaCloudUploadAlt, FaCheckCircle, FaTimesCircle } from "react-icons/fa";

export default function StudentVerificationForm({ onSuccess, userAddress }) {
  const [formData, setFormData] = useState({
    fullName: "",
    email: "",
    institution: "",
    studentId: "",
    expectedGraduation: "",
  });

  const [documentFile, setDocumentFile] = useState(null);
  const [documentPreview, setDocumentPreview] = useState(null);
  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
    // Clear error for this field
    if (errors[name]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[name];
        return newErrors;
      });
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadError(null);

      // Validate file size (5MB max)
      if (file.size > 5 * 1024 * 1024) {
        setUploadError(
          `File size ${(file.size / (1024 * 1024)).toFixed(2)}MB exceeds the 5MB limit`,
        );
        return;
      }

      // Validate file type
      const validTypes = [
        "image/jpeg",
        "image/png",
        "image/jpg",
        "application/pdf",
      ];
      if (!validTypes.includes(file.type)) {
        setUploadError("Invalid file type. Please upload JPG, PNG, or PDF");
        return;
      }

      setDocumentFile(file);

      // Create preview for images
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onloadend = () => {
          setDocumentPreview(reader.result);
        };
        reader.readAsDataURL(file);
      } else {
        setDocumentPreview(null);
      }

      // Clear error
      if (errors.document) {
        setErrors((prev) => {
          const newErrors = { ...prev };
          delete newErrors.document;
          return newErrors;
        });
      }
    }
  };

  const validateForm = () => {
    const newErrors = {};

    if (!formData.fullName.trim()) {
      newErrors.fullName = "Full name is required";
    }

    if (!formData.email.trim()) {
      newErrors.email = "Email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = "Invalid email format";
    }

    if (!formData.institution.trim()) {
      newErrors.institution = "Institution name is required";
    }

    if (!formData.studentId.trim()) {
      newErrors.studentId = "Student ID is required";
    }

    if (!formData.expectedGraduation) {
      newErrors.expectedGraduation = "Expected graduation date is required";
    }

    if (!documentFile) {
      newErrors.document = "Please upload a verification document";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);
    setUploadError(null);

    try {
      const submitData = new FormData();
      submitData.append("walletAddress", userAddress);
      submitData.append("fullName", formData.fullName);
      submitData.append("email", formData.email);
      submitData.append("institution", formData.institution);
      submitData.append("studentId", formData.studentId);
      submitData.append("expectedGraduation", formData.expectedGraduation);
      submitData.append("document", documentFile);

      const response = await fetch("/api/verification/student", {
        method: "POST",
        body: submitData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Submission failed");
      }

      const result = await response.json();
      console.log("Verification submitted:", result);

      // Call success callback
      if (onSuccess) {
        onSuccess(result);
      }
    } catch (error) {
      console.error("Verification submission error:", error);
      setUploadError(
        error.message || "Failed to submit verification. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid sm:grid-cols-2 gap-6">
        <div>
          <label
            htmlFor="fullName"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Full Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            id="fullName"
            name="fullName"
            value={formData.fullName}
            onChange={handleInputChange}
            disabled={isSubmitting}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              errors.fullName ? "border-red-500" : "border-gray-300"
            }`}
            placeholder="John Doe"
          />
          {errors.fullName && (
            <p className="text-red-600 text-xs mt-1">{errors.fullName}</p>
          )}
        </div>

        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Student Email <span className="text-red-500">*</span>
          </label>
          <input
            type="email"
            id="email"
            name="email"
            value={formData.email}
            onChange={handleInputChange}
            disabled={isSubmitting}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              errors.email ? "border-red-500" : "border-gray-300"
            }`}
            placeholder="student@university.edu"
          />
          {errors.email && (
            <p className="text-red-600 text-xs mt-1">{errors.email}</p>
          )}
        </div>
      </div>

      <div>
        <label
          htmlFor="institution"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Institution Name <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          id="institution"
          name="institution"
          value={formData.institution}
          onChange={handleInputChange}
          disabled={isSubmitting}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            errors.institution ? "border-red-500" : "border-gray-300"
          }`}
          placeholder="University of Example"
        />
        {errors.institution && (
          <p className="text-red-600 text-xs mt-1">{errors.institution}</p>
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-6">
        <div>
          <label
            htmlFor="studentId"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Student ID <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            id="studentId"
            name="studentId"
            value={formData.studentId}
            onChange={handleInputChange}
            disabled={isSubmitting}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              errors.studentId ? "border-red-500" : "border-gray-300"
            }`}
            placeholder="S123456789"
          />
          {errors.studentId && (
            <p className="text-red-600 text-xs mt-1">{errors.studentId}</p>
          )}
        </div>

        <div>
          <label
            htmlFor="expectedGraduation"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Expected Graduation <span className="text-red-500">*</span>
          </label>
          <input
            type="month"
            id="expectedGraduation"
            name="expectedGraduation"
            value={formData.expectedGraduation}
            onChange={handleInputChange}
            disabled={isSubmitting}
            min={new Date().toISOString().slice(0, 7)}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              errors.expectedGraduation ? "border-red-500" : "border-gray-300"
            }`}
          />
          {errors.expectedGraduation && (
            <p className="text-red-600 text-xs mt-1">
              {errors.expectedGraduation}
            </p>
          )}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Verification Document <span className="text-red-500">*</span>
        </label>
        <p className="text-xs text-gray-500 mb-2">
          Upload a clear scan of your student ID, enrollment letter, or
          transcript (Max: 5MB, JPG/PNG/PDF)
        </p>

        <div
          className={`border-2 border-dashed rounded-lg p-6 text-center transition ${
            errors.document || uploadError
              ? "border-red-500 bg-red-50"
              : documentFile
                ? "border-green-500 bg-green-50"
                : "border-gray-300 hover:border-blue-400"
          }`}
        >
          <input
            type="file"
            id="document-upload"
            className="hidden"
            onChange={handleFileChange}
            accept=".jpg,.jpeg,.png,.pdf"
            disabled={isSubmitting}
          />
          <label htmlFor="document-upload" className="cursor-pointer">
            {documentFile ? (
              <div className="flex flex-col items-center">
                <FaCheckCircle className="text-3xl text-green-500 mb-2" />
                <p className="text-sm font-medium text-gray-800 mb-1">
                  {documentFile.name}
                </p>
                <p className="text-xs text-gray-500 mb-2">
                  {(documentFile.size / 1024).toFixed(2)} KB
                </p>
                {documentPreview && (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={documentPreview}
                      alt="Document preview"
                      className="mt-2 max-w-xs max-h-48 rounded border"
                    />
                  </>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    setDocumentFile(null);
                    setDocumentPreview(null);
                  }}
                  className="mt-3 text-xs text-red-600 hover:text-red-700 font-medium"
                >
                  Remove file
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <FaCloudUploadAlt className="text-3xl text-blue-500 mb-2" />
                <p className="text-sm text-gray-600 mb-2">
                  Click to upload or drag and drop
                </p>
                <p className="text-xs text-gray-400">
                  JPG, PNG, or PDF (Max 5MB)
                </p>
              </div>
            )}
          </label>
        </div>
        {errors.document && (
          <p className="text-red-600 text-xs mt-1">{errors.document}</p>
        )}
        {uploadError && (
          <p className="text-red-600 text-xs mt-1 flex items-center gap-1">
            <FaTimesCircle /> {uploadError}
          </p>
        )}
      </div>

      <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
        <h4 className="text-sm font-semibold text-gray-900 mb-2">
          Privacy Notice
        </h4>
        <p className="text-xs text-gray-600">
          Your information will be used solely for student verification purposes
          and will be stored securely. We will not share your data with third
          parties without your consent. Documents will be reviewed within 1-3
          business days.
        </p>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={isSubmitting}
          className="px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? "Submitting..." : "Submit Verification Application"}
        </button>
      </div>
    </form>
  );
}
