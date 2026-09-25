# Project Workflows

EduVault supports three primary product paths: creators publish resources, learners discover and access resources, and marketplace services coordinate listings, purchases, and entitlement checks.

## Creator Workflow

1. **Create or update a profile**: the creator connects a wallet, adds profile details, and saves the profile so marketplace listings can be attributed to a recognizable seller.
2. **Prepare a material**: the creator chooses a title, description, category, price, cover image, usage rights, and the source file that learners will receive after purchase.
3. **Upload content**: the app validates the file (allowed extension, MIME and magic-number check, size limit, and an executable/suspicious-extension block) before sending it to the upload API, which pins content and metadata through Pinata/IPFS and stores the resulting references with the material record in MongoDB. Clean files are enrolled in a malware **quarantine** (`pending`) with a `scan_content` side-effect; a material is only promoted to a marketplace listing once the scanner reports `quarantineState: clean` (fail-closed on scanner failure). Unsafe or quarantined materials never appear in marketplace discovery.
4. **Publish the listing**: the creator reviews pricing, visibility, and licensing terms before making the material discoverable in the marketplace.
5. **Manage ongoing listings**: creators should keep metadata current, unpublish outdated resources, and monitor marketplace activity as analytics and payout features mature.
6. **Future Stellar step**: once Soroban purchase flows are enabled, published materials will also be registered with the Stellar contract layer so pricing and entitlement state can be verified independently.

## Learner Workflow

1. **Browse the marketplace**: learners search and filter educational materials by topic (title/description/subject text search), subject, level, language, creator, content format, and price (`GET /api/market-materials`, filters built in `buildMarketplaceDiscoveryQuery`). When the request carries the viewing wallet's address, results are entitlement-aware (#707): materials the wallet already owns are marked `owned: true` and reranked after not-yet-owned results on the page, so browsing surfaces new content first while still keeping already-purchased materials reachable.
2. **Review a material**: learners open a material detail page to inspect the description, rights, creator information, and purchase requirements.
3. **Start checkout**: the learner connects a supported wallet and confirms the purchase flow.
4. **Complete payment**: the current prototype models marketplace access in the application, while the planned Stellar flow submits a Soroban transaction for XLM or supported Stellar-asset settlement.
5. **Receive access**: after purchase confirmation, the app checks entitlement records before exposing protected download or viewing actions.
6. **Return later**: learners can revisit purchased resources through saved materials, dashboard views, or entitlement-backed access checks as those features are expanded.

## Marketplace Flow

1. **Catalog ingestion**: material metadata is validated by API routes and stored in MongoDB with creator, pricing, rights, and content-address references.
2. **Discovery**: public marketplace pages query active listings and display normalized cards, detail pages, and creator attribution, filtering out any material whose `quarantineState` is not `clean`.
3. **Purchase coordination**: checkout connects the learner, material, price, accepted asset, and seller account into a single transaction intent.
4. **Entitlement creation**: successful purchases produce an access record. In the Stellar design, Soroban events are indexed into MongoDB collections such as purchases and entitlement caches.
5. **Protected access**: download and view requests should verify the learner's entitlement before returning private file references.
6. **Operational recovery**: indexer dead-letter queues and reprocessing scripts help maintain consistency when blockchain event processing fails or needs replay.

## Workflow Ownership

- **Frontend** owns profile, upload, marketplace, checkout, and dashboard user experiences.
- **Backend API routes** own validation, session handling, storage writes, upload orchestration, and access checks.
- **MongoDB** owns durable off-chain records for profiles, materials, purchases, cached entitlements, and operational metadata.
- **Pinata/IPFS** owns content-addressed file and metadata persistence.
- **Stellar/Soroban layer** owns the planned payment, entitlement, and event source of truth for purchase verification.
