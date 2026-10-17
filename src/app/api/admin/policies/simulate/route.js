export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { requireAdmin } from '@/lib/api/auth';
import {
  simulatePolicyChange,
  assertPolicyCommitAllowed,
  POLICY_TYPES,
  PolicySimulationError,
} from '@/lib/policies/policySimulator';
import { COLLECTIONS } from '@/lib/backend/schemaContracts';

/**
 * POST /api/admin/policies/simulate
 *
 * Runs a pre-flight simulation preview of a proposed high-impact or irreversible policy change.
 * Maintainers can inspect affected records/users, expected side effects, and rollback constraints.
 *
 * Request Body:
 * {
 *   policyType: "MARKETPLACE_FEE" | "ENTITLEMENT_REVOCATION" | "CREATOR_PAYOUT_CAP" | "CONTENT_QUARANTINE" | "ARCHIVE_RETENTION",
 *   proposedPolicy: object,
 *   currentPolicy?: object,
 *   commit?: boolean, // If true, attempts to validate commit constraints
 *   confirmIrreversibleDataLoss?: boolean,
 *   confirmFinancialImpact?: boolean,
 *   confirmIrreversibleRevocation?: boolean,
 *   confirmPendingPayoutDelay?: boolean,
 *   secondaryApprover?: string,
 *   simulationFingerprint?: string
 * }
 */
export async function POST(request) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const {
      policyType,
      proposedPolicy,
      currentPolicy = {},
      commit = false,
      ...commitParams
    } = body;

    if (!policyType || !proposedPolicy) {
      return NextResponse.json(
        { error: 'policyType and proposedPolicy are required.' },
        { status: 400 }
      );
    }

    // Query read-only live dataset sample for accurate simulation
    let dataSource = {};
    try {
      const db = await getDb();
      const [materials, purchases, payouts, users] = await Promise.all([
        db.collection(COLLECTIONS.materials).find({}).limit(500).toArray(),
        db.collection(COLLECTIONS.purchases).find({}).sort({ createdAt: -1 }).limit(500).toArray(),
        db.collection(COLLECTIONS.payouts || 'payouts').find({ status: 'pending' }).limit(200).toArray(),
        db.collection(COLLECTIONS.users).find({}).limit(200).toArray(),
      ]);

      dataSource = {
        materials,
        purchases,
        payouts,
        users,
      };
    } catch {
      // Fall back to empty sample if database query fails or in detached mode
      dataSource = {};
    }

    const preview = await simulatePolicyChange({
      policyType,
      proposedPolicy,
      currentPolicy,
      dataSource,
      actor: admin,
    });

    // If commit was requested, check gatekeeper preconditions
    if (commit) {
      assertPolicyCommitAllowed(preview, commitParams);
      return NextResponse.json({
        success: true,
        committed: true,
        message: 'Policy change validated and authorized for commit.',
        preview,
      });
    }

    return NextResponse.json({
      success: true,
      preview: true,
      simulation: preview,
    });
  } catch (error) {
    if (error instanceof PolicySimulationError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          details: error.details,
        },
        { status: error.status || 400 }
      );
    }

    console.error('POST /api/admin/policies/simulate error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
