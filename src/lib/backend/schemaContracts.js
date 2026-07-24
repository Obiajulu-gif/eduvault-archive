export const COLLECTIONS = Object.freeze({
  users: "users",
  materials: "materials",
  purchases: "purchases",
  entitlementCache: "entitlement_cache",
  syncState: "sync_state",
  syncEvents: "sync_events",
  collections: "collections",
  progress: "progress",
  deadLetterEvents: "dead_letter_events",
  materialHistory: "material_history",
  savedMaterials: "saved_materials",
  migrationConflicts: "_migration_conflicts",

  // Security and workflow collections.
  challenges: "auth_challenges",
  uploadSessions: "upload_sessions",

  // Migration infrastructure.
  schemaMigrations: "_schema_migrations",
  migrationLock: "_migration_lock",

  // Webhooks
  webhooks: "webhooks",
  webhookDeliveries: "webhook_deliveries",

  // Content provenance.
  manifests: "material_manifests",
  digestAnchors: "manifest_digest_anchors",

  // Escrow / Trustless Work.
  escrows: "escrows",
  milestones: "milestones",
  milestoneEvidence: "milestone_evidence",
  milestoneTransitions: "milestone_transitions",
  milestoneMigrationExceptions: "milestone_migration_exceptions",
  payouts: "payouts",
});

export const REQUIRED_INDEXES = Object.freeze({
  users: [
    {
      name: "users_email_unique",
      keys: { email: 1 },
      options: {
        unique: true,
      },
    },
    {
      name: "users_wallet_address_lower_unique",
      keys: { walletAddressLower: 1 },
      options: {
        unique: true,
        partialFilterExpression: {
          walletAddressLower: {
            $type: "string",
          },
        },
      },
    },
    {
      name: "users_payout_wallet_address_lower",
      keys: { payoutWalletAddressLower: 1 },
      options: {
        partialFilterExpression: {
          payoutWalletAddressLower: {
            $type: "string",
          },
        },
      },
    },
  ],

  materials: [
    {
      name: "materials_creator_created_at",
      keys: { userAddress: 1, createdAt: -1 },
      options: {},
    },
    {
      name: "materials_visibility_created_at",
      keys: { visibility: 1, createdAt: -1 },
      options: {},
    },
    {
      name: "materials_material_id",
      keys: { materialId: 1 },
      options: {
        partialFilterExpression: {
          materialId: {
            $type: "string",
          },
        },
      },
    },
    {
      name: "materials_token_id_unique",
      keys: { tokenId: 1 },
      options: {
        unique: true,
        partialFilterExpression: {
          tokenId: {
            $type: "string",
          },
        },
      },
    },
    {
      name: "materials_tx_hash_unique",
      keys: { txHash: 1 },
      options: {
        unique: true,
        partialFilterExpression: {
          txHash: {
            $type: "string",
          },
        },
      },
    },
    {
      name: "materials_updated_at",
      keys: { updatedAt: -1 },
      options: {},
    },
    {
      name: "materials_category",
      keys: { category: 1 },
      options: {},
    },
    {
      name: "materials_subject",
      keys: { subject: 1 },
      options: {},
    },
    {
      name: "materials_level",
      keys: { level: 1 },
      options: {},
    },
    {
      name: "materials_category_subject",
      keys: { category: 1, subject: 1 },
      options: {},
    },
    {
      name: "materials_text_search",
      keys: {
        title: "text",
        description: "text",
      },
      options: {
        default_language: "english",
      },
    },
    {
      name: "materials_category_price",
      keys: {
        category: 1,
        price: 1,
      },
      options: {},
    },
  ],

  purchases: [
    {
      name: "purchases_buyer_created_at",
      keys: { buyerAddress: 1, createdAt: -1 },
      options: {},
    },
    {
      name: "purchases_material_buyer_unique",
      keys: { materialId: 1, buyerAddress: 1 },
      options: {
        unique: true,
        partialFilterExpression: {
          materialId: {
            $type: "string",
          },
          buyerAddress: {
            $type: "string",
          },
        },
      },
    },
    {
      name: "purchases_chain_tx_hash_unique",
      keys: { chainTxHash: 1 },
      options: {
        unique: true,
        partialFilterExpression: {
          chainTxHash: {
            $type: "string",
          },
        },
      },
    },
  ],

  entitlement_cache: [
    {
      name: "entitlements_buyer_material_unique",
      keys: { buyerAddress: 1, materialId: 1 },
      options: {
        unique: true,
      },
    },
    {
      name: "entitlements_active_updated_at",
      keys: { active: 1, updatedAt: -1 },
      options: {},
    },
  ],

  sync_state: [
    {
      name: "sync_state_source_unique",
      keys: { source: 1 },
      options: {
        unique: true,
      },
    },
  ],

  sync_events: [
    {
      name: "sync_events_source_event_unique",
      keys: { source: 1, eventId: 1 },
      options: {
        unique: true,
        partialFilterExpression: {
          source: {
            $type: "string",
          },
          eventId: {
            $type: "string",
          },
        },
      },
    },
    {
      name: "sync_events_created_at",
      keys: { createdAt: -1 },
      options: {},
    },
  ],

  collections: [
    {
      name: "collections_creator_created_at",
      keys: { creatorId: 1, createdAt: -1 },
      options: {},
    },
  ],

  progress: [
    {
      name: "progress_user_material_unique",
      keys: { userId: 1, materialId: 1 },
      options: {
        unique: true,
      },
    },
    {
      name: "progress_completed_at",
      keys: { completedAt: -1 },
      options: {},
    },
  ],

  dead_letter_events: [
    {
      name: "dead_letter_events_status",
      keys: { status: 1 },
      options: {},
    },
    {
      name: "dead_letter_events_retry_count",
      keys: { retryCount: 1 },
      options: {},
    },
  ],

  material_history: [
    {
      name: "material_history_material_updated_at",
      keys: { materialId: 1, updatedAt: -1 },
      options: {},
    },
    {
      name: "material_history_updated_by",
      keys: { updatedBy: 1 },
      options: {},
    },
  ],

  saved_materials: [
    {
      name: "saved_materials_wallet_saved_at",
      keys: { walletAddress: 1, savedAt: -1 },
      options: {},
    },
    {
      name: "saved_materials_wallet_material_unique",
      keys: { walletAddress: 1, materialId: 1 },
      options: {
        unique: true,
      },
    },
  ],

  reviews: [
    {
      name: "reviews_material_created_at",
      keys: { materialId: 1, createdAt: -1 },
      options: {},
    },
    {
      name: "reviews_material_version",
      keys: { materialId: 1, reviewVersion: 1 },
      options: {},
    },
  ],

  auth_challenges: [
    {
      name: "auth_challenges_nonce_unique",
      keys: { nonce: 1 },
      options: {
        unique: true,
      },
    },
    {
      name: "auth_challenges_expires_at_ttl",
      keys: { expiresAt: 1 },
      options: {
        expireAfterSeconds: 0,
      },
    },
    {
      name: "auth_challenges_account_created_at",
      keys: { account: 1, createdAt: -1 },
      options: {},
    },
  ],

  upload_sessions: [
    {
      name: "upload_sessions_session_id_unique",
      keys: { sessionId: 1 },
      options: {
        unique: true,
      },
    },
    {
      name: "upload_sessions_expires_at_ttl",
      keys: { expiresAt: 1 },
      options: {
        expireAfterSeconds: 0,
      },
    },
    {
      name: "upload_sessions_owner_status",
      keys: { ownerId: 1, status: 1 },
      options: {},
    },
  ],

  _schema_migrations: [
    {
      name: "schema_migrations_version_unique",
      keys: { version: 1 },
      options: {
        unique: true,
      },
    },
    {
      name: "schema_migrations_status",
      keys: { status: 1, startedAt: 1 },
      options: {},
    },
  ],

  _migration_lock: [
    {
      name: "migration_lock_expires_at_ttl",
      keys: { expiresAt: 1 },
      options: {
        expireAfterSeconds: 0,
      },
    },
  ],

  webhooks: [
    {
      name: "webhooks_user_id",
      keys: { userId: 1 },
      options: {},
    },
    {
      name: "webhooks_url_unique",
      keys: { url: 1 },
      options: {
        unique: true,
      },
    },
  ],

  webhook_deliveries: [
    {
      name: "webhook_deliveries_webhook_id_created_at",
      keys: { webhookId: 1, createdAt: -1 },
      options: {},
    },
    {
      name: "webhook_deliveries_pending_next_attempt",
      keys: { status: 1, nextAttemptAt: 1 },
      options: {
        partialFilterExpression: {
          status: "pending",
        },
      },
    },
    {
      name: "webhook_deliveries_user_id_created_at",
      keys: { userId: 1, createdAt: -1 },
      options: {},
    },
    {
      name: "webhook_deliveries_event_id_webhook_id_unique",
      keys: { eventId: 1, webhookId: 1 },
      options: {
        unique: true,
      },
    },
  ],

  material_manifests: [
    {
      name: "manifests_material_version_unique",
      keys: { materialId: 1, version: 1 },
      options: { unique: true },
    },
    {
      name: "manifests_material_digest",
      keys: { materialId: 1, digest: 1 },
      options: {},
    },
    {
      name: "manifests_creator_created_at",
      keys: { creator: 1, createdAt: -1 },
      options: {},
    },
  ],

  manifest_digest_anchors: [
    {
      name: "digest_anchors_material_version_unique",
      keys: { materialId: 1, version: 1 },
      options: { unique: true },
    },
    {
      name: "digest_anchors_tx_hash",
      keys: { chainTxHash: 1 },
      options: {
        unique: true,
        partialFilterExpression: {
          chainTxHash: { $type: "string" },
        },
      },
    },
  ],

  escrows: [
    {
      name: "escrows_escrow_id_unique",
      keys: { escrowId: 1 },
      options: { unique: true },
    },
    {
      name: "escrows_contract_id_created_at",
      keys: { contractId: 1, createdAt: -1 },
      options: {},
    },
    {
      name: "escrows_chain_tx_hash_unique",
      keys: { chainTxHash: 1 },
      options: {
        unique: true,
        partialFilterExpression: { chainTxHash: { $type: "string" } },
      },
    },
  ],

  milestones: [
    {
      name: "milestones_milestone_id_unique",
      keys: { milestoneId: 1 },
      options: { unique: true },
    },
    {
      name: "milestones_escrow_id",
      keys: { escrowId: 1 },
      options: {},
    },
    {
      name: "milestones_payout_position_unique",
      keys: { payoutId: 1, position: 1 },
      options: {
        unique: true,
        partialFilterExpression: {
          payoutId: { $type: "string" },
          position: { $type: "int" },
        },
      },
    },
    {
      name: "milestones_payout_status",
      keys: { payoutId: 1, status: 1 },
      options: {
        partialFilterExpression: {
          payoutId: { $type: "string" },
        },
      },
    },
  ],

  milestone_evidence: [
    {
      name: "milestone_evidence_evidence_id_unique",
      keys: { evidenceId: 1 },
      options: { unique: true },
    },
    {
      name: "milestone_evidence_milestone_created_at",
      keys: { milestoneId: 1, createdAt: -1 },
      options: {},
    },
  ],

  milestone_transitions: [
    {
      name: "milestone_transitions_transition_id_unique",
      keys: { transitionId: 1 },
      options: { unique: true },
    },
    {
      name: "milestone_transitions_milestone_created_at",
      keys: { milestoneId: 1, createdAt: -1 },
      options: {},
    },
  ],

  milestone_migration_exceptions: [
    {
      name: "milestone_migration_exception_id_unique",
      keys: { exceptionId: 1 },
      options: { unique: true },
    },
    {
      name: "milestone_migration_source",
      keys: { migrationVersion: 1, payoutId: 1, createdAt: -1 },
      options: {},
    },
  ],

  payouts: [
    {
      name: "payouts_payout_id_unique",
      keys: { payoutId: 1 },
      options: { unique: true },
    },
    {
      name: "payouts_recipient_created_at",
      keys: { recipient: 1, createdAt: -1 },
      options: {},
    },
    {
      name: "payouts_escrow_id",
      keys: { escrowId: 1 },
      options: {},
    },
  ],
});

// ── Material field contracts ───────────────────────────────────────────────



export const COLLECTION_VALIDATORS = Object.freeze({
  users: {
    $jsonSchema: {
      bsonType: "object",
      required: ["fullName", "email", "createdAt", "updatedAt"],
      properties: {
        fullName: {
          bsonType: "string",
          minLength: 1,
        },
        email: {
          bsonType: "string",
          minLength: 3,
        },
        walletAddress: {
          bsonType: ["string", "null"],
        },
        walletAddressLower: {
          bsonType: ["string", "null"],
        },
        createdAt: {
          bsonType: "date",
        },
        updatedAt: {
          bsonType: "date",
        },
      },
    },
  },

  purchases: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "materialId",
        "buyerAddress",
        "status",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        materialId: {
          bsonType: "string",
          minLength: 1,
        },
        buyerAddress: {
          bsonType: "string",
          minLength: 1,
        },
        status: {
          enum: [
            "pending",
            "submitted",
            "confirmed",
            "failed",
            "refunded",
          ],
        },
        chainTxHash: {
          bsonType: ["string", "null"],
        },
        amount: {
          bsonType: ["double", "decimal", "int", "long", "null"],
          minimum: 0,
        },
        purchasedVersion: {
          bsonType: ["int", "long", "null"],
        },
        versionBinding: {
          bsonType: ["object", "null"],
        },
        createdAt: {
          bsonType: "date",
        },
        updatedAt: {
          bsonType: "date",
        },
      },
    },
  },

  entitlement_cache: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "materialId",
        "buyerAddress",
        "active",
        "source",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        materialId: {
          bsonType: "string",
          minLength: 1,
        },
        buyerAddress: {
          bsonType: "string",
          minLength: 1,
        },
        active: {
          bsonType: "bool",
        },
        source: {
          bsonType: "string",
          minLength: 1,
        },
        createdAt: {
          bsonType: "date",
        },
        updatedAt: {
          bsonType: "date",
        },
      },
    },
  },

  sync_events: {
    $jsonSchema: {
      bsonType: "object",
      required: ["type", "source", "raw", "createdAt"],
      properties: {
        eventId: {
          bsonType: ["string", "null"],
        },
        type: {
          bsonType: "string",
          minLength: 1,
        },
        source: {
          bsonType: "string",
          minLength: 1,
        },
        createdAt: {
          bsonType: "date",
        },
      },
    },
  },

  auth_challenges: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "nonce",
        "account",
        "issuedAt",
        "expiresAt",
        "createdAt",
      ],
      properties: {
        nonce: {
          bsonType: "string",
          minLength: 16,
        },
        account: {
          bsonType: "string",
          minLength: 1,
        },
        consumedAt: {
          bsonType: ["date", "null"],
        },
        issuedAt: {
          bsonType: "date",
        },
        expiresAt: {
          bsonType: "date",
        },
        createdAt: {
          bsonType: "date",
        },
      },
    },
  },

  upload_sessions: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "sessionId",
        "ownerId",
        "status",
        "createdAt",
        "updatedAt",
        "expiresAt",
      ],
      properties: {
        sessionId: {
          bsonType: "string",
          minLength: 1,
        },
        ownerId: {
          bsonType: "string",
          minLength: 1,
        },
        status: {
          enum: [
            "created",
            "uploading",
            "completed",
            "failed",
            "expired",
          ],
        },
        createdAt: {
          bsonType: "date",
        },
        updatedAt: {
          bsonType: "date",
        },
        expiresAt: {
          bsonType: "date",
        },
      },
    },
  },

  webhooks: {
    $jsonSchema: {
      bsonType: "object",
      required: ["userId", "url", "secrets", "status", "createdAt", "updatedAt"],
      properties: {
        userId: {
          bsonType: "string",
          minLength: 1,
        },
        url: {
          bsonType: "string",
          minLength: 1,
        },
        secrets: {
          bsonType: "array",
          items: {
            bsonType: "object",
            required: ["key", "createdAt"],
            properties: {
              key: { bsonType: "string" },
              createdAt: { bsonType: "date" },
              expiresAt: { bsonType: ["date", "null"] },
            },
          },
        },
        status: {
          enum: ["active", "disabled"],
        },
        createdAt: {
          bsonType: "date",
        },
        updatedAt: {
          bsonType: "date",
        },
      },
    },
  },

  webhook_deliveries: {
    $jsonSchema: {
      bsonType: "object",
      required: ["webhookId", "userId", "eventId", "eventType", "payload", "status", "attempts", "createdAt", "updatedAt"],
      properties: {
        webhookId: {
          bsonType: ["string", "objectId"],
        },
        userId: {
          bsonType: "string",
          minLength: 1,
        },
        eventId: {
          bsonType: "string",
          minLength: 1,
        },
        eventType: {
          bsonType: "string",
          minLength: 1,
        },
        payload: {
          bsonType: "object",
        },
        status: {
          enum: ["pending", "success", "failed", "dead_letter"],
        },
        attempts: {
          bsonType: "array",
        },
        nextAttemptAt: {
          bsonType: ["date", "null"],
        },
        createdAt: {
          bsonType: "date",
        },
        updatedAt: {
          bsonType: "date",
        },
      },
    },
  },

  material_manifests: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "materialId",
        "version",
        "digest",
        "manifest",
        "creator",
        "createdAt",
        "verified",
      ],
      properties: {
        materialId: {
          bsonType: "string",
          minLength: 1,
        },
        version: {
          bsonType: "int",
          minimum: 1,
        },
        digest: {
          bsonType: "string",
          minLength: 1,
        },
        manifest: {
          bsonType: "object",
        },
        creator: {
          bsonType: ["string", "null"],
        },
        previousVersionDigest: {
          bsonType: ["string", "null"],
        },
        chainTxHash: {
          bsonType: ["string", "null"],
        },
        createdAt: {
          bsonType: "date",
        },
        verified: {
          bsonType: "bool",
        },
        withdrawn: {
          bsonType: "bool",
        },
        createdAt: {
          bsonType: "date",
        },
      },
    },
  },

  manifest_digest_anchors: {
    $jsonSchema: {
      bsonType: "object",
      required: [
        "materialId",
        "version",
        "digest",
        "anchoredAt",
        "verified",
      ],
      properties: {
        materialId: {
          bsonType: "string",
          minLength: 1,
        },
        version: {
          bsonType: "int",
          minimum: 1,
        },
        digest: {
          bsonType: "string",
          minLength: 1,
        },
        chainTxHash: {
          bsonType: ["string", "null"],
        },
        ledgerSequence: {
          bsonType: ["int", "long", "null"],
        },
        anchoredAt: {
          bsonType: "date",
        },
        verified: {
          bsonType: "bool",
        },
      },
    },
  },

  escrows: {
    $jsonSchema: {
      bsonType: "object",
      required: ["escrowId", "status", "createdAt", "updatedAt"],
      properties: {
        escrowId: { bsonType: "string", minLength: 1 },
        contractId: { bsonType: ["string", "null"] },
        status: { enum: ["pending", "funded", "released", "refunded", "disputed"] },
        amount: { bsonType: ["string", "null"] },
        asset: { bsonType: ["string", "null"] },
        engager: { bsonType: ["string", "null"] },
        chainTxHash: { bsonType: ["string", "null"] },
        createdAt: { bsonType: "date" },
        updatedAt: { bsonType: "date" },
      },
    },
  },

  milestones: {
    $jsonSchema: {
      bsonType: "object",
      required: ["milestoneId", "escrowId", "status", "createdAt", "updatedAt"],
      properties: {
        milestoneId: { bsonType: "string", minLength: 1 },
        escrowId: { bsonType: "string", minLength: 1 },
        payoutId: { bsonType: ["string", "null"] },
        position: { bsonType: ["int", "long", "null"], minimum: 0 },
        status: { enum: ["pending", "submitted", "approved", "rejected", "completed", "paid"] },
        title: { bsonType: ["string", "null"] },
        description: { bsonType: ["string", "null"] },
        amount: { bsonType: ["string", "null"] },
        currency: { bsonType: ["string", "null"] },
        dueAt: { bsonType: ["date", "null"] },
        feedback: { bsonType: ["string", "null"] },
        onChainMilestoneId: { bsonType: ["string", "null"] },
        chainTxHash: { bsonType: ["string", "null"] },
        version: { bsonType: ["int", "long"] },
        createdAt: { bsonType: "date" },
        updatedAt: { bsonType: "date" },
      },
    },
  },

  milestone_evidence: {
    $jsonSchema: {
      bsonType: "object",
      required: ["evidenceId", "milestoneId", "payoutId", "createdAt", "updatedAt"],
      properties: {
        evidenceId: { bsonType: "string", minLength: 1 },
        milestoneId: { bsonType: "string", minLength: 1 },
        payoutId: { bsonType: "string", minLength: 1 },
        type: { bsonType: ["string", "null"] },
        uri: { bsonType: ["string", "null"] },
        label: { bsonType: ["string", "null"] },
        metadata: { bsonType: ["object", "null"] },
        createdAt: { bsonType: "date" },
        updatedAt: { bsonType: "date" },
      },
    },
  },

  milestone_transitions: {
    $jsonSchema: {
      bsonType: "object",
      required: ["transitionId", "milestoneId", "payoutId", "toStatus", "createdAt"],
      properties: {
        transitionId: { bsonType: "string", minLength: 1 },
        milestoneId: { bsonType: "string", minLength: 1 },
        payoutId: { bsonType: "string", minLength: 1 },
        fromStatus: { bsonType: ["string", "null"] },
        toStatus: { bsonType: "string", minLength: 1 },
        actorId: { bsonType: ["string", "null"] },
        reason: { bsonType: ["string", "null"] },
        source: { bsonType: "string" },
        createdAt: { bsonType: "date" },
      },
    },
  },

  milestone_migration_exceptions: {
    $jsonSchema: {
      bsonType: "object",
      required: ["exceptionId", "migrationVersion", "payoutId", "reason", "createdAt"],
      properties: {
        exceptionId: { bsonType: "string", minLength: 1 },
        migrationVersion: { bsonType: "int" },
        payoutId: { bsonType: "string", minLength: 1 },
        milestoneIndex: { bsonType: ["int", "long", "null"] },
        reason: { bsonType: "string", minLength: 1 },
        rawValue: {},
        createdAt: { bsonType: "date" },
      },
    },
  },

  payouts: {
    $jsonSchema: {
      bsonType: "object",
      required: ["payoutId", "escrowId", "recipient", "amount", "status", "createdAt", "updatedAt"],
      properties: {
        payoutId: { bsonType: "string", minLength: 1 },
        escrowId: { bsonType: "string", minLength: 1 },
        recipient: { bsonType: "string", minLength: 1 },
        amount: { bsonType: "string" },
        asset: { bsonType: ["string", "null"] },
        status: { enum: ["pending", "claimed"] },
        chainTxHash: { bsonType: ["string", "null"] },
        createdAt: { bsonType: "date" },
        updatedAt: { bsonType: "date" },
      },
    },
  },
});

export const EDITABLE_MATERIAL_FIELDS = Object.freeze([
  "title",
  "description",
  "price",
  "usageRights",
  "visibility",
  "thumbnailUrl",
  "category",
  "subject",
  "level",
]);

export const IMMUTABLE_MATERIAL_FIELDS = Object.freeze([
  "userAddress",
  "creator",
  "tokenId",
  "txHash",
  "chainId",
  "storageKey",
  "fileUrl",
  "metadataUrl",
  "createdAt",
]);

export function applyTimestamps(doc, now = new Date()) {
  return {
    ...doc,
    createdAt: doc.createdAt || now,
    updatedAt: now,
  };
}

export function buildMaterialHistoryEntry({
  materialId,
  previousDoc = {},
  update = {},
  updatedBy = null,
  changeReason = null,
  source = "system",
}) {
  const changedFields = Object.keys(update).filter((field) =>
    EDITABLE_MATERIAL_FIELDS.includes(field),
  );
  const previousVersion = Number(previousDoc.version || 1);

  return applyTimestamps({
    materialId,
    previousVersion,
    version: previousVersion + 1,
    changedFields,
    before: Object.fromEntries(
      changedFields.map((field) => [field, previousDoc[field] ?? null]),
    ),
    after: Object.fromEntries(
      changedFields.map((field) => [field, update[field] ?? null]),
    ),
    updatedBy,
    changeReason,
    source,
  });
}
