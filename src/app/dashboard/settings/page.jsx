"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import BannerUpload from "@/components/BannerUpload";
import ProfileProgress from "@/components/dashboard/ProfileProgress";
import { FaCheckCircle, FaExclamationCircle } from "react-icons/fa";

export default function SettingsPage() {
  const router = useRouter();
  const [bannerUrl, setBannerUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [success, setSuccess] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchBanner = async () => {
      try {
        const res = await fetch("/api/profile/banner");
        if (res.ok) {
          const data = await res.json();
          setBannerUrl(data.bannerUrl);
        }
      } catch (err) {
        console.error("Failed to fetch banner:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchBanner();
  }, []);

  const handleUpload = (data) => {
    setBannerUrl(data.bannerUrl);
    setSuccess("Banner uploaded successfully!");
    setTimeout(() => setSuccess(null), 3000);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Profile Settings</h1>
        <p className="text-sm text-gray-500">
          Customize your profile and marketplace appearance.
        </p>
      </div>

      <div className="max-w-2xl">
        <ProfileProgress />
      </div>

      <div className="bg-white rounded-lg shadow-sm p-8 max-w-2xl">
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Profile Banner</h2>
          <p className="text-sm text-gray-600 mb-6">
            Upload a custom banner to personalize your marketplace storefront. The banner will be displayed at the top of your creator profile.
          </p>

          {success && (
            <div className="flex items-start gap-2 p-3 bg-green-50 border border-green-200 rounded-lg mb-6">
              <FaCheckCircle className="text-green-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-green-700">{success}</p>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg mb-6">
              <FaExclamationCircle className="text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {bannerUrl && (
            <div className="mb-6">
              <p className="text-sm font-medium text-gray-700 mb-2">Current Banner</p>
              <div className="w-full rounded-lg overflow-hidden border border-gray-200" style={{ aspectRatio: "3/1" }}>
                <img
                  src={bannerUrl}
                  alt="Current banner"
                  className="w-full h-full object-cover"
                />
              </div>
            </div>
          )}

          {!loading && (
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-gray-700">Upload New Banner</h3>
              <BannerUpload onUpload={handleUpload} />
              <div className="text-xs text-gray-500 space-y-1">
                <p>
                  <span className="font-medium">Aspect ratio:</span> 3:1 (e.g., 1500x500px)
                </p>
                <p>
                  <span className="font-medium">Max file size:</span> 10MB
                </p>
                <p>
                  <span className="font-medium">Formats:</span> PNG, JPG, GIF
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
