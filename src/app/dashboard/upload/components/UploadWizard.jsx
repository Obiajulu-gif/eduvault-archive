"use client";

import Image from "next/image";
import { useState, useEffect } from "react";
import { FaCloudUploadAlt, FaCheck, FaArrowRight, FaArrowLeft, FaFileAlt, FaTags, FaDollarSign, FaEye } from "react-icons/fa";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { abi } from "../../../../../contracts/EduVaultAbi.js";
import { celoSepolia } from "wagmi/chains";
import { parseAbiItem } from "viem";
import { useCreateMaterial, useUploadFile } from "@/hooks/api/useMaterials";

const contractAddress = "0x3f48520ca0d8d51345b416b5a3e083dac8790f55";


const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
);

const STEPS = [
  { id: 1, title: "Upload Files", icon: FaFileAlt, description: "Add your document and thumbnail" },
  { id: 2, title: "Details", icon: FaTags, description: "Title and description" },
  { id: 3, title: "Pricing & Rights", icon: FaDollarSign, description: "Set price and usage rights" },
  { id: 4, title: "Review & Mint", icon: FaEye, description: "Review and publish to blockchain" },
];

export default function UploadWizard() {
  const { address } = useAccount();
  const { writeContract, data: txHash, error: writeError, isPending } = useWriteContract();
  const {
    isLoading: isWaiting,
    isSuccess: isConfirmed,
    isError: isFailed,
    data: receipt,
  } = useWaitForTransactionReceipt({ hash: txHash });

  const [currentStep, setCurrentStep] = useState(1);
  
  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [usageRights, setUsageRights] = useState("Standard License (download only)");
  const [visibility, setVisibility] = useState("public");
  const [docFile, setDocFile] = useState(null);
  const [docFileName, setDocFileName] = useState(null);
  const [thumbFile, setThumbFile] = useState(null);
  const [thumbPreview, setThumbPreview] = useState(null);

  // Workflow state
  const [workflowState, setWorkflowState] = useState("idle"); // idle | uploading | minting | success | failed
  const [error, setError] = useState(null);
  const [errorType, setErrorType] = useState(null);
  const [mintResult, setMintResult] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);

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
    }
  };

  const validateStep = (step) => {
    switch (step) {
      case 1:
        if (!docFile) {
          setError("Please upload a document file");
          return false;
        }
        return true;
      case 2:
        if (!title.trim()) {
          setError("Please enter a document title");
          return false;
        }
        return true;
      case 3:
        return true; // All fields optional
      case 4:
        return true; // Review step
      default:
        return true;
    }
  };

  const handleNext = () => {
    setError(null);
    setErrorType(null);
    
    if (validateStep(currentStep)) {
      if (currentStep < STEPS.length) {
        setCurrentStep(currentStep + 1);
      }
    }
  };

  const handlePrevious = () => {
    setError(null);
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const uploadFileMutation = useUploadFile();
  const createMaterialMutation = useCreateMaterial();

  const handleSubmit = async () => {
    setError(null);
    setErrorType(null);

    if (!address) {
      setError("Please connect your wallet to mint an NFT.");
      setErrorType("wallet");
      return;
    }

    setWorkflowState("uploading");
    setUploadProgress(0);

    try {
      // Simulate progress for UX
      const progressInterval = setInterval(() => {
        setUploadProgress((prev) => Math.min(prev + 20, 80));
      }, 300);

      // 1️⃣ Prepare FormData
      const formData = new FormData();
      formData.append("file", docFile);
      if (thumbFile) formData.append("thumbnail", thumbFile);
      formData.append("name", title);
      formData.append("description", description);
      formData.append("price", price);
      formData.append("usageRights", usageRights);
      formData.append("visibility", visibility);
      formData.append("owner", address);

      // 2️⃣ Upload to backend using shared service
      const uploadData = await uploadFileMutation.mutateAsync(formData);

      clearInterval(progressInterval);
      setUploadProgress(100);

      if (!uploadData?.metadata) {
        throw new Error("File upload failed: No metadata returned");
      }

      const tokenURI = uploadData.metadata;

      // 3️⃣ Mint NFT
      setWorkflowState("minting");
      writeContract({
        address: contractAddress,
        abi,
        functionName: "mint",
        args: [tokenURI],
        chain: celoSepolia,
      });
    } catch (err) {
      console.error("Upload Error:", err);
      setError(err?.message || "Upload failed. Please try again.");
      setErrorType("upload");
      setWorkflowState("failed");
    }
  };


  // Handle write errors
  useEffect(() => {
    if (writeError) {
      if (writeError.code === "ACTION_REJECTED" || writeError.message?.includes("User rejected")) {
        setError("Transaction rejected by user. Please try again.");
        setErrorType("wallet");
      } else if (writeError.message?.includes("insufficient funds")) {
        setError("Insufficient funds for gas. Please add CELO to your wallet.");
        setErrorType("wallet");
      } else {
        setError(writeError.message || "Transaction failed. Please try again.");
        setErrorType("chain");
      }
      setWorkflowState("failed");
    }
  }, [writeError]);

  // Parse receipt on confirmation
  useEffect(() => {
    if (isConfirmed && receipt) {
      try {
        const transferLog = receipt.logs.find(
          (log) =>
            log.address.toLowerCase() === contractAddress.toLowerCase() &&
            log.topics[0] === TRANSFER_EVENT.type
        );

        if (!transferLog) {
          throw new Error("Transfer event not found in transaction receipt");
        }

        const tokenId = BigInt(transferLog.topics[3]).toString();

        if (!tokenId || tokenId === "0") {
          throw new Error("Invalid token ID in receipt");
        }

        setMintResult({
          tokenId,
          txHash: receipt.transactionHash,
          receipt,
        });

        setWorkflowState("success");
      } catch (err) {
        console.error("Receipt parsing error:", err);
        setError(`Mint completed but failed to parse receipt: ${err.message}`);
        setErrorType("receipt");
        setWorkflowState("failed");
      }
    } else if (isFailed) {
      setError("Transaction failed on-chain. Please try again.");
      setErrorType("chain");
      setWorkflowState("failed");
    }
  }, [isConfirmed, isFailed, receipt]);

  const handleReset = () => {
    setTitle("");
    setDescription("");
    setPrice("");
    setUsageRights("Standard License (download only)");
    setVisibility("public");
    setDocFile(null);
    setDocFileName(null);
    setThumbFile(null);
    setThumbPreview(null);
    setCurrentStep(1);
    setWorkflowState("idle");
    setError(null);
    setErrorType(null);
    setMintResult(null);
    setUploadProgress(0);
  };

  const isSubmitting = workflowState === "uploading" || workflowState === "minting";

  // Success State
  if (workflowState === "success" && mintResult) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm">
        <div className="text-center">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <FaCheck className="text-green-600 text-2xl" />
          </div>
          <h2 className="text-2xl font-bold mb-2">Successfully Published!</h2>
          <p className="text-gray-600 mb-6">Your educational material has been minted and is now available on the marketplace.</p>
          
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6 text-left">
            <p className="text-sm text-green-800 mb-2"><strong>Token ID:</strong> {mintResult.tokenId}</p>
            <p className="text-sm text-green-800 mb-2"><strong>Transaction:</strong></p>
            <p className="text-xs text-green-700 font-mono break-all">{mintResult.txHash}</p>
          </div>

          <button
            onClick={handleReset}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
          >
            Upload Another Material
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm">
      {/* Progress Header */}
      <div className="border-b border-gray-200 p-6">
        <h2 className="text-xl font-bold mb-4">Publish Educational Material</h2>
        
        {/* Step Indicators */}
        <div className="flex items-center justify-between mb-2">
          {STEPS.map((step, index) => {
            const Icon = step.icon;
            const isActive = step.id === currentStep;
            const isCompleted = step.id < currentStep;
            
            return (
              <div key={step.id} className="flex-1 flex items-center">
                {/* Step Circle */}
                <div className="flex flex-col items-center">
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center transition ${
                      isCompleted
                        ? "bg-green-600 text-white"
                        : isActive
                        ? "bg-blue-600 text-white"
                        : "bg-gray-200 text-gray-600"
                    }`}
                  >
                    {isCompleted ? <FaCheck /> : <Icon className="text-sm" />}
                  </div>
                  <p className={`text-xs mt-2 font-medium ${
                    isActive ? "text-blue-600" : isCompleted ? "text-green-600" : "text-gray-500"
                  }`}>
                    {step.title}
                  </p>
                </div>
                
                {/* Connector Line */}
                {index < STEPS.length - 1 && (
                  <div className={`flex-1 h-0.5 mx-2 ${
                    step.id < currentStep ? "bg-green-600" : "bg-gray-200"
                  }`} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-md">
          <p className="text-red-600 text-sm">{error}</p>
        </div>
      )}

      {/* Step Content */}
      <div className="p-6 min-h-[400px]">
        {/* Step 1: Upload Files */}
        {currentStep === 1 && (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold mb-2">Upload Your Document</h3>
              <p className="text-sm text-gray-600 mb-4">
                Upload your lecture notes, projects, or study materials. Supported formats: PDF, DOCX, PPTX, ZIP (max 10MB).
              </p>
            </div>

            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-400 transition">
              <input
                type="file"
                id="file-upload"
                className="hidden"
                onChange={handleDocChange}
                accept=".pdf,.doc,.docx,.ppt,.pptx,.zip"
              />
              <label htmlFor="file-upload" className="cursor-pointer flex flex-col items-center">
                <FaCloudUploadAlt className="text-5xl text-blue-500 mb-3" />
                <p className="text-base font-medium text-gray-800 mb-1">
                  {docFileName || "Tap to Upload Document"}
                </p>
                <p className="text-sm text-gray-500 mb-4">
                  {docFileName ? "Click to change file" : ".pdf, .docx, .pptx, .zip | 10MB max"}
                </p>
                <button type="button" className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">
                  Choose File
                </button>
              </label>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Thumbnail Image (Optional)</label>
              <div className="flex items-center gap-4">
                <input type="file" accept="image/*" onChange={handleThumbChange} className="text-sm" />
              {thumbPreview && (
                  <Image
                    src={thumbPreview}
                    alt="Preview"
                    width={64}
                    height={64}
                    unoptimized
                    className="rounded object-cover border"
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Details */}
        {currentStep === 2 && (
          <div className="space-y-5">
            <div>
              <h3 className="text-lg font-semibold mb-2">Material Details</h3>
              <p className="text-sm text-gray-600 mb-4">
                Provide a clear title and description to help students discover your material.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Document Title *</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. ECO 304 - Development Economics Lecture Notes"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Short Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Comprehensive lecture notes covering key development theories and examples."
                rows={4}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
              />
            </div>
          </div>
        )}

        {/* Step 3: Pricing & Rights */}
        {currentStep === 3 && (
          <div className="space-y-5">
            <div>
              <h3 className="text-lg font-semibold mb-2">Pricing & Usage Rights</h3>
              <p className="text-sm text-gray-600 mb-4">
                Set your price and define how others can use your material.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Price (CELO) - Optional</label>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0.00"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">Leave empty for free material</p>
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

            <div>
              <label className="block text-sm font-medium mb-2">Visibility</label>
              <div className="space-y-2">
                <label className="flex items-start gap-2 p-3 border border-gray-200 rounded-md cursor-pointer hover:bg-gray-50">
                  <input
                    type="radio"
                    name="visibility"
                    checked={visibility === "public"}
                    onChange={() => setVisibility("public")}
                    className="accent-blue-600 mt-0.5"
                  />
                  <div>
                    <p className="text-sm font-medium">Public</p>
                    <p className="text-xs text-gray-600">Anyone can view or download</p>
                  </div>
                </label>
                <label className="flex items-start gap-2 p-3 border border-gray-200 rounded-md cursor-pointer hover:bg-gray-50">
                  <input
                    type="radio"
                    name="visibility"
                    checked={visibility === "private"}
                    onChange={() => setVisibility("private")}
                    className="accent-blue-600 mt-0.5"
                  />
                  <div>
                    <p className="text-sm font-medium">Private</p>
                    <p className="text-xs text-gray-600">Only you and invited users can access</p>
                  </div>
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Review & Mint */}
        {currentStep === 4 && (
          <div className="space-y-5">
            <div>
              <h3 className="text-lg font-semibold mb-2">Review & Publish</h3>
              <p className="text-sm text-gray-600 mb-4">
                Review your material details before publishing to the blockchain.
              </p>
            </div>

            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
              <div>
                <p className="text-xs text-gray-500 mb-1">Document</p>
                <p className="text-sm font-medium">{docFileName}</p>
              </div>
              {thumbPreview && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Thumbnail</p>
                  <Image
                    src={thumbPreview}
                    alt="Thumbnail"
                    width={80}
                    height={80}
                    unoptimized
                    className="rounded object-cover"
                  />
                </div>
              )}
              <div>
                <p className="text-xs text-gray-500 mb-1">Title</p>
                <p className="text-sm font-medium">{title}</p>
              </div>
              {description && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Description</p>
                  <p className="text-sm text-gray-700">{description}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-gray-500 mb-1">Price</p>
                  <p className="text-sm font-medium">{price ? `${price} CELO` : "Free"}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-1">Usage Rights</p>
                  <p className="text-sm font-medium">{usageRights}</p>
                </div>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">Visibility</p>
                <p className="text-sm font-medium capitalize">{visibility}</p>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-800">
                <strong>Note:</strong> Publishing will mint your material as an NFT on the blockchain. A small gas fee will be charged.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Footer Navigation */}
      <div className="border-t border-gray-200 p-6 flex justify-between">
        <button
          type="button"
          onClick={handlePrevious}
          disabled={currentStep === 1 || isSubmitting}
          className="px-5 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <FaArrowLeft className="text-xs" />
          Previous
        </button>

        {currentStep < STEPS.length ? (
          <button
            type="button"
            onClick={handleNext}
            disabled={isSubmitting}
            className="px-5 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition text-sm font-medium disabled:opacity-50 flex items-center gap-2"
          >
            Next
            <FaArrowRight className="text-xs" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting || !address}
            className="px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition text-sm font-medium disabled:opacity-50 flex items-center gap-2"
          >
            {workflowState === "uploading" ? (
              <>
                <span className="animate-spin">⏳</span>
                Uploading... ({uploadProgress}%)
              </>
            ) : workflowState === "minting" ? (
              <>
                <span className="animate-spin">⏳</span>
                Minting NFT...
              </>
            ) : (
              <>
                Publish & Mint NFT
                <FaArrowRight className="text-xs" />
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
