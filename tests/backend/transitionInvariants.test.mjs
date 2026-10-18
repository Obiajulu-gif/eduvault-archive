import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkBalanceTransition,
  checkSettlementConservation,
  checkOwnershipTransition,
  checkEntitlementTransition,
  executeWithInvariantProtection,
  INVARIANT_ERROR_CODES,
  ENTITLEMENT_STATUS,
  TransitionInvariantError,
} from '../../src/lib/transitions/invariantChecker.js';

describe('Transition Invariant Checker (#989)', () => {
  describe('Balance Invariants', () => {
    it('accepts valid balance credit transition', () => {
      const res = checkBalanceTransition({
        fromBalance: 100,
        toBalance: 150,
        delta: 50,
        currency: 'XLM',
        actor: 'GBUYER123',
      });
      assert.equal(res.valid, true);
      assert.equal(res.invariant, 'BALANCE_CONSERVED');
    });

    it('accepts valid balance debit transition with authorized actor', () => {
      const res = checkBalanceTransition({
        fromBalance: 100,
        toBalance: 40,
        delta: -60,
        currency: 'USDC',
        actor: 'GACCOUNT123',
        authorizedAccount: 'GACCOUNT123',
      });
      assert.equal(res.valid, true);
    });

    it('rejects balance transition when arithmetic mismatch occurs', () => {
      assert.throws(
        () =>
          checkBalanceTransition({
            fromBalance: 100,
            toBalance: 140, // Should be 150
            delta: 50,
            currency: 'XLM',
            actor: 'GUSER',
          }),
        (err) => err.code === INVARIANT_ERROR_CODES.BALANCE_ARITHMETIC_MISMATCH
      );
    });

    it('rejects balance transition resulting in negative balance', () => {
      assert.throws(
        () =>
          checkBalanceTransition({
            fromBalance: 50,
            toBalance: -10,
            delta: -60,
            currency: 'XLM',
            actor: 'GUSER',
            authorizedAccount: 'GUSER',
          }),
        (err) => err.code === INVARIANT_ERROR_CODES.BALANCE_NEGATIVE
      );
    });

    it('allows negative balance when allowNegative is explicitly set', () => {
      const res = checkBalanceTransition({
        fromBalance: 10,
        toBalance: -10,
        delta: -20,
        currency: 'XLM',
        actor: 'GUSER',
        authorizedAccount: 'GUSER',
        allowNegative: true,
      });
      assert.equal(res.valid, true);
    });

    it('rejects unauthorized actor attempting account debit', () => {
      assert.throws(
        () =>
          checkBalanceTransition({
            fromBalance: 100,
            toBalance: 50,
            delta: -50,
            currency: 'USDC',
            actor: 'GATTACKER',
            authorizedAccount: 'GVICTIM',
          }),
        (err) => err.code === INVARIANT_ERROR_CODES.UNAUTHORIZED_ACTOR
      );
    });

    it('rejects cross-currency mismatched transition', () => {
      assert.throws(
        () =>
          checkBalanceTransition({
            fromBalance: 100,
            toBalance: 150,
            delta: 50,
            currency: 'XLM',
            targetCurrency: 'USDC',
            actor: 'GUSER',
          }),
        (err) => err.code === INVARIANT_ERROR_CODES.BALANCE_CURRENCY_MISMATCH
      );
    });

    it('validates settlement balance conservation across multi-party payments', () => {
      const res = checkSettlementConservation({
        debits: [{ account: 'GBUYER', amount: 100 }],
        credits: [
          { account: 'GCREATOR', amount: 90 },
          { account: 'GAFFILIATE', amount: 5 },
        ],
        platformFee: 5,
      });
      assert.equal(res.valid, true);
      assert.equal(res.totalDebits, 100);
      assert.equal(res.totalCredits, 95);
      assert.equal(res.fee, 5);
    });

    it('rejects settlement when total debits do not equal credits plus platform fee', () => {
      assert.throws(
        () =>
          checkSettlementConservation({
            debits: [{ account: 'GBUYER', amount: 100 }],
            credits: [{ account: 'GCREATOR', amount: 80 }],
            platformFee: 10, // 80 + 10 = 90 != 100
          }),
        (err) => err.code === INVARIANT_ERROR_CODES.BALANCE_CONSERVATION_VIOLATION
      );
    });
  });

  describe('Ownership Invariants', () => {
    it('accepts valid ownership transfer from current owner', () => {
      const res = checkOwnershipTransition({
        resourceId: 'mat-101',
        currentOwner: 'GCREATOR_A',
        proposedOwner: 'GCREATOR_B',
        actor: 'GCREATOR_A',
      });
      assert.equal(res.valid, true);
      assert.equal(res.invariant, 'OWNERSHIP_TRANSITION_VALID');
    });

    it('accepts valid ownership transfer by admin', () => {
      const res = checkOwnershipTransition({
        resourceId: 'mat-101',
        currentOwner: 'GCREATOR_A',
        proposedOwner: 'GCREATOR_B',
        actor: 'GADMIN',
        isAdmin: true,
      });
      assert.equal(res.valid, true);
    });

    it('rejects transfer to the same owner', () => {
      assert.throws(
        () =>
          checkOwnershipTransition({
            resourceId: 'mat-101',
            currentOwner: 'GCREATOR_A',
            proposedOwner: 'GCREATOR_A',
            actor: 'GCREATOR_A',
          }),
        (err) => err.code === INVARIANT_ERROR_CODES.OWNERSHIP_SAME_OWNER
      );
    });

    it('rejects transfer with empty or invalid target address', () => {
      assert.throws(
        () =>
          checkOwnershipTransition({
            resourceId: 'mat-101',
            currentOwner: 'GCREATOR_A',
            proposedOwner: '',
            actor: 'GCREATOR_A',
          }),
        (err) => err.code === INVARIANT_ERROR_CODES.OWNERSHIP_INVALID_TARGET
      );
    });

    it('rejects unauthorized actor transfer attempt', () => {
      assert.throws(
        () =>
          checkOwnershipTransition({
            resourceId: 'mat-101',
            currentOwner: 'GCREATOR_A',
            proposedOwner: 'GCREATOR_B',
            actor: 'GSTRANGER',
            isAdmin: false,
          }),
        (err) => err.code === INVARIANT_ERROR_CODES.OWNERSHIP_UNAUTHORIZED
      );
    });

    it('rejects transfer of archived or quarantined resource', () => {
      assert.throws(
        () =>
          checkOwnershipTransition({
            resourceId: 'mat-101',
            currentOwner: 'GCREATOR_A',
            proposedOwner: 'GCREATOR_B',
            actor: 'GCREATOR_A',
            resourceStatus: 'archived',
          }),
        (err) => err.code === INVARIANT_ERROR_CODES.OWNERSHIP_INVALID_STATE
      );
    });
  });

  describe('Entitlement Invariants', () => {
    it('accepts valid NONE -> ACTIVE transition with purchaseId proof', () => {
      const res = checkEntitlementTransition({
        materialId: 'mat-course-1',
        buyerAddress: 'GBUYER123',
        fromStatus: ENTITLEMENT_STATUS.NONE,
        toStatus: ENTITLEMENT_STATUS.ACTIVE,
        purchaseId: 'pur-999',
      });
      assert.equal(res.valid, true);
      assert.equal(res.toStatus, 'ACTIVE');
    });

    it('accepts valid PENDING -> ACTIVE transition with txHash proof', () => {
      const res = checkEntitlementTransition({
        materialId: 'mat-course-1',
        buyerAddress: 'GBUYER123',
        fromStatus: ENTITLEMENT_STATUS.PENDING,
        toStatus: ENTITLEMENT_STATUS.ACTIVE,
        txHash: '0xabc123...',
      });
      assert.equal(res.valid, true);
    });

    it('accepts ACTIVE -> REVOKED transition when valid reason is provided', () => {
      const res = checkEntitlementTransition({
        materialId: 'mat-course-1',
        buyerAddress: 'GBUYER123',
        fromStatus: ENTITLEMENT_STATUS.ACTIVE,
        toStatus: ENTITLEMENT_STATUS.REVOKED,
        reason: 'Payment chargeback confirmed',
      });
      assert.equal(res.valid, true);
    });

    it('rejects activation without purchaseId or txHash proof', () => {
      assert.throws(
        () =>
          checkEntitlementTransition({
            materialId: 'mat-course-1',
            buyerAddress: 'GBUYER123',
            fromStatus: ENTITLEMENT_STATUS.NONE,
            toStatus: ENTITLEMENT_STATUS.ACTIVE,
          }),
        (err) => err.code === INVARIANT_ERROR_CODES.ENTITLEMENT_MISSING_PROOF
      );
    });

    it('rejects illegal transition jump (e.g. NONE -> REFUNDED)', () => {
      assert.throws(
        () =>
          checkEntitlementTransition({
            materialId: 'mat-course-1',
            buyerAddress: 'GBUYER123',
            fromStatus: ENTITLEMENT_STATUS.NONE,
            toStatus: ENTITLEMENT_STATUS.REFUNDED,
          }),
        (err) => err.code === INVARIANT_ERROR_CODES.ENTITLEMENT_INVALID_TRANSITION
      );
    });

    it('rejects entitlement time inversion (validFrom > validUntil)', () => {
      assert.throws(
        () =>
          checkEntitlementTransition({
            materialId: 'mat-course-1',
            buyerAddress: 'GBUYER123',
            fromStatus: ENTITLEMENT_STATUS.PENDING,
            toStatus: ENTITLEMENT_STATUS.ACTIVE,
            purchaseId: 'pur-1',
            validFrom: '2026-12-01T00:00:00Z',
            validUntil: '2026-01-01T00:00:00Z',
          }),
        (err) => err.code === INVARIANT_ERROR_CODES.ENTITLEMENT_TIME_INVERSION
      );
    });
  });

  describe('executeWithInvariantProtection & Rollback', () => {
    it('executes mutation when invariants pass and provides rollback state', async () => {
      let balance = 100;
      const res = await executeWithInvariantProtection({
        type: 'balance',
        transitionParams: {
          fromBalance: 100,
          toBalance: 140,
          delta: 40,
          currency: 'XLM',
          actor: 'GBUYER',
        },
        executeFn: async () => {
          balance = 140;
          return { newBalance: balance };
        },
      });

      assert.equal(res.success, true);
      assert.equal(res.result.newBalance, 140);
      assert.deepEqual(res.rollbackState, {
        type: 'balance',
        account: null,
        rollbackBalance: 100,
        currency: 'XLM',
      });
    });

    it('attaches rollback state when execution throws error mid-mutation', async () => {
      await assert.rejects(
        async () => {
          await executeWithInvariantProtection({
            type: 'entitlement',
            transitionParams: {
              materialId: 'mat-fail',
              buyerAddress: 'GBUYER',
              fromStatus: ENTITLEMENT_STATUS.ACTIVE,
              toStatus: ENTITLEMENT_STATUS.REVOKED,
              reason: 'Policy violation',
            },
            executeFn: async () => {
              throw new Error('Database write failed');
            },
          });
        },
        (err) => {
          assert.equal(err.message, 'Database write failed');
          assert.equal(err.rollbackState.type, 'entitlement');
          assert.equal(err.rollbackState.rollbackStatus, 'ACTIVE');
          return true;
        }
      );
    });
  });
});
