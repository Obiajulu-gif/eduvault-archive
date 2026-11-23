import { requireActiveUser } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { IdentityLinkError } from "@/lib/auth/identityLinks";
import { getDb } from "@/lib/mongodb";
import { errorResponse } from "@/lib/utils/errorResponse";

/**
 * Shared shell for the /api/identities routes (#880): rate limiting, an
 * active (non-suspended, non-revoked) session, and IdentityLinkError →
 * problem-details mapping. `handler` receives `{ db, user }`.
 */
export function handleIdentityRoute(request, { route, rateLimit }, handler) {
  return withApiHardening(request, { route, rateLimit }, async () => {
    const auth = await requireActiveUser(request);
    if (!auth.ok) {
      return errorResponse({ status: auth.status || 401, detail: "Authentication required", request });
    }
    try {
      return await handler({ db: await getDb(), user: auth.user });
    } catch (error) {
      if (error instanceof IdentityLinkError) {
        return errorResponse({
          status: error.status,
          type: `https://eduvault.dev/problems/${error.code.toLowerCase()}`,
          detail: error.message,
          request,
        });
      }
      throw error;
    }
  });
}
