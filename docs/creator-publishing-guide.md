# Creator Publishing Guide

This guide explains how educators and creators upload, configure, and list learning materials on EduVault for discovery and purchase.

## Prerequisites

Before publishing, ensure you have:

- An EduVault account (created via wallet-based onboarding or email signup).
- A connected Stellar wallet with a small amount of XLM for transaction gas fees.
- The material file ready for upload (PDF, DOCX, PPTX, or image formats).
- A cover image or thumbnail (optional but recommended for marketplace visibility).

## Step 1: Access the Creator Dashboard

1. Open EduVault and connect your Stellar wallet.
2. Navigate to the **Dashboard** from the top navigation.
3. The dashboard shows your earnings, recent activity, and material management sections.

If this is your first time, complete the onboarding flow at `/onboarding` to set up your creator profile with a display name, bio, and optional avatar.

## Step 2: Open the Upload Form

1. From the dashboard, click **Upload Material** in the sidebar or the top-level navigation.
2. You are directed to `/dashboard/upload`, which opens the Upload Wizard.

The wizard guides you through four steps:

1. Upload your file and set basic details.
2. Review and confirm material information.
3. Sign the on-chain registration transaction.
4. Receive a success confirmation.

## Step 3: Upload Your File

1. Select the educational material file from your device.
2. The file is validated before upload (see **Upload validation and malware quarantine** below).
3. Once validated, the file is uploaded directly to IPFS through Pinata. You will see a progress indicator during the upload.
4. Once pinned, the file receives a content identifier (CID) that serves as its permanent, tamper-proof address on IPFS.

**Supported file types:**

- Documents: PDF, DOCX, DOC, TXT
- Presentations: PPTX, PPT
- Images: PNG, JPG, JPEG, SVG (for supplementary materials)

**File size limits:**

- Maximum file size is determined by your Pinata plan. Default free-tier limit is typically around 100 MB per pin.

### Upload validation and malware quarantine

EduVault can host downloadable content, so every upload is validated and
scanned before it can appear in the marketplace. This is enforced in
`src/lib/ipfs/uploadValidator.js` and the `POST /api/upload` route.

1. **Allowed extensions & MIME:** the file must match one of the supported
   extensions above and the payload must have a plausible MIME type.
2. **Executable blocking:** executable and script-bearing extensions
   (`.exe`, `.bat`, `.cmd`, `.com`, `.scr`, `.pif`, `.dll`, `.msi`, `.js`,
   `.vbs`, `.ps1`, `.sh`, `.apk`, `.jar`, ...) are **blocked outright** with a
   `422` — dangerous file types are rejected before any upload and before
   marketplace listing.
3. **Magic-number / content sniffing:** the declared extension is cross-checked
   against the file's actual magic number, so a renamed executable
   (e.g. `notes.pdf` that is really an `.exe`) is rejected.
4. **Oversized files** are rejected at the size limit.
5. **Malware scanning (fail-closed):** clean files are enrolled in a
   **quarantine record** (`pending`) and a `scan_content` side-effect is
   enqueued. The material is **not** listed in the marketplace until the
   scanner flips its `quarantineState` to `clean`. If the scanner fails or is
   unavailable, the upload **fails closed** (it stays quarantined and is not
   promoted to a marketplace listing) rather than publishing un-scanned
   content. Unsafe material is never listed.

## Step 4: Fill In Material Details

After the file upload completes, provide the following metadata:

| Field | Required | Description |
| --- | --- | --- |
| **Title** | Yes | A clear, descriptive name for the material (e.g., "Calculus II Final Exam Prep Pack"). |
| **Description** | Yes | A summary of what the material covers, who it is for, and its learning objectives. |
| **Cover Image** | Recommended | A thumbnail displayed in the marketplace. Recommended size: 800x600 px. |
| **Category** | Yes | The subject area or academic discipline (e.g., Mathematics, Computer Science). |
| **Tags** | Optional | Comma-separated keywords to improve search discoverability. |
| **License** | Yes | The usage rights attached to this material (e.g., Personal Use, Institutional License). |

**Tips for effective listings:**

- Use a specific title rather than a generic one ("Organic Chemistry Problem Set 3" vs "Notes").
- Write a description that highlights the target audience and key topics.
- Choose a clear, legible cover image that represents the material visually.

## Step 5: Set Pricing

Configure the pricing terms for your material:

1. **Select accepted asset** — Choose which Stellar asset buyers can use (e.g., XLM, USDC). Creators may configure multiple accepted assets, each with its own price quote.
2. **Set the price** — Enter the amount for the selected asset. Prices are stored on-chain in the `MaterialRegistry` contract as explicit `AssetQuote` entries.
3. **Define payout shares** — Optionally split revenue with collaborators or institutions. Shares are expressed in basis points (100 bps = 1%) and must sum to exactly 10,000 bps.

**Pricing example:**

| Recipient | Share |
| --- | --- |
| Creator | 85% (8,500 bps) |
| Platform fee | 10% (1,000 bps) |
| Collaborator | 5% (500 bps) |

The platform fee is applied automatically by the `PurchaseManager` contract and is not part of the creator-defined payout split.

## Step 5b: Configure Previews (Paid Content)

For paid materials, creators must define preview bounds so buyers can sample content without accessing the full protected file:
- **Preview Metadata**: Define which sections or pages are visible before purchase.
- **Preview Length**: Set a maximum percentage (e.g., 10%) or absolute limit (e.g., first 5 pages, first 30 seconds of video).
- **Watermarking**: Previews are automatically rendered with watermarks.
- Server-side enforcement ensures that preview endpoints never serve protected full assets before a confirmed purchase.

## Step 6: Review and Confirm

1. The wizard presents a summary of all material details: file, metadata, pricing, and payout configuration.
2. Review each section carefully. Errors in on-chain registration cannot be easily reversed.
3. Click **Confirm** to proceed to the signing step.

## Step 7: Sign the On-Chain Transaction

1. The app constructs a Soroban transaction to register your material in the `MaterialRegistry` contract.
2. Your Stellar wallet presents a signing prompt. The transaction includes:
   - Material metadata hash
   - Rights hash
   - Accepted-asset quotes
   - Payout share configuration
3. Approve the transaction in your wallet.
4. The `MaterialRegistry` contract stores your material and emits a `material.registered` event.

**What happens on-chain:**

- A unique `material_id` is generated from `sha256(creator || creator_nonce)`.
- Your creator address, metadata hash, and rights hash are stored immutably.
- The material status is set to `Active`.

## Step 8: Confirmation and Indexing

1. After the transaction is confirmed on the Stellar network, the frontend displays a success message.
2. The backend indexer detects the `material.registered` event and creates a corresponding `materials` record in MongoDB.
3. The material becomes visible in the marketplace after indexing completes (typically within a few seconds).

## Step 9: Manage Your Published Materials

After publishing, manage your materials from the dashboard:

- **My Materials** (`/dashboard/my-materials`) — View, pause, or archive existing materials.
- **Market** (`/dashboard/market`) — See marketplace performance and buyer activity.
- **Analytics** (`/dashboard/analytics`) — Track views, purchases, and earnings over time.

### Updating Material Details

You can update pricing and payout shares after publication:

1. Navigate to **My Materials**.
2. Select the material to edit.
3. Click **Update Sale Terms**.
4. Modify accepted assets, prices, or payout shares.
5. Sign the updated transaction in your wallet.

**Note:** Creator ownership, metadata hash, and rights hash are immutable after initial registration. Only sale terms and material status can be changed.

### Pausing, Archiving or Rolling Back

- **Pause** — Temporarily disables new purchases while preserving existing entitlements.
- **Archive** — Permanently hides the material from the marketplace.
- **Version Rollback** — Revert a material to a previous safe version after a bad upload (e.g., incorrect or corrupt content).
  - Preserves immutable purchase references so historical receipts remain accurate.
  - Exposes `current`, `rolled-back`, and `deprecated` version states.
  - Buyers retain access to the version they purchased according to policy.

These actions require a signed on-chain transaction via `MaterialRegistry.set_material_status()`.

## Error Handling

| Error | Cause | Resolution |
| --- | --- | --- |
| Upload failed | Pinata connection issue | Check your `PINATA_JWT` configuration and retry. |
| Transaction rejected | Wallet signing denied | Approve the transaction prompt in your wallet. |
| Insufficient balance | Not enough XLM for gas | Fund your account via Friendbot (testnet) or receive XLM. |
| Material already exists | Duplicate registration attempt | Use the edit flow to update existing material instead. |
| Metadata validation error | Missing required fields | Complete all required fields in the upload form. |
| File type rejected (422) | Executable/suspicious extension or MIME mismatch | Upload one of the supported, non-executable file types listed in Step 3. |
| Magic-number mismatch (422) | Declared extension does not match the file's real content (e.g. a renamed executable) | Re-save the file in a supported format and re-upload. |
| Malware scan pending / failed | Upload quarantined or scanner unavailable | Material is held out of the marketplace (fail-closed) until the scanner reports `clean`; contact support if a legitimate file is stuck. |

## Related Documentation

- [Stellar Wallet Setup](stellar-wallet-setup.md)
- [Stellar Integration Guide](stellar-integration.md)
- [Architecture](architecture.md)
- [Soroban Contract Architecture](soroban-contract-architecture.md)
- [Contribution Guide](contributing.md)
