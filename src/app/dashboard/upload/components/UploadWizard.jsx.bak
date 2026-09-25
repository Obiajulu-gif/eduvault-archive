"use client";

import Image from "next/image";
import { useState, useEffect } from "react";
import { 
  FaCloudUploadAlt, 
  FaCheck, 
  FaArrowRight, 
  FaArrowLeft, 
  FaFileAlt, 
  FaTags, 
  FaDollarSign, 
  FaEye, 
  FaSpinner, 
  FaExternalLinkAlt, 
  FaExclamationTriangle 
} from "react-icons/fa";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSwitchChain } from "wagmi";
import { FaCloudUploadAlt, FaCheck, FaArrowRight, FaArrowLeft, FaFileAlt, FaTags, FaDollarSign, FaEye, FaExclamationTriangle } from "react-icons/fa";
import { useWallet } from "@/hooks/useWallet";
import { abi } from "../../../../../contracts/EduVaultAbi.js";
import { parseAbiItem } from "viem";
import { useCreateMaterial, useUploadFile } from "@/hooks/api/useMaterials";
import TransactionStatusPanel from "@/components/transactions/TransactionStatusPanel";
import { useTransactionCenter } from "@/providers/TransactionProvider";
import { TransactionStatus } from "@/lib/transactions/transaction";
import { isUploadChain } from "@/lib/web3/chains";

const contractAddress = process.env.NEXT_PUBLIC_UPLOAD_CONTRACT_ADDRESS ?? "0x3f48520ca0d8d51345b416b5a3e083dac8790f55";

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
  const { address } = useWallet();
  const writeContract = () => {};
  const txHash = null;
  const writeError = null;
  const isPending = false;
  const isWaiting = false;
  const isConfirmed = false;
  const isFailed = false;
  const receipt = null;
  const switchChainAsync = async () => {};

  const [currentStep, setCurrentStep] = useState(1);

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [subject, setSubject] = useState("");
  const [price, setPrice] = useState("");
  const [usageRights, setUsageRights] = useState("Standard License (download only)");
  const [visibility, setVisibility] = useState("public");
  const [docFile, setDocFile] = useState(null);
  const [docFileName, setDocFileName] = useState(null);
  const [thumbFile, setThumbFile] = useState(null);
  const [thumbPreview, setThumbPreview] = useState(null);

  // Taxonomy state
  const [categories, setCategories] = useState([]);
  const [taxonomySubjects, setTaxonomySubjects] = useState([]);

  // Workflow state
  const [workflowState, setWorkflowState] = useState("idle"); // idle | uploading | minting | success | failed
  const [error, setError] = useState(null);
  const [errorType, setErrorType] = useState(null);
  const [mintResult, setMintResult] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadResult, setUploadResult] = useState(null);
  const [switchingChain, setSwitchingChain] = useState(false);

  const uploadFileMutation = useUploadFile();
  const createMaterialMutation = useCreateMaterial();

  const chainMismatch = address && chainId && !isUploadChain(chainId);
  const chainMismatch = false;

  useEffect(() => {
    async function loadTaxonomy() {
      try {
        const res = await fetch("/api/subjects");
        if (res.ok) {
          const data = await res.json();
          setCategories(data.categories || []);
          setTaxonomySubjects(data.subjects || []);
        }
      } catch {
        // Non-critical — dropdowns stay empty
      }
    }
    loadTaxonomy();
  }, []);

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

  const handleSwitchChain = async () => {
    try {
      setSwitchingChain(true);
      await switchChainAsync({ chainId: celoSepolia.id });
    } catch (err) {
      console.error("Failed to switch chain:", err);
    } finally {
      setSwitchingChain(false);
    }
  };

  const validateStep = (step) => {
    switch (step) {
      case 1:
        if (!docFile) {
          setError("Please upload a document file.");
          return false;
        }
        if (docFile.size > 10 * 1024 * 1024) {
          setError("Document file size exceeds the 10MB limit. Please select a smaller file.");
          return false;
        }
        const docExt = docFile.name.substring(docFile.name.lastIndexOf(".")).toLowerCase();
        const ALLOWED_DOC_EXTENSIONS = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".zip"];
        if (!ALLOWED_DOC_EXTENSIONS.includes(docExt)) {
          setError("Unsupported file format. Please upload a PDF, Word, Excel, PowerPoint, Text, or ZIP file.");
          return false;
        }
        if (thumbFile) {
          if (thumbFile.size > 5 * 1024 * 1024) {
            setError("Thumbnail size exceeds the 5MB limit. Please select a smaller image.");
            return false;
          }
          const thumbExt = thumbFile.name.substring(thumbFile.name.lastIndexOf(".")).toLowerCase();
          const ALLOWED_THUMB_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
          if (!ALLOWED_THUMB_EXTENSIONS.includes(thumbExt)) {
            setError("Unsupported thumbnail type. Please upload a JPG, PNG, or WEBP image.");
            return false;
          }
        }
        return true;
      case 2:
        if (!title.trim()) {
          setError("Please enter a document title.");
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

  const handleSwitchChain = async () => {
    setError(null);
    setSwitchingChain(true);
    try {
      await switchChainAsync({ chainId: celoSepolia.id });
    } catch (err) {
      if (err.code === "ACTION_REJECTED" || err.message?.includes("User rejected")) {
        setError("Network switch was rejected. Please switch to Stellar Testnet to publish.");
        setErrorType("chain");
      } else if (err.message?.includes("does not support")) {
        setError("Your wallet does not support switching to Stellar Testnet. Please switch manually.");
        setErrorType("chain");
      } else {
        setError(err.message || "Failed to switch network. Please try manually.");
        setErrorType("chain");
      }
    } finally {
      setSwitchingChain(false);
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

    if (chainMismatch) {
      setError("Please switch your network to Celo Sepolia.");
      setError(`Please switch to Stellar Testnet before publishing. Use the network switch button above.`);
      setErrorType("chain");
      return;
    }

    setWorkflowState("uploading");
    setUploadProgress(0);
    beginTransaction({
      scope: "publish",
      title: "Publishing material",
      message: "Uploading files and preparing the mint request.",
    });

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
      if (category) formData.append("category", category);
      if (subject) formData.append("subject", subject);

      // 2️⃣ Upload to backend using shared service with retry logic
      let uploadData;
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

      clearInterval(progressInterval);
      setUploadProgress(100);

      setUploadResult(uploadData);
      const tokenURI = uploadData.metadata;

      // 3️⃣ Mint NFT
      setWorkflowState("minting");
      markStatus(TransactionStatus.Signing, {
        title: "Approve mint",
        message: "Open your wallet and approve the mint transaction.",
      });
      writeContract({
        address: contractAddress,
        abi,
        functionName: "mint",
        args: [tokenURI],
        chain: "Stellar Testnet",
      });
    } catch (err) {
      console.error("Upload Error:", err);
      let friendlyError = err?.message || "Upload failed. Please try again.";
      if (friendlyError.includes("exceeds the 10MB limit")) {
        friendlyError = "The selected document exceeds the 10MB limit. Please choose a smaller file.";
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
      setErrorType("upload");
      setWorkflowState("failed");
      failTransaction(err instanceof Error ? err : new Error(String(err)), {
        title: "Publish failed",
        message: friendlyError,
        retryable: true,
      });
    }
  };

  // Handle write errors
  useEffect(() => {
    if (writeError) {
      let friendlyError = writeError.message || "Transaction failed. Please try again.";
      if (writeError.code === "ACTION_REJECTED" || writeError.message?.includes("User rejected")) {
        friendlyError = "Transaction rejected by user. Please try again.";
        setErrorType("wallet");
      } else if (writeError.message?.includes("insufficient funds")) {
        friendlyError = "Insufficient funds for gas. Please add CELO to your wallet.";
        setError("Insufficient funds for XLM transaction fees. Please add XLM to your wallet.");
        setErrorType("wallet");
      } else {
        setErrorType("chain");
      }
      setError(friendlyError);
      setWorkflowState("failed");
      failTransaction(writeError, {
        title: "Transaction failed",
        message: friendlyError,
        retryable: true,
      });
    }
  }, [writeError, failTransaction]);

  // Track transaction confirmation progress
  useEffect(() => {
    if (txHash && !isConfirmed) {
      markStatus(TransactionStatus.PendingConfirmation, {
        txHash,
        title: "Awaiting confirmation",
        message: "The transaction was broadcast. Waiting for network confirmation.",
      });
    }
  }, [isConfirmed, markStatus, txHash]);

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

        if (!uploadResult) {
          throw new Error("Storage metadata not available. Please try uploading again.");
        }

        const saveToDb = async () => {
          try {
            const savedData = await createMaterialMutation.mutateAsync({
              title,
              description,
              price: price ? Number(price) : 0,
              usageRights,
              visibility,
              storageKey: uploadResult.storageKey,
              thumbnail: uploadResult.image || null,
              metadataUrl: uploadResult.metadata,
              creator: address,
              txHash: receipt.transactionHash,
              tokenId,
            });

            setMintResult({
              tokenId,
              txHash: receipt.transactionHash,
              receipt,
              id: savedData.id || savedData._id,
            });

            setWorkflowState("success");
            confirmTransaction({
              txHash: receipt.transactionHash,
              title: "Material published",
              message: "Your material is now available in the marketplace.",
            });
          } catch (err) {
            console.error("Database persistence error:", err);
            setError(`NFT minted successfully but database registration failed: ${err.message}`);
            setErrorType("database");
            setWorkflowState("failed");
            failTransaction(err instanceof Error ? err : new Error(String(err)), {
              title: "Database sync failed",
              message: err?.message || "Mint completed but database sync failed.",
              retryable: true,
            });
          }
        };

        saveToDb();
      } catch (err) {
        console.error("Receipt parsing error:", err);
        setError(`Mint completed but failed to parse receipt: ${err.message}`);
        setErrorType("receipt");
        setWorkflowState("failed");
        failTransaction(err instanceof Error ? err : new Error(String(err)), {
          title: "Confirmation failed",
          message: err?.message || "Mint completed but we could not parse the receipt.",
          retryable: true,
        });
      }
    } else if (isFailed) {
      setError("Transaction failed on-chain. Please try again.");
      setErrorType("chain");
      setWorkflowState("failed");
      failTransaction(new Error("Transaction failed on-chain. Please try again."), {
        title: "Transaction failed",
        message: "Transaction failed on-chain. Please try again.",
        retryable: true,
      });
    }
  }, [confirmTransaction, failTransaction, isConfirmed, isFailed, receipt, uploadResult, createMaterialMutation, title, description, price, usageRights, visibility, address]);

  const handleReset = () => {
    setTitle("");
    setDescription("");
    setCategory("");
    setSubject("");
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
    clearTransaction();
  };

  const isSubmitting = workflowState === "uploading" || workflowState === "minting";

  // Success State
  if (workflowState === "success" && mintResult) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm max-w-xl mx-auto my-4 text-center">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-bounce">
          <FaCheck className="text-green-600 text-2xl" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Successfully Published!</h2>
        <p className="text-sm text-gray-600 mb-6">
          Your educational material has been minted and registered in our marketplace indexer.
        </p>

        {/* Material Preview Card */}
        <div className="border border-gray-200 rounded-xl p-4 mb-6 bg-gray-50 flex items-center gap-4 text-left">
          {thumbPreview ? (
            <Image
              src={thumbPreview}
              alt="Published Material"
              width={64}
              height={64}
              unoptimized
              className="rounded-lg object-cover border border-gray-200"
            />
          ) : (
            <div className="w-16 h-16 bg-blue-50 text-blue-500 rounded-lg flex items-center justify-center border border-gray-200">
              <FaFileAlt className="text-2xl" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h4 className="text-base font-semibold text-gray-800 truncate">{title}</h4>
            <p className="text-xs text-gray-500 line-clamp-1 mt-0.5">{description || "No description provided."}</p>
            <div className="flex gap-4 mt-2 text-xs font-semibold text-gray-700">
              <span>Price: {price > 0 ? `${price} CELO` : "Free"}</span>
              <span>Rights: {usageRights}</span>
            </div>
          </div>
        </div>

        {/* Transaction Details */}
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-8 text-left space-y-2">
          <div className="flex justify-between items-center text-sm">
            <span className="text-green-800 font-medium">Token ID</span>
            <span className="font-mono bg-green-100 text-green-800 px-2 py-0.5 rounded text-xs font-semibold">#{mintResult.tokenId}</span>
          </div>
          <div className="text-sm">
            <span className="text-green-800 font-medium block mb-1">Transaction Hash</span>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-green-700 font-mono break-all line-clamp-1">{mintResult.txHash}</span>
              <a
                href={`https://sepolia.celoscan.xyz/tx/${mintResult.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-green-800 hover:text-green-900 font-semibold underline flex items-center gap-1 shrink-0"
              >
                Explorer
                <FaExternalLinkAlt className="text-[10px]" />
              </a>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <a
            href="/dashboard/my-materials"
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition font-medium text-sm text-center shadow-sm"
          >
            View My Materials
          </a>
          <button
            onClick={handleReset}
            className="px-6 py-2.5 border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-lg transition font-medium text-sm text-center"
          >
            Upload Another
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
      {error && !chainMismatch && (
        <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-md">
          <p className="text-red-600 text-sm">{error}</p>
        </div>
      )}

      <div className="px-6 mt-4">
        <TransactionStatusPanel
          transaction={activeTransaction}
          onRetry={handleSubmit}
          onClear={clearTransaction}
        />
      </div>
      {chainMismatch && (
        <div className="mx-6 mt-4 p-4 bg-amber-50 border border-amber-200 rounded-md">
          <div className="flex items-start gap-3">
            <FaExclamationTriangle className="text-amber-500 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-800 mb-1">
                Wrong Network Detected
              </p>
              <p className="text-xs text-amber-700 mb-3">
              Publishing requires the <strong>Stellar Testnet</strong> network. Your wallet is currently on the wrong network.
              </p>
              <button
                type="button"
                onClick={handleSwitchChain}
                disabled={switchingChain}
                className="px-4 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white text-xs font-medium rounded-md transition"
              >
                {switchingChain ? "Switching..." : `Switch to Stellar Testnet`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step Content */}
      <div className={`p-6 min-h-[400px] ${isSubmitting ? 'flex flex-col justify-center items-center' : ''}`}>
        {workflowState === "uploading" && (
          <div className="w-full max-w-md text-center py-8 space-y-6">
            <div className="relative flex justify-center items-center">
              <div className="w-24 h-24 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center animate-pulse mx-auto">
                <FaCloudUploadAlt className="text-4xl animate-bounce" />
              </div>
              <div className="absolute inset-0 rounded-full border-4 border-blue-100 border-t-blue-600 animate-spin w-24 h-24 mx-auto"></div>
            </div>
            
            <div className="space-y-2">
              <h3 className="text-xl font-bold text-gray-900">Uploading Material</h3>
              <p className="text-sm text-gray-600">Uploading your document and thumbnail to decentralized IPFS storage...</p>
            </div>

            {/* Progress Bar */}
            <div className="space-y-1 w-full">
              <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden border border-gray-200 shadow-inner">
                <div 
                  className="bg-gradient-to-r from-blue-500 to-indigo-600 h-full rounded-full transition-all duration-300 ease-out" 
                  style={{ width: `${uploadProgress}%` }}
                ></div>
              </div>
              <div className="flex justify-between text-xs font-semibold text-gray-500 px-1">
                <span>Storing files...</span>
                <span>{uploadProgress}%</span>
              </div>
            </div>
          </div>
        )}

        {workflowState === "minting" && (
          <div className="w-full max-w-md text-center py-8 space-y-6">
            <div className="relative flex justify-center items-center">
              <div className="w-24 h-24 bg-purple-50 text-purple-600 rounded-full flex items-center justify-center animate-pulse mx-auto">
                <FaSpinner className="text-4xl animate-spin" />
              </div>
              <div className="absolute inset-0 rounded-full border-4 border-purple-100 border-t-purple-600 animate-spin w-24 h-24 mx-auto"></div>
            </div>

            <div className="space-y-2">
              <h3 className="text-xl font-bold text-gray-900">Minting NFT on Celo</h3>
              <p className="text-sm text-gray-600">Please confirm the transaction in your connected wallet provider to finalize publishing.</p>
            </div>

            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-purple-50 text-purple-700 rounded-full text-xs font-medium border border-purple-100">
              <span className="w-2 h-2 rounded-full bg-purple-500 animate-ping"></span>
              Waiting for wallet confirmation...
            </div>
          </div>
        )}

        {!isSubmitting && (
          <>
            {/* Step 1: Upload Files */}
            {currentStep === 1 && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold mb-2">Upload Your Document</h3>
                  <p className="text-sm text-gray-600 mb-4">
                    Upload your lecture notes, projects, or study materials. Supported formats: PDF, DOCX, PPTX, ZIP (max 10MB).
                  </p>
                </div>
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
              <label className="block text-sm font-medium mb-2">Price (XLM) - Optional</label>
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

                <div>
                  <label className="block text-sm font-medium mb-2">Category</label>
                  <select
                    value={category}
                    onChange={(e) => { setCategory(e.target.value); setSubject(""); }}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                  >
                    <option value="">Select a category</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>{cat.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Subject</label>
                  <select
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    disabled={!category}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <option value="">Select a subject</option>
                    {taxonomySubjects
                      .filter((s) => !category || s.categoryId === category)
                      .map((s) => (
                        <option key={s.id} value={s.label}>{s.label}</option>
                      ))}
                  </select>
                  {!category && (
                    <p className="text-xs text-gray-400 mt-1">Select a category first</p>
                  )}
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
                  <p className="text-xs text-gray-500 mb-1">Price</p>
                  <p className="text-sm font-medium">{price ? `${price} XLM` : "Free"}</p>
                </div>

                <div className="grid grid-cols-2 gap-3">
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
                  {category && (
                    <div>
                      <p className="text-xs text-gray-500 mb-1">Category</p>
                      <p className="text-sm font-medium">
                        {categories.find((c) => c.id === category)?.label || category}
                      </p>
                    </div>
                  )}
                  {subject && (
                    <div>
                      <p className="text-xs text-gray-500 mb-1">Subject</p>
                      <p className="text-sm font-medium">{subject}</p>
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
          </>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-800">
                <strong>Note:</strong> Publishing will mint your material as an NFT on the blockchain. XLM transaction fees will apply.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Footer Navigation */}
      {!isSubmitting && (
        <div className="border-t border-gray-200 p-6 flex justify-between">
          <button
            type="button"
            onClick={handlePrevious}
            disabled={currentStep === 1}
            className="px-5 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <FaArrowLeft className="text-xs" />
            Previous
          </button>

          {currentStep < STEPS.length ? (
            <button
              type="button"
              onClick={handleNext}
              className="px-5 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition text-sm font-medium disabled:opacity-50 flex items-center gap-2"
            >
              Next
              <FaArrowRight className="text-xs" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting || !address || chainMismatch}
              className="px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition text-sm font-medium disabled:opacity-50 flex items-center gap-2"
            >
              Publish & Mint NFT
              <FaArrowRight className="text-xs" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
