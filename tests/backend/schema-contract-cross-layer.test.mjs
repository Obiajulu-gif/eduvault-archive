import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  API_ENDPOINT_CONTRACTS,
  extractFrontendServicePaths,
  FRONTEND_SERVICE_CONTRACTS,
  parseSorobanSharedInterface,
  SOROBAN_SHARED_INTERFACE_CONTRACT,
  validatePayloadAgainstSchema,
  validateSchemaEvolution,
  verifyAuthorizationErrorContract,
} from '../../src/lib/contracts/crossLayerSchemaContracts.js';

const ROOT = resolve(import.meta.dirname, '../..');

test('contract layer: Soroban shared-interface Rust ABI matches JS schema contract snapshot', () => {
  const rustSource = readFileSync(
    resolve(ROOT, 'soroban/contracts/shared-interface/src/lib.rs'),
    'utf8'
  );
  const parsed = parseSorobanSharedInterface(rustSource);

  // Enum discriminants must never silently shift or reorder
  assert.deepEqual(parsed.enums, SOROBAN_SHARED_INTERFACE_CONTRACT.enums);

  // Decimal precision constants must stay aligned across contract and UI/API
  assert.deepEqual(parsed.decimals, SOROBAN_SHARED_INTERFACE_CONTRACT.decimals);

  // Cross-contract MaterialView struct field list
  assert.deepEqual(parsed.structs.MaterialView, SOROBAN_SHARED_INTERFACE_CONTRACT.structs.MaterialView);

  // Entitlement status fields on purchase/refund events
  assert.deepEqual(
    parsed.entitlementStatusFields,
    SOROBAN_SHARED_INTERFACE_CONTRACT.entitlementStatusFields
  );

  // All canonical on-chain event schemas (topics + payload field order)
  for (const [eventKey, expectedEvent] of Object.entries(SOROBAN_SHARED_INTERFACE_CONTRACT.events)) {
    assert.ok(parsed.events[eventKey], `Missing event ${eventKey} in Soroban shared-interface`);
    assert.deepEqual(parsed.events[eventKey], expectedEvent);
  }
});

test('frontend <-> API layer: every frontend service binding targets a registered API contract', () => {
  const registeredPaths = new Set(
    Object.values(API_ENDPOINT_CONTRACTS).map((contract) => contract.path)
  );

  for (const [serviceName, spec] of Object.entries(FRONTEND_SERVICE_CONTRACTS)) {
    const source = readFileSync(resolve(ROOT, spec.file), 'utf8');
    const actualPaths = extractFrontendServicePaths(source);

    for (const [methodName, endpointKey] of Object.entries(spec.bindings)) {
      const endpointContract = API_ENDPOINT_CONTRACTS[endpointKey];
      assert.ok(
        endpointContract,
        `${serviceName}.${methodName} references unregistered contract '${endpointKey}'`
      );
      assert.ok(
        actualPaths.includes(endpointContract.path),
        `${serviceName}.${methodName} expected ${spec.file} to call '${endpointContract.path}'`
      );
      assert.ok(registeredPaths.has(endpointContract.path));
    }
  }
});

test('normal paths: valid request and response payloads pass across purchase, refund, access, and catalog APIs', () => {
  // POST /api/purchase request + 201 confirmed response
  const purchaseContract = API_ENDPOINT_CONTRACTS['POST /api/purchase'];
  assert.deepEqual(
    validatePayloadAgainstSchema(
      {
        materialId: 'mat-101',
        buyerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        transactionHash: 'tx_abc123',
        amount: 10,
        asset: 'USDC',
        quoteId: 'quote-1',
        idempotencyKey: 'idem-1',
      },
      purchaseContract.request
    ),
    []
  );

  assert.deepEqual(
    validatePayloadAgainstSchema(
      {
        success: true,
        purchaseId: 'pur-1',
        purchase: {
          _id: 'pur-1',
          materialId: 'mat-101',
          buyerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          status: 'confirmed',
          amount: 10,
          asset: 'USDC',
        },
        access: { hasAccess: true },
      },
      purchaseContract.responses[201]
    ),
    []
  );

  // POST /api/checkout/refund request + 201 response
  const refundContract = API_ENDPOINT_CONTRACTS['POST /api/checkout/refund'];
  assert.deepEqual(
    validatePayloadAgainstSchema(
      { purchaseId: 'pur-1', reason: 'Corrupted file download' },
      refundContract.request
    ),
    []
  );
  assert.deepEqual(
    validatePayloadAgainstSchema(
      {
        message: 'Refund requested',
        refund: { purchaseId: 'pur-1', status: 'requested' },
      },
      refundContract.responses[201]
    ),
    []
  );

  // GET /api/materials/access 200 response
  assert.deepEqual(
    validatePayloadAgainstSchema(
      { hasAccess: true, status: 'confirmed', materialId: 'mat-101' },
      API_ENDPOINT_CONTRACTS['GET /api/materials/access'].responses[200]
    ),
    []
  );

  // GET /api/market-materials 200 response aligned with Soroban MaterialStatus values
  assert.deepEqual(
    validatePayloadAgainstSchema(
      {
        items: [
          { _id: 'mat-101', title: 'Linear Algebra Notes', price: 12.5, status: 'Active' },
        ],
        nextCursor: null,
        hasMore: false,
      },
      API_ENDPOINT_CONTRACTS['GET /api/market-materials'].responses[200]
    ),
    []
  );
});

test('failure paths: rejects missing required fields, wrong types, invalid enums, and malformed errors', () => {
  const purchaseContract = API_ENDPOINT_CONTRACTS['POST /api/purchase'];

  // Missing required materialId
  const missingReq = validatePayloadAgainstSchema({ amount: 10 }, purchaseContract.request);
  assert.ok(missingReq.some((e) => e.includes('materialId')));

  // Wrong type for amount (string instead of number)
  const wrongType = validatePayloadAgainstSchema(
    { materialId: 'mat-1', amount: '10' },
    purchaseContract.request
  );
  assert.ok(wrongType.some((e) => e.includes('amount')));

  // Invalid status enum on purchase response
  const badEnum = validatePayloadAgainstSchema(
    {
      success: true,
      purchaseId: 'pur-1',
      purchase: {
        _id: 'pur-1',
        materialId: 'mat-1',
        buyerAddress: 'GBUYER',
        status: 'unknown_state',
      },
      access: { hasAccess: true },
    },
    purchaseContract.responses[201]
  );
  assert.ok(badEnum.some((e) => e.includes('status')));

  // Malformed 400 error missing `error` field
  const badErr = validatePayloadAgainstSchema({ code: 'VALIDATION_FIELD' }, purchaseContract.responses[400]);
  assert.ok(badErr.some((e) => e.includes('error')));
});

test('retry & idempotency paths: validates 200 replay, 202 pending, and 429 retryable responses', () => {
  const purchaseContract = API_ENDPOINT_CONTRACTS['POST /api/purchase'];
  const refundContract = API_ENDPOINT_CONTRACTS['POST /api/checkout/refund'];

  // 200 idempotent replay of already-completed purchase
  assert.deepEqual(
    validatePayloadAgainstSchema(
      {
        message: 'Already purchased',
        purchase: { _id: 'pur-1', materialId: 'mat-1', buyerAddress: 'GBUYER', status: 'confirmed' },
        access: { hasAccess: true },
        transactionHash: 'tx_abc123',
      },
      purchaseContract.responses[200]
    ),
    []
  );

  // 202 pending purchase awaiting settlement
  assert.deepEqual(
    validatePayloadAgainstSchema(
      {
        message: 'Payment pending',
        purchase: { materialId: 'mat-1', buyerAddress: 'GBUYER', status: 'pending' },
        access: { hasAccess: false },
      },
      purchaseContract.responses[202]
    ),
    []
  );

  // 200 idempotent replay of existing refund claim
  assert.deepEqual(
    validatePayloadAgainstSchema(
      {
        message: 'Refund claim already exists for this purchase',
        refund: { purchaseId: 'pur-1', status: 'requested' },
      },
      refundContract.responses[200]
    ),
    []
  );

  // 429 rate-limited retryable error with Retry-After seconds
  assert.deepEqual(
    validatePayloadAgainstSchema(
      {
        error: 'Wallet rate limit exceeded for purchase.',
        code: 'CHECKOUT_RATE_LIMIT_EXCEEDED',
        retryAfter: 45,
        remedy: 'Retry after 45 seconds with the same Idempotency-Key.',
      },
      purchaseContract.responses[429]
    ),
    []
  );
});

test('authorization paths: validates 401/403 contracts and rejects sensitive field leakage', () => {
  // Clean 401 unauthenticated response
  const ok401 = verifyAuthorizationErrorContract(401, {
    error: 'Unauthorized',
    code: 'AUTH_UNAUTHENTICATED',
  });
  assert.equal(ok401.valid, true);

  // Clean 403 forbidden response
  const ok403 = verifyAuthorizationErrorContract(403, {
    error: 'Claimed buyer wallet does not match the authenticated session wallet.',
    code: 'CHECKOUT_WALLET_MISMATCH',
  });
  assert.equal(ok403.valid, true);

  // Leaking storageKey or signedXdr in a 403 response fails the contract test
  const leaked403 = verifyAuthorizationErrorContract(403, {
    error: 'Forbidden',
    details: { storageKey: 'ipfs://secret-key', signedXdr: 'AAAA...' },
  });
  assert.equal(leaked403.valid, false);
  assert.ok(leaked403.errors.some((e) => e.includes('storageKey')));
  assert.ok(leaked403.errors.some((e) => e.includes('signedXdr')));
});

test('schema evolution: permits additive optional fields and blocks breaking removals or enum narrowing', () => {
  const v1 = {
    required: ['purchaseId', 'status'],
    properties: {
      purchaseId: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'confirmed'] },
    },
  };

  // Additive optional field + widened enum -> backwards compatible
  const v1Minor = {
    required: ['purchaseId', 'status'],
    properties: {
      purchaseId: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'confirmed', 'refunded'] },
      receiptId: { type: 'string' },
    },
  };
  const additiveResult = validateSchemaEvolution(v1, v1Minor);
  assert.equal(additiveResult.compatible, true);
  assert.deepEqual(additiveResult.breakingChanges, []);

  // Breaking: removing required field & narrowing enum
  const v2Breaking = {
    required: ['purchaseId', 'newMandatoryField'],
    properties: {
      purchaseId: { type: 'number' },
      status: { type: 'string', enum: ['confirmed'] },
      newMandatoryField: { type: 'string' },
    },
  };
  const breakingResult = validateSchemaEvolution(v1, v2Breaking);
  assert.equal(breakingResult.compatible, false);
  assert.ok(breakingResult.breakingChanges.some((c) => c.includes("Removed required field 'status'")));
  assert.ok(breakingResult.breakingChanges.some((c) => c.includes("Added new required field 'newMandatoryField'")));
  assert.ok(breakingResult.breakingChanges.some((c) => c.includes("Changed type of 'purchaseId'")));
  assert.ok(breakingResult.breakingChanges.some((c) => c.includes("Removed enum value 'pending'")));
});
