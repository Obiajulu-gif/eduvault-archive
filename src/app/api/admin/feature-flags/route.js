export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin API — feature flag runtime overrides (#1018)
 *
 * GET  /api/admin/feature-flags
 *   List all flags with their resolved value (DB override → env → default).
 *   Response: { flags: Array<FlagStatus> }
 *
 * POST /api/admin/feature-flags
 *   Set or clear a runtime override.
 *   Body: { key: string, enabled: boolean, reason?: string }
 *         or { key: string, clear: true, reason?: string }
 *   Response: { flag: FlagStatus }
 *
 * Authorization
 * ─────────────
 * Requires admin:access permission (role==="admin" in DB, or a valid
 * ADMIN_API_TOKEN service token via x-admin-token header).
 *
 * Normal path  — flag enabled/disabled successfully, audit logged.
 * Failure path — DB write failure returns 503; auth failure returns 401/403.
 * Retry path   — POST is idempotent: re-posting the same state is a no-op.
 * Auth path    — non-admin callers always get 403; service token accepted for
 *               CI/automation pipelines.
 *
 * Operational edge cases
 * ──────────────────────
 * • DB unavailable on GET: responds with env/default values and
 *   source:"default" for each flag so operators can still see the env state.
 * • DB unavailable on POST: returns 503 with retryable:true. The env var
 *   remains the effective value; retry once the DB recovers.
 * • Override for unknown key: 400 with descriptive error.
 * • Emergency disable flow: POST { key, enabled: false, reason: "..." }.
 *   Takes effect on the next request to any route using withFeatureGuard or
 *   resolveFeatureFlag — no restart required.
 * • Recovery/rollback: POST { key, clear: true } to remove the override and
 *   revert to the env-var value. Or POST { key, enabled: true } to re-enable.
 */

import { NextResponse }    from 'next/server';
import { getDb }           from '@/lib/mongodb';
import { requirePermission } from '@/lib/api/auth';
import { withApiHardening }  from '@/lib/api/hardening';
import { auditLog }          from '@/lib/api/audit';
import {
  FEATURE_FLAG_REGISTRY,
  listFeatureFlagsResolved,
  setFeatureFlagOverride,
  clearFeatureFlagOverride,
  resolveFeatureFlag,
} from '@/lib/featureFlags';

// ─── GET — list all flags ─────────────────────────────────────────────────────

export async function GET(request) {
  return withApiHardening(
    request,
    { route: 'admin-feature-flags-get', rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const auth = await requirePermission(request, 'admin:access', { allowService: true });
      if (!auth.ok) {
        auditLog({ event: 'auth_failed', route: 'admin/feature-flags', method: 'GET', status: auth.status });
        return NextResponse.json({ error: 'Unauthorized' }, { status: auth.status });
      }

      try {
        const db = await getDb();
        const flags = await listFeatureFlagsResolved(db);
        return NextResponse.json({ flags });
      } catch (err) {
        // DB unavailable — return env/default values so the operator can still
        // see what the effective configuration is.
        const flags = Object.values(FEATURE_FLAG_REGISTRY).map((def) => ({
          ...def,
          enabled: (() => {
            const raw = process.env[`FEATURE_FLAG_${def.key}`];
            if (!raw || raw.trim() === '') return def.defaultValue;
            const n = raw.trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(n)) return true;
            if (['false', '0', 'no', 'off'].includes(n)) return false;
            return def.defaultValue;
          })(),
          source: process.env[`FEATURE_FLAG_${def.key}`] ? 'env' : 'default',
          dbUnavailable: true,
        }));
        auditLog({ event: 'feature_flags_db_unavailable', route: 'admin/feature-flags', method: 'GET', status: 200, reason: err?.message });
        return NextResponse.json({ flags, warning: 'DB unavailable; showing env/default values only.' });
      }
    },
  );
}

// ─── POST — set or clear an override ─────────────────────────────────────────

export async function POST(request) {
  return withApiHardening(
    request,
    { route: 'admin-feature-flags-post', rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      const auth = await requirePermission(request, 'admin:access', { allowService: true });
      if (!auth.ok) {
        auditLog({ event: 'auth_failed', route: 'admin/feature-flags', method: 'POST', status: auth.status });
        return NextResponse.json({ error: 'Unauthorized' }, { status: auth.status });
      }
      const actor = auth.user?.sub ?? auth.user?.walletAddress ?? 'unknown';

      let body;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
      }

      const { key, enabled, clear, reason } = body ?? {};

      // Validate key
      if (!key || typeof key !== 'string') {
        return NextResponse.json({ error: 'key is required.' }, { status: 400 });
      }
      if (!FEATURE_FLAG_REGISTRY[key]) {
        return NextResponse.json(
          { error: `Unknown feature flag: "${key}". Registered flags: ${Object.keys(FEATURE_FLAG_REGISTRY).join(', ')}` },
          { status: 400 },
        );
      }

      // Validate operation
      if (clear !== true && typeof enabled !== 'boolean') {
        return NextResponse.json(
          { error: 'Provide either enabled (boolean) or clear: true.' },
          { status: 400 },
        );
      }

      let db;
      try {
        db = await getDb();
      } catch (err) {
        auditLog({ event: 'feature_flag_db_unavailable', route: 'admin/feature-flags', method: 'POST', status: 503, reason: err?.message });
        return NextResponse.json(
          { error: 'Database unavailable. Retry when the DB recovers.', retryable: true },
          { status: 503 },
        );
      }

      try {
        if (clear === true) {
          const removed = await clearFeatureFlagOverride(key, db);
          auditLog({
            event: 'feature_flag_override_cleared',
            route: 'admin/feature-flags',
            method: 'POST',
            status: 200,
            actor,
            material: key,
            reason: String(reason ?? ''),
            version: removed ? 'removed' : 'not_found',
          });
          const resolved = await resolveFeatureFlag(key, db);
          return NextResponse.json({
            flag: { ...FEATURE_FLAG_REGISTRY[key], ...resolved },
            cleared: removed,
          });
        }

        // Set override
        await setFeatureFlagOverride(key, enabled, db, {
          updatedBy: actor,
          reason: reason ? String(reason).slice(0, 500) : null,
        });

        auditLog({
          event: enabled ? 'feature_flag_enabled' : 'feature_flag_disabled',
          route: 'admin/feature-flags',
          method: 'POST',
          status: 200,
          actor,
          material: key,          // "material" field holds the flag key here
          reason: String(reason ?? ''),
        });

        const resolved = await resolveFeatureFlag(key, db);
        return NextResponse.json({
          flag: { ...FEATURE_FLAG_REGISTRY[key], ...resolved },
        });
      } catch (err) {
        auditLog({ event: 'feature_flag_write_failed', route: 'admin/feature-flags', method: 'POST', status: 500, reason: err?.message });
        return NextResponse.json({ error: 'Failed to write override.', retryable: true }, { status: 500 });
      }
    },
  );
}
