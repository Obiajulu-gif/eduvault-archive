import { ObjectId } from "mongodb";

// Next.js route modules may only export HTTP handlers, so the helpers shared by
// the transfer routes live here.

// Production material ids are ObjectIds; older rows and fixtures use strings.
export function toMaterialId(id) {
  return typeof id === "string" && ObjectId.isValid(id) && String(new ObjectId(id)) === id ? new ObjectId(id) : id;
}

// Serializes a transfer document for API responses.
// Callers get the transfer without history by default, or with history if authorized.
export function serializeTransfer(transfer, { includeHistory = false } = {}) {
  if (!transfer) return null;
  if (includeHistory) {
    return { ...transfer, materialId: String(transfer.materialId) };
  }
  const { history: _history, ...rest } = transfer;
  return { ...rest, materialId: String(transfer.materialId) };
}
