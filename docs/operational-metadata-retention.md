# Operational metadata retention

Use `node scripts/data-retention-cleanup.mjs --preview` to review operational metadata before deletion. The preview is read-only, deterministic, and separates eligible records from legal, audit, dispute, settlement, refund, and collection-specific holds. Apply cleanup only after the failed bucket is empty and the eligible sample is expected. The retention tests cover both deletion eligibility and preservation of held records.
