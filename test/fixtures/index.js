export const users = {
    creator: {
        _id: "user_creator_1",
        walletAddress: "0xCreatorWalletAddress1234567890",
        email: "creator@eduvault.test",
        fullName: "Alice Educator",
    },
    buyer: {
        _id: "user_buyer_1",
        walletAddress: "0xBuyerWalletAddress0987654321",
        email: "buyer@eduvault.test",
        fullName: "Bob Student",
    }
};

export const materials = {
    draft: {
        _id: "mat_draft_123",
        title: "Draft Macroeconomics Notes",
        description: "In-progress notes.",
        userAddress: users.creator.walletAddress,
        creatorWallet: users.creator.walletAddress,
        status: "draft",
        price: "10",
        asset: "XLM",
        storageKey: "https://eduvault.test/files/draft.pdf",
    },
    published: {
        _id: "mat_pub_456",
        title: "Published Microeconomics Notes",
        description: "Complete notes.",
        creatorWallet: users.creator.walletAddress,
        status: "published",
        price: "15",
        asset: "USDC",
        contractId: "C_SOROBAN_CONTRACT_ID_789",
        ipfsHash: "QmTestHash...",
    }
};

// Purchase flow fixtures for E2E tests
export const purchaseFixtures = {
    material: {
        _id: "mat_e2e_001",
        title: "Advanced Calculus Notes",
        description: "Comprehensive calculus textbook",
        creatorWallet: users.creator.walletAddress,
        userAddress: users.creator.walletAddress,
        status: "published",
        price: "25",
        asset: "USDC",
        visibility: "public",
        version: 1,
        ipfsHash: "QmE2ETestHash123456789",
        isDeleted: false,
        archived: false,
    },
    checkoutQuote: {
        quoteId: "quote-test-uuid-001",
        materialId: "mat_e2e_001",
        materialDocumentId: "mat_e2e_001",
        buyerAddress: users.buyer.walletAddress,
        terms: {
            price: "25",
            asset: "USDC",
            creatorAddress: users.creator.walletAddress,
            materialVersion: 1,
        },
        status: "open",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
    purchase: {
        materialId: "mat_e2e_001",
        buyerAddress: users.buyer.walletAddress.toLowerCase(),
        userEmail: "buyer@eduvault.test",
        status: "confirmed",
        transactionHash: "0xTestTransactionHash123",
        signedXdr: "test-signed-xdr",
        amount: "25",
        asset: "USDC",
        quoteId: "quote-test-uuid-001",
        purchaseSnapshot: {
            price: "25",
            asset: "USDC",
            creatorAddress: users.creator.walletAddress,
            materialVersion: 1,
        },
        purchasedAt: new Date(),
        confirmedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
    },
    entitlement: {
        materialId: "mat_e2e_001",
        buyerAddress: users.buyer.walletAddress.toLowerCase(),
        active: true,
        source: "purchase-api",
        purchaseId: "purchase_test_001",
        transactionHash: "0xTestTransactionHash123",
        amount: "25",
        asset: "USDC",
        updatedAt: new Date(),
        createdAt: new Date(),
    },
    stellarTransaction: {
        hash: "0xTestTransactionHash123",
        xdr: "test-signed-xdr",
        amount: "25",
        asset: "USDC",
    },
};