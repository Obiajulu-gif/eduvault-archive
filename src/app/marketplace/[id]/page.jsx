"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, useEffect } from "react";
import { FaBookOpen, FaListUl, FaStickyNote, FaImage, FaTag, FaCheckCircle } from "react-icons/fa";
import { motion } from "framer-motion";
import { useParams } from "next/navigation";
import { useAccount } from "wagmi";
import { useMaterialDetail } from "@/hooks/api/useMaterials";
import { useEntitlement } from "@/hooks/api/useEntitlements";
import { QueryStateProvider } from "@/components/common/QueryStateProvider";
import Web3ErrorBoundary from "@/components/web3/Web3ErrorBoundary";
import Navbar from "@/components/Navbar";
import ResourceStatusBadge from "@/components/materials/ResourceStatusBadge";
import RecommendedMaterials from "@/components/materials/RecommendedMaterials";
import MaterialReviewPanel from "@/components/materials/MaterialReviewPanel";
import ReportModal from "@/components/ReportModal";
import { trackRecentlyViewed } from "@/hooks/useRecentlyViewed";
import BuyNowModal from "./modals/BuyNowModal";
import PreviewBlock from "./components/PreviewBlock";
import PreviewStat from "./components/PreviewStat";
import CreatorCard from "./components/CreatorCard";
import PurchaseCard from "./components/PurchaseCard";
import RevisionHistoryPanel from "./components/RevisionHistoryPanel";
import ReportModal from "./components/ReportModal";
import MaterialNotFound from "./components/MaterialNotFound";
import { useMaterialHistory } from "./hooks/useMaterialHistory";
import { getPreviewImage, getPreviewCounts, hasCoverImage } from "./components/utils";

export default function MaterialDetailsPage() {
  const params = useParams();
  const id = String(params.id);
  const [showBuyModal, setShowBuyModal] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [downloadError, setDownloadError] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const materialQuery = useMaterialDetail(id);
  const entitlementQuery = useEntitlement(id);
  const { data: history } = useMaterialHistory(id);
  const { address } = useAccount();

  const accessStatus = !address
    ? "wallet_required"
    : entitlementQuery.data?.status || (entitlementQuery.isLoading ? "checking" : "not_purchased");
  const isOwned =
    accessStatus === "active" ||
    Boolean(address && (entitlementQuery.data?.owned || entitlementQuery.data?.hasAccess));

  const handleDownload = async () => {
    if (!address) {
      setShowBuyModal(true);
      return;
    }
    setIsDownloading(true);
    setDownloadError(null);
    try {
      const query = new URLSearchParams({ materialId: id, buyerAddress: address });
      const response = await fetch(`/api/download?${query.toString()}`);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.detail || payload?.error || "Unable to request material access.");
      }
      if (payload.fileUrl) {
        window.open(payload.fileUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Unable to request material access.");
    } finally {
      setIsDownloading(false);
    }
  };

  useEffect(() => {
    if (materialQuery.data) {
      trackRecentlyViewed(materialQuery.data);
    }
  }, [materialQuery.data]);

  return (
    <>
      <Navbar />
      <main className="relative bg-background min-h-screen py-6 sm:py-10 px-4 sm:px-6 md:px-10 lg:px-20">
        <div
          className="absolute inset-0 bg-[linear-gradient(to_right,#f2ede8_1px,transparent_1px),linear-gradient(to_bottom,#f2ede8_1px,transparent_1px)] bg-[size:40px_40px] opacity-70 pointer-events-none -z-10"
          aria-hidden="true"
        />
        <QueryStateProvider
          query={materialQuery}
          errorComponent={
            // 400/404 are terminal (bad or deleted id) — retrying cannot help,
            // so show a not-found state instead of the generic retry screen.
            materialQuery.error?.status === 404 || materialQuery.error?.status === 400 ? (
              <MaterialNotFound />
            ) : undefined
          }
        >
          {(material) => {
            const counts = getPreviewCounts(material);
            return (
              <motion.div
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
                aria-live="polite"
                className="max-w-6xl mx-auto"
              >
                <nav aria-label="Breadcrumb" className="mb-4 sm:mb-6">
                  <p className="text-xs sm:text-sm text-gray-500 dark:text-muted-foreground break-words">
                    <Link
                      href="/marketplace"
                      className="text-blue-600 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 rounded-sm"
                    >
                      Marketplace
                    </Link>{" "}
                    &rarr; <span className="text-gray-700 dark:text-foreground/80">{material.title}</span>
                  </p>
                </nav>

                <header className="mb-6 sm:mb-8">
                  <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 dark:text-foreground break-words">
                    {material.title}
                  </h1>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <ResourceStatusBadge material={material} />
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/30 border border-blue-200">
                      Current Revision: v{material.version || 1}
                    </span>
                  </div>
                  <p className="mt-3 text-sm sm:text-base text-gray-600 dark:text-muted-foreground leading-relaxed max-w-3xl break-words">
                    {material.shortSummary || material.description || "Creator preview not shared yet."}
                  </p>
                  {material.tags?.length ? (
                    <div className="mt-4 flex flex-wrap gap-2" role="list">
                      {material.tags.map((tag, i) => (
                        <span
                          key={i}
                          role="listitem"
                          className="inline-flex items-center gap-1 text-xs bg-gray-100 dark:bg-surface-muted text-gray-700 dark:text-foreground/80 px-3 py-1 rounded-full"
                        >
                          <FaTag aria-hidden="true" className="text-[10px] text-gray-400 dark:text-muted-foreground" />
                          #{tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </header>

                <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 lg:gap-8 items-start">
                  <div className="space-y-6 lg:space-y-8 min-w-0 order-2 lg:order-1">
                    <div className="bg-white dark:bg-surface-strong rounded-2xl overflow-hidden shadow-sm border border-gray-200 dark:border-border-strong">
                      <Image
                        src={getPreviewImage(material)}
                        alt={material.title}
                        width={800}
                        height={600}
                        className="w-full h-56 sm:h-72 md:h-[380px] object-cover"
                      />
                    </div>

                    <section aria-labelledby="preview-summary-heading" className="space-y-3">
                      <h2 id="preview-summary-heading" className="text-base sm:text-lg font-semibold text-gray-900">
                        What you will get
                      </h2>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
                        <PreviewStat label="Cover image" value={hasCoverImage(material) ? "Provided" : "Missing"} icon={FaImage} />
                        <PreviewStat label="Learning outcomes" value={`${counts.outcomes} shared`} icon={FaBookOpen} />
                        <PreviewStat label="Table of contents" value={`${counts.sections} sections`} icon={FaListUl} />
                        <PreviewStat label="Sample notes" value={`${counts.notes} included`} icon={FaStickyNote} />
                      </div>
                    </section>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5 lg:gap-6">
                      <section className="bg-white dark:bg-surface-strong border border-gray-200 dark:border-border-strong rounded-2xl p-5 sm:p-6 shadow-sm">
                        <h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-foreground mb-3">About</h2>
                        <p className="text-sm text-gray-600 dark:text-muted-foreground leading-relaxed break-words">
                          {material.shortSummary || material.description}
                        </p>
                      </section>
                      <CreatorCard author={material.author} creator={material.creator} createdAt={material.createdAt} />
                    </div>

                    <div className="bg-white dark:bg-surface-strong border border-gray-200 dark:border-border-strong rounded-2xl p-5 sm:p-6 shadow-sm">
                      <h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-foreground mb-4">Performance Summary</h2>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                        <div className="rounded-xl bg-blue-50 dark:bg-blue-900/30 p-4">
                          <p className="text-[10px] text-gray-500 dark:text-muted-foreground font-bold tracking-wider uppercase">Views</p>
                          <p className="mt-1 text-2xl font-bold text-blue-600">{material.viewCount || 0}</p>
                        </div>
                        <div className="rounded-xl bg-emerald-50 dark:bg-emerald-900/30 p-4">
                          <p className="text-[10px] text-gray-500 dark:text-muted-foreground font-bold tracking-wider uppercase">Saves</p>
                          <p className="mt-1 text-2xl font-bold text-emerald-600">{material.saveCount || 0}</p>
                        </div>
                        <div className="rounded-xl bg-amber-50 dark:bg-amber-900/30 p-4">
                          <p className="text-[10px] text-gray-500 dark:text-muted-foreground font-bold tracking-wider uppercase">Requests</p>
                          <p className="mt-1 text-2xl font-bold text-amber-600">{material.accessCount || 0}</p>
                        </div>
                        <div className="rounded-xl bg-pink-50 dark:bg-pink-900/30 p-4">
                          <p className="text-[10px] text-gray-500 dark:text-muted-foreground font-bold tracking-wider uppercase">Likes</p>
                          <p className="mt-1 text-2xl font-bold text-pink-600">{material.likes || 0}</p>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5 lg:gap-6">
                      <PreviewBlock title="Learning outcomes" emptyLabel="The creator has not added learning outcomes yet." items={material.learningOutcomes} icon={FaBookOpen} />
                      <PreviewBlock title="Table of contents" emptyLabel="The creator has not shared a table of contents yet." items={material.tableOfContents} icon={FaListUl} />
                      <PreviewBlock title="Sample notes" emptyLabel="No sample notes were shared for this listing." items={material.sampleNotes} icon={FaStickyNote} />

                      <section className="bg-white dark:bg-surface-strong border border-gray-200 dark:border-border-strong rounded-2xl p-5 sm:p-6 shadow-sm h-full">
                        <h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-foreground mb-3">On-chain verification</h2>
                        <p className="text-sm text-gray-600 dark:text-muted-foreground leading-relaxed mb-4">
                          EduVault publishes marketplace metadata through Soroban contracts so buyers can verify authenticity before paying.
                        </p>
                        <p className="flex items-center gap-2 text-sm">
                          <strong className="text-gray-800 dark:text-foreground">Status:</strong>
                          {material.verified ? (
                            <span className="text-green-700 dark:text-green-400 flex items-center gap-1 text-xs font-semibold">
                              <FaCheckCircle aria-hidden="true" /> Ready for Soroban
                            </span>
                          ) : (
                            <span className="text-amber-700 dark:text-amber-400 text-xs font-semibold">Not verified yet</span>
                          )}
                        </p>
                      </section>

                      <div className="bg-white dark:bg-surface-strong border border-gray-200 dark:border-border-strong rounded-2xl p-5 sm:p-6 shadow-sm h-full">
                        <h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-foreground mb-3">Resource Details</h2>
                        <dl className="space-y-3 text-sm">
                          {material.category && (
                            <div className="flex justify-between items-center">
                              <dt className="text-gray-500 dark:text-muted-foreground font-medium">Category</dt>
                              <dd className="text-gray-800 dark:text-foreground font-semibold capitalize">{material.category}</dd>
                            </div>
                          )}
                          {material.subject && (
                            <div className="flex justify-between items-center">
                              <dt className="text-gray-500 dark:text-muted-foreground font-medium">Subject</dt>
                              <dd className="text-gray-800 dark:text-foreground font-semibold">{material.subject}</dd>
                            </div>
                          )}
                          {material.level && (
                            <div className="flex justify-between items-center">
                              <dt className="text-gray-500 dark:text-muted-foreground font-medium">Level</dt>
                              <dd className="text-gray-800 dark:text-foreground font-semibold capitalize">{material.level}</dd>
                            </div>
                          )}
                          <div className="flex justify-between items-center">
                            <dt className="text-gray-500 dark:text-muted-foreground font-medium">File Type</dt>
                            <dd className="text-gray-800 dark:text-foreground font-semibold uppercase">{material.fileType || "PDF"}</dd>
                          </div>
                          {material.pages && (
                            <div className="flex justify-between items-center">
                              <dt className="text-gray-500 dark:text-muted-foreground font-medium">Pages</dt>
                              <dd className="text-gray-800 dark:text-foreground font-semibold">{material.pages}</dd>
                            </div>
                          )}
                          <div className="flex justify-between items-center">
                            <dt className="text-gray-500 dark:text-muted-foreground font-medium">Visibility</dt>
                            <dd className="text-gray-800 dark:text-foreground font-semibold capitalize">{material.visibility || "Public"}</dd>
                          </div>
                        </dl>
                      </div>
                    </div>

                    <RevisionHistoryPanel history={history || []} currentVersion={material.version} />

                    <MaterialReviewPanel
                      materialId={id}
                      initialReviews={material.reviews || material.reviewHistory || []}
                      entitlement={entitlementQuery}
                      currentAddress={address}
                      creatorAddress={material.userAddress || material.ownerAddress || material.creatorAddress || material.author?.walletAddress}
                    />
                  </div>

                  <div className="order-1 lg:order-2">
                    <PurchaseCard
                      material={material}
                      accessStatus={accessStatus}
                      entitlementQuery={entitlementQuery}
                      address={address}
                      isOwned={isOwned}
                      isDownloading={isDownloading}
                      downloadError={downloadError}
                      onDownload={handleDownload}
                      onRequestAccess={() => setShowBuyModal(true)}
                      onAddToCart={() => setShowBuyModal(true)}
                      onReport={() => setShowReportModal(true)}
                    />
                  </div>
                </div>

                {materialQuery.data && (
                  <div className="mt-12 sm:mt-14">
                    <RecommendedMaterials
                      currentId={id}
                      subject={materialQuery.data.subject}
                      category={materialQuery.data.category}
                      level={materialQuery.data.level}
                      creator={materialQuery.data.author || materialQuery.data.creator}
                    />
                  </div>
                )}
              </motion.div>
            );
          }}
        </QueryStateProvider>
      </main>

      {materialQuery.data && (
        <Web3ErrorBoundary onRetry={() => setShowBuyModal(false)}>
          <BuyNowModal
            isOpen={showBuyModal}
            onClose={() => setShowBuyModal(false)}
            price={materialQuery.data.price}
            materialId={id}
            materialTitle={materialQuery.data.title}
            materialCreator={materialQuery.data.author?.name || materialQuery.data.creator || "Unknown"}
            onAccessUpdated={() => entitlementQuery.refetch()}
          />
        </Web3ErrorBoundary>
      )}

      <ReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        materialId={id}
        materialTitle={materialQuery.data?.title || ""}
      />
    </>
  );
}
