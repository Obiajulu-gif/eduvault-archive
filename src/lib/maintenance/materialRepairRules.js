/**
 * Repair rules for known inconsistent material states (#886, reused by the
 * checkpointed dry-run planner in #1084).
 *
 * Each rule inspects one material and, when it applies, returns the fields to
 * set plus the fields it *read* to decide (`guard`). The planner pins guard
 * values so a material whose inputs change between dry-run and apply is
 * skipped as stale instead of being "repaired" on outdated reasoning.
 */

export const MATERIAL_REPAIR_RULE_VERSION = "materials-repair-v1";

export const MATERIAL_REPAIR_RULES = Object.freeze([
  {
    type: "missing-storage-key",
    description: "Material has fileUrl but missing storageKey",
    applies: (doc) => !doc.storageKey && Boolean(doc.fileUrl),
    set: (doc) => ({ storageKey: doc.fileUrl }),
    guard: ["fileUrl"],
  },
  {
    type: "private-without-price",
    description: "Private material has no price — should be public or have a price",
    applies: (doc) => doc.visibility === "private" && (!doc.price || doc.price <= 0),
    set: () => ({ visibility: "public" }),
    guard: ["price"],
  },
  {
    type: "deleted-with-search-version",
    description: "Deleted material still has active search version",
    applies: (doc) => Boolean(doc.isDeleted) && Boolean(doc.searchVersion) && doc.searchVersion > 0,
    set: () => ({ searchVersion: 0 }),
    guard: ["isDeleted"],
  },
]);

/**
 * `detect` callback for `planRepair`: combines every applicable rule into a
 * single proposal for the material, or returns null when nothing applies.
 */
export function detectMaterialRepair(doc) {
  const applicable = MATERIAL_REPAIR_RULES.filter((rule) => rule.applies(doc));
  if (applicable.length === 0) return null;
  const set = {};
  const guard = new Set();
  for (const rule of applicable) {
    Object.assign(set, rule.set(doc));
    for (const field of rule.guard) guard.add(field);
  }
  return { set, guard: [...guard], reason: applicable.map((rule) => rule.type).join(",") };
}
