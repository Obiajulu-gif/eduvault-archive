import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api/auth';
import { checkAllDependencies } from '@/lib/health/dependencyChecker';
import { SYSTEM_STATE } from '@/lib/status/publicStatusModel';
import {
  StatusAuthError,
  StatusValidationError,
  createUserFacingStatusStore,
} from '@/lib/status/degradedDependencyStatus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Module-scoped so operator overrides survive individual requests within the
// process. Overrides are in-memory by design and must not be used for
// persistence; a restart falls back to the live dependency checks.
const store = createUserFacingStatusStore({
  dependenciesProvider: () => checkAllDependencies({ env: process.env }),
  subsystemProvider: async () => ({ state: SYSTEM_STATE.OPERATIONAL }),
  authorize: async (principal, action) => {
    if (action !== 'status:override') return false;
    return Boolean(principal?.id) && ['admin', 'superadmin', 'operator'].includes(principal.role);
  },
});

function principalFor(user) {
  return {
    id: user?.sub || user?.address || user?.email || 'admin',
    role: user?.role || 'admin',
  };
}

function handleError(error) {
  if (error instanceof StatusAuthError || error instanceof StatusValidationError) {
    return NextResponse.json({ error: error.message, code: error.code, details: error.details }, { status: error.status });
  }
  console.error('[admin/status/dependencies] Error:', error);
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
}

/** GET /api/admin/status/dependencies — operator view (requires operations:read). */
export async function GET(request) {
  const authorization = await requirePermission(request, 'operations:read', { allowService: true });
  if (!authorization.ok) {
    return NextResponse.json({ error: 'Forbidden: operations access required' }, { status: authorization.status });
  }

  try {
    await store.get();
    return NextResponse.json({ ok: true, data: store.getOperatorView() });
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/admin/status/dependencies — escalate a feature's public status. */
export async function POST(request) {
  const authorization = await requirePermission(request, 'operations:write');
  if (!authorization.ok) {
    return NextResponse.json({ error: 'Forbidden: operations write access required' }, { status: authorization.status });
  }

  try {
    const body = await request.json();
    const { dependency, status, message = '' } = body || {};
    const payload = await store.setOverride({
      dependency,
      status,
      message,
      principal: principalFor(authorization.user),
    });
    return NextResponse.json({ ok: true, data: payload });
  } catch (error) {
    return handleError(error instanceof SyntaxError ? new StatusValidationError('Invalid JSON body.') : error);
  }
}

/** DELETE /api/admin/status/dependencies — clear an override. */
export async function DELETE(request) {
  const authorization = await requirePermission(request, 'operations:write');
  if (!authorization.ok) {
    return NextResponse.json({ error: 'Forbidden: operations write access required' }, { status: authorization.status });
  }

  try {
    let dependency;
    try {
      ({ dependency } = await request.json());
    } catch {
      dependency = new URL(request.url).searchParams.get('dependency');
    }
    const payload = await store.clearOverride({ dependency, principal: principalFor(authorization.user) });
    return NextResponse.json({ ok: true, data: payload });
  } catch (error) {
    return handleError(error);
  }
}
