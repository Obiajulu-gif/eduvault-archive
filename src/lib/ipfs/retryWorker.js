import { getDb } from "@/lib/mongodb"
import { reclaimUploadSessions } from "./uploadSessions"

/**
 * Runs one bounded compensation pass. The deployment supplies an unpin
 * adapter so provider credentials and provider-specific APIs stay server-side.
 */
export async function runUploadCleanup({ unpin, db, limit = 100, now = new Date() }) {
  if (typeof unpin !== "function") throw new Error("an authenticated unpin adapter is required")
  return reclaimUploadSessions(db || await getDb(), unpin, { limit, now })
}
