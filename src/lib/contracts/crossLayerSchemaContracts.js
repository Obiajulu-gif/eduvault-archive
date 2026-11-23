/**
 * Cross-Layer Schema Contract Registry & Validators (#1191).
 *
 * Keeps schemas synchronized across:
 *   1. Soroban smart contracts (`soroban/contracts/shared-interface/src/lib.rs`)
 *   2. Next.js API routes (`src/app/api/**`)
 *   3. Frontend service clients (`src/services/**`)
 *
 * Covers normal, failure, retry/idempotency, and authorization paths, plus
 * backwards-compatible schema evolution checks.
 *
 * Runbook: docs/SCHEMA_CONTRACT_TESTING.md
 */

export const SCHEMA_CONTRACT_VERSION = '1.0.0';

/**
 * Sensitive fields that must NEVER appear in 401/403 authorization error
 * responses or unauthenticated public responses.
 */
export const FORBIDDEN_AUTH_ERROR_FIELDS = Object.freeze([
  'storageKey',
  'fileUrl',
  'signedXdr',
  'privateKey',
  'jwtSecret',
  'passwordHash',
]);

/**
 * Canonical Soroban contract ABI snapshot mirrored from
 * `soroban/contracts/shared-interface/src/lib.rs`.
 */
export const SOROBAN_SHARED_INTERFACE_CONTRACT = Object.freeze({
  enums: Object.freeze({
    MaterialStatus: Object.freeze({
      Active: 0,
      Paused: 1,
      Archived: 2,
    }),
    AssetKind: Object.freeze({
      Native: 0,
      Token: 1,
      CreatorToken: 2,
      InstitutionAsset: 3,
    }),
  }),
  decimals: Object.freeze({
    NATIVE_XLM_DECIMALS: 7,
    USDC_DECIMALS: 7,
  }),
  structs: Object.freeze({
    MaterialView: Object.freeze([
      'material_id',
      'creator',
      'paused',
      'status',
      'quotes',
      'payout_shares',
    ]),
  }),
  entitlementStatusFields: Object.freeze([
    'entitlement_active',
    'entitlement_revoked',
  ]),
  events: Object.freeze({
    MATERIAL_REGISTERED: Object.freeze({
      name: 'material.registered',
      topics: Object.freeze(['material', 'registered', 'material_id', 'creator']),
      fields: Object.freeze([
        'metadata_uri',
        'metadata_hash',
        'rights_hash',
        'status',
        'quotes',
        'payout_shares',
      ]),
    }),
    MATERIAL_SALE_TERMS_UPDATED: Object.freeze({
      name: 'material.sale_terms_updated',
      topics: Object.freeze(['material', 'sale_terms_updated', 'material_id', 'creator']),
      fields: Object.freeze(['status', 'quotes', 'payout_shares']),
    }),
    PURCHASE_COMPLETED: Object.freeze({
      name: 'purchase.completed',
      topics: Object.freeze(['purchase', 'completed', 'purchase_id', 'material_id', 'buyer']),
      fields: Object.freeze([
        'seller',
        'asset',
        'amount',
        'platform_fee',
        'seller_net_amount',
        'entitlement_active',
        'metadata_hash',
        'rights_hash',
        'sale_terms_version',
        'transaction_id',
      ]),
    }),
    PURCHASE_BULK_COMPLETED: Object.freeze({
      name: 'purchase.bulk_completed',
      topics: Object.freeze(['purchase', 'bulk_completed', 'purchaser', 'material_id']),
      fields: Object.freeze(['recipient_count', 'unit_price', 'total_paid', 'asset']),
    }),
    PURCHASE_REFUNDED: Object.freeze({
      name: 'purchase.refunded',
      topics: Object.freeze(['purchase', 'refunded', 'purchase_id', 'material_id', 'buyer']),
      fields: Object.freeze(['asset', 'refund_amount', 'entitlement_revoked']),
    }),
  }),
});

/**
 * Shared error & problem-details response contract used across API routes and
 * consumed by frontend clients.
 */
export const ERROR_RESPONSE_SCHEMA = Object.freeze({
  version: '1.0.0',
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string' },
    code: { type: 'string' },
    message: { type: 'string' },
    recovery: { type: 'string' },
    remedy: { type: 'string' },
    retryAfter: { type: 'number' },
    retryable: { type: 'boolean' },
  },
});

/**
 * API endpoint schema contracts covering normal, failure, retry/idempotency,
 * and authorization responses.
 */
export const API_ENDPOINT_CONTRACTS = Object.freeze({
  'POST /api/purchase': Object.freeze({
    version: '1.0.0',
    method: 'POST',
    path: '/api/purchase',
    request: Object.freeze({
      type: 'object',
      required: ['materialId'],
      properties: {
        materialId: { type: 'string' },
        buyerAddress: { type: 'string' },
        transactionHash: { type: 'string' },
        signedXdr: { type: 'string' },
        amount: { type: 'number' },
        asset: { type: 'string' },
        quoteId: { type: 'string' },
        action: { type: 'string', enum: ['quote', 'purchase'] },
        idempotencyKey: { type: 'string' },
      },
    }),
    responses: Object.freeze({
      200: Object.freeze({
        description: 'Idempotent replay of an already-completed purchase',
        type: 'object',
        required: ['message', 'purchase', 'access'],
        properties: {
          message: { type: 'string' },
          purchase: { type: 'object', required: ['_id', 'materialId', 'buyerAddress', 'status'] },
          access: { type: 'object', required: ['hasAccess'] },
          transactionHash: { type: ['string', 'null'] },
        },
      }),
      201: Object.freeze({
        description: 'Confirmed purchase created',
        type: 'object',
        required: ['success', 'purchaseId', 'purchase', 'access'],
        properties: {
          success: { type: 'boolean' },
          purchaseId: { type: 'string' },
          purchase: {
            type: 'object',
            required: ['_id', 'materialId', 'buyerAddress', 'status'],
            properties: {
              _id: { type: 'string' },
              materialId: { type: 'string' },
              buyerAddress: { type: 'string' },
              status: { type: 'string', enum: ['confirmed', 'pending', 'completed'] },
              amount: { type: ['number', 'null'] },
              asset: { type: ['string', 'null'] },
            },
          },
          access: {
            type: 'object',
            required: ['hasAccess'],
            properties: { hasAccess: { type: 'boolean' } },
          },
        },
      }),
      202: Object.freeze({
        description: 'Pending purchase recorded awaiting settlement',
        type: 'object',
        required: ['purchase', 'access'],
        properties: {
          success: { type: 'boolean' },
          message: { type: 'string' },
          purchaseId: { type: 'string' },
          purchase: { type: 'object', required: ['materialId', 'buyerAddress', 'status'] },
          access: { type: 'object', required: ['hasAccess'] },
        },
      }),
      400: ERROR_RESPONSE_SCHEMA,
      401: ERROR_RESPONSE_SCHEMA,
      403: ERROR_RESPONSE_SCHEMA,
      409: ERROR_RESPONSE_SCHEMA,
      429: ERROR_RESPONSE_SCHEMA,
    }),
  }),

  'GET /api/purchase': Object.freeze({
    version: '1.0.0',
    method: 'GET',
    path: '/api/purchase',
    responses: Object.freeze({
      200: Object.freeze({
        type: 'array',
        items: {
          type: 'object',
          required: ['_id', 'materialId', 'buyerAddress', 'status'],
          properties: {
            _id: { type: 'string' },
            materialId: { type: 'string' },
            buyerAddress: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'confirmed', 'completed', 'refunded'] },
          },
        },
      }),
      401: ERROR_RESPONSE_SCHEMA,
    }),
  }),

  'GET /api/materials/access': Object.freeze({
    version: '1.0.0',
    method: 'GET',
    path: '/api/materials/access',
    responses: Object.freeze({
      200: Object.freeze({
        type: 'object',
        required: ['hasAccess'],
        properties: {
          hasAccess: { type: 'boolean' },
          status: { type: 'string' },
          materialId: { type: 'string' },
        },
      }),
      400: ERROR_RESPONSE_SCHEMA,
      401: ERROR_RESPONSE_SCHEMA,
      403: ERROR_RESPONSE_SCHEMA,
    }),
  }),

  'POST /api/materials/access': Object.freeze({
    version: '1.0.0',
    method: 'POST',
    path: '/api/materials/access',
    responses: Object.freeze({
      200: Object.freeze({
        type: 'object',
        required: ['hasAccess'],
        properties: { hasAccess: { type: 'boolean' } },
      }),
      401: ERROR_RESPONSE_SCHEMA,
      403: ERROR_RESPONSE_SCHEMA,
    }),
  }),

  'POST /api/entitlements/batch': Object.freeze({
    version: '1.0.0',
    method: 'POST',
    path: '/api/entitlements/batch',
    request: Object.freeze({
      type: 'object',
      required: ['materialIds'],
      properties: {
        materialIds: { type: 'array', items: { type: 'string' } },
      },
    }),
    responses: Object.freeze({
      200: Object.freeze({
        type: 'object',
        required: ['entitlements'],
        properties: { entitlements: { type: 'object' } },
      }),
      400: ERROR_RESPONSE_SCHEMA,
      401: ERROR_RESPONSE_SCHEMA,
    }),
  }),

  'POST /api/checkout/refund': Object.freeze({
    version: '1.0.0',
    method: 'POST',
    path: '/api/checkout/refund',
    request: Object.freeze({
      type: 'object',
      required: ['purchaseId'],
      properties: {
        purchaseId: { type: 'string' },
        reason: { type: 'string' },
        requestedAmount: { type: 'number' },
      },
    }),
    responses: Object.freeze({
      200: Object.freeze({
        description: 'Idempotent retry when refund claim already exists',
        type: 'object',
        required: ['message', 'refund'],
        properties: {
          message: { type: 'string' },
          refund: { type: 'object', required: ['purchaseId', 'status'] },
        },
      }),
      201: Object.freeze({
        description: 'New refund claim created',
        type: 'object',
        required: ['message', 'refund'],
        properties: {
          message: { type: 'string' },
          refund: { type: 'object', required: ['purchaseId', 'status'] },
        },
      }),
      400: ERROR_RESPONSE_SCHEMA,
      401: ERROR_RESPONSE_SCHEMA,
      403: ERROR_RESPONSE_SCHEMA,
      404: ERROR_RESPONSE_SCHEMA,
      429: ERROR_RESPONSE_SCHEMA,
    }),
  }),

  'GET /api/market-materials': Object.freeze({
    version: '1.0.0',
    method: 'GET',
    path: '/api/market-materials',
    responses: Object.freeze({
      200: Object.freeze({
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['_id', 'title', 'price'],
              properties: {
                _id: { type: 'string' },
                title: { type: 'string' },
                price: { type: 'number' },
                status: { type: 'string', enum: ['Active', 'Paused', 'Archived', 'active', 'paused', 'archived'] },
              },
            },
          },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
      }),
      400: ERROR_RESPONSE_SCHEMA,
    }),
  }),
});

/**
 * Frontend service-to-API bindings verified against actual files under
 * `src/services/`.
 */
export const FRONTEND_SERVICE_CONTRACTS = Object.freeze({
  purchaseService: Object.freeze({
    file: 'src/services/purchaseService.js',
    bindings: Object.freeze({
      createPurchase: 'POST /api/purchase',
      checkEntitlement: 'GET /api/materials/access',
      startAccessRequest: 'POST /api/materials/access',
      checkBatchEntitlements: 'POST /api/entitlements/batch',
      getPurchaseHistory: 'GET /api/purchase',
    }),
  }),
  materialService: Object.freeze({
    file: 'src/services/materialService.js',
    bindings: Object.freeze({
      getMarketplaceMaterials: 'GET /api/market-materials',
      getMaterialDetail: 'GET /api/market-materials',
      getTrendingMaterials: 'GET /api/market-materials',
    }),
  }),
});

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Deterministic runtime schema validator supporting type (single or union),
 * enum, required, nested object properties, and array items.
 */
export function validatePayloadAgainstSchema(value, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = valueType(value);
    if (!allowed.includes(actual)) {
      errors.push(`${path}: expected ${allowed.join('|')}, got ${actual}`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} is not in enum [${schema.enum.join(', ')}]`);
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const reqKey of schema.required || []) {
      if (!(reqKey in value) || value[reqKey] === undefined) {
        errors.push(`${path}.${reqKey}: required field is missing`);
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) {
        errors.push(...validatePayloadAgainstSchema(value[key], propSchema, `${path}.${key}`));
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, idx) => {
      errors.push(...validatePayloadAgainstSchema(item, schema.items, `${path}[${idx}]`));
    });
  }

  return errors;
}

/**
 * Parses `soroban/contracts/shared-interface/src/lib.rs` to extract live
 * enum discriminants, decimal constants, MaterialView fields, and event
 * schemas so any Rust <-> JS drift is caught automatically.
 */
export function parseSorobanSharedInterface(rustSource) {
  const parseEnum = (enumName) => {
    const match = rustSource.match(new RegExp(`pub\\s+enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\}`));
    if (!match) return null;
    const entries = {};
    for (const line of match[1].split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(\d+)\s*,?/);
      if (m) entries[m[1]] = Number(m[2]);
    }
    return entries;
  };

  const parseConstU32 = (constName) => {
    const match = rustSource.match(new RegExp(`pub\\s+const\\s+${constName}:\\s*u32\\s*=\\s*(\\d+)`));
    return match ? Number(match[1]) : null;
  };

  const parseStructFields = (structName) => {
    const match = rustSource.match(new RegExp(`pub\\s+struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\}`));
    if (!match) return null;
    const fields = [];
    for (const line of match[1].split('\n')) {
      const m = line.match(/^\s*pub\s+([a-z0-9_]+)\s*:/);
      if (m) fields.push(m[1]);
    }
    return fields;
  };

  const parseQuotedList = (block) => {
    const out = [];
    const re = /"([^"]+)"/g;
    let m;
    while ((m = re.exec(block)) !== null) {
      out.push(m[1]);
    }
    return out;
  };

  const events = {};
  const eventRegex =
    /pub\s+const\s+([A-Z0-9_]+):\s*EventSchema\s*=\s*EventSchema\s*\{([\s\S]*?)\};/g;
  let evMatch;
  while ((evMatch = eventRegex.exec(rustSource)) !== null) {
    const constName = evMatch[1];
    const body = evMatch[2];
    const nameMatch = body.match(/name:\s*"([^"]+)"/);
    const topicsMatch = body.match(/topics:\s*&\[([\s\S]*?)\]/);
    const fieldsMatch = body.match(/fields:\s*&\[([\s\S]*?)\]/);
    events[constName] = {
      name: nameMatch ? nameMatch[1] : null,
      topics: topicsMatch ? parseQuotedList(topicsMatch[1]) : [],
      fields: fieldsMatch ? parseQuotedList(fieldsMatch[1]) : [],
    };
  }

  const entitlementMatch = rustSource.match(
    /pub\s+const\s+ENTITLEMENT_STATUS_FIELDS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/
  );

  return {
    enums: {
      MaterialStatus: parseEnum('MaterialStatus'),
      AssetKind: parseEnum('AssetKind'),
    },
    decimals: {
      NATIVE_XLM_DECIMALS: parseConstU32('NATIVE_XLM_DECIMALS'),
      USDC_DECIMALS: parseConstU32('USDC_DECIMALS'),
    },
    structs: {
      MaterialView: parseStructFields('MaterialView'),
    },
    entitlementStatusFields: entitlementMatch ? parseQuotedList(entitlementMatch[1]) : [],
    events,
  };
}

/**
 * Extracts API route paths referenced in a frontend service module.
 */
export function extractFrontendServicePaths(serviceSource) {
  const paths = new Set();
  const re = /apiClient\(\s*['"`](\/api\/[^'"`?$]+)/g;
  let m;
  while ((m = re.exec(serviceSource)) !== null) {
    paths.add(m[1]);
  }
  return [...paths];
}

/**
 * Verifies that a schema evolution from `previousSchema` to `nextSchema` is
 * backwards compatible unless `allowBreaking` (major version bump) is set.
 *
 * Rules:
 *   - Adding new optional properties is backwards compatible.
 *   - Removing an existing required field is breaking.
 *   - Adding a new required field is breaking for existing producers.
 *   - Narrowing an enum or changing an existing property's type is breaking.
 */
export function validateSchemaEvolution(previousSchema, nextSchema, { allowBreaking = false } = {}) {
  const breakingChanges = [];

  const prevRequired = new Set(previousSchema.required || []);
  const nextRequired = new Set(nextSchema.required || []);

  for (const field of prevRequired) {
    if (!nextRequired.has(field)) {
      breakingChanges.push(`Removed required field '${field}'`);
    }
  }
  for (const field of nextRequired) {
    if (!prevRequired.has(field)) {
      breakingChanges.push(`Added new required field '${field}' (must be optional for backwards compatibility)`);
    }
  }

  const prevProps = previousSchema.properties || {};
  const nextProps = nextSchema.properties || {};
  for (const [key, prevProp] of Object.entries(prevProps)) {
    const nextProp = nextProps[key];
    if (!nextProp) {
      breakingChanges.push(`Removed property '${key}'`);
      continue;
    }
    const prevTypes = Array.isArray(prevProp.type) ? prevProp.type : [prevProp.type];
    const nextTypes = Array.isArray(nextProp.type) ? nextProp.type : [nextProp.type];
    for (const t of prevTypes) {
      if (t && !nextTypes.includes(t)) {
        breakingChanges.push(`Changed type of '${key}' (removed '${t}')`);
      }
    }
    if (Array.isArray(prevProp.enum) && Array.isArray(nextProp.enum)) {
      for (const val of prevProp.enum) {
        if (!nextProp.enum.includes(val)) {
          breakingChanges.push(`Removed enum value '${val}' from '${key}'`);
        }
      }
    }
  }

  return {
    compatible: breakingChanges.length === 0 || allowBreaking,
    breakingChanges,
  };
}

/**
 * Validates that an authorization denial response (401 or 403) adheres to the
 * error contract and does not leak sensitive fields.
 */
export function verifyAuthorizationErrorContract(statusCode, payload) {
  const errors = [];
  if (statusCode !== 401 && statusCode !== 403) {
    errors.push(`Expected 401 or 403 for authorization denial, got ${statusCode}`);
  }
  errors.push(...validatePayloadAgainstSchema(payload, ERROR_RESPONSE_SCHEMA));

  const scanForLeaks = (node, path = '$') => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_AUTH_ERROR_FIELDS.includes(k)) {
        errors.push(`${path}.${k}: sensitive field leaked in ${statusCode} authorization response`);
      }
      if (v && typeof v === 'object') {
        scanForLeaks(v, `${path}.${k}`);
      }
    }
  };
  scanForLeaks(payload);

  return { valid: errors.length === 0, errors };
}
