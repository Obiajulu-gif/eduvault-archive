export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { getUserQuery, getUserIdString } from "@/lib/profile/accountData";
import { buildExportQueries, buildProfileExport } from "@/lib/profile/accountPrivacy";

async function findOwnedDocuments(db, collectionName, query) {
  if (!query) return [];
  return db.collection(collectionName).find(query).toArray();
}

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "profile.export", rateLimit: { limit: 10, windowMs: 60 * 60 * 1000 } },
    async () => {
      try {
        const sessionUser = await getUserFromCookie(request);
        if (!sessionUser) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const db = await getDb();
        const user = await db.collection("users").findOne(getUserQuery(sessionUser));
        if (!user) {
          return NextResponse.json({ error: "User not found" }, { status: 404 });
        }

        const queries = buildExportQueries(user);
        const [purchases, notes, savedItems, reviews, feedback] = await Promise.all([
          findOwnedDocuments(db, "purchases", queries.purchases),
          findOwnedDocuments(db, "learner_notes", queries.notes),
          findOwnedDocuments(db, "saved_materials", queries.savedItems),
          findOwnedDocuments(db, "reviews", queries.reviews),
          findOwnedDocuments(db, "material_feedback", queries.feedback),
        ]);

        const archive = buildProfileExport(user, {
          purchases,
          notes,
          savedItems,
          reviews,
          feedback,
        });

        auditLog({
          event: "profile_exported",
          route: "profile.export",
          method: "GET",
          status: 200,
          actor: getUserIdString(sessionUser),
        });

        const response = NextResponse.json(archive);
        response.headers.set("Content-Disposition", 'attachment; filename="eduvault-profile-export.json"');
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch (error) {
        auditLog({
          event: "profile_export_failed",
          route: "profile.export",
          method: "GET",
          status: 500,
          reason: error.message,
        });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
