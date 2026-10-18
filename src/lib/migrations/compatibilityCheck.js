function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Validate that a proposed next schema can safely read and roll back samples. */
export function checkMigrationCompatibility({ schema, records = [], nextVersion = schema?.latest + 1 } = {}) {
  const errors = [];
  if (!schema || !Number.isInteger(nextVersion) || nextVersion <= schema.latest) {
    errors.push("nextVersion must be greater than the current schema version");
  }
  const migration = schema?.migrations?.[nextVersion];
  if (!migration?.up) errors.push(`migration ${nextVersion} is missing an up transform`);
  if (!migration?.down) errors.push(`migration ${nextVersion} is missing a down transform`);
  if (typeof migration?.validate !== "function") errors.push(`migration ${nextVersion} is missing a validator`);

  const samples = [];
  if (errors.length === 0) {
    for (const record of records) {
      try {
        const upgraded = migration.up({ ...record });
        if (!migration.validate(upgraded)) throw new Error("upgraded record failed validation");
        const restored = migration.down({ ...upgraded });
        if (!equalJson({ ...record, schemaVersion: schema.latest }, restored)) {
          throw new Error("down transform does not restore the previous shape");
        }
        samples.push({ id: record._id ?? null, valid: true });
      } catch (error) {
        errors.push(`record ${String(record._id ?? "unknown")}: ${error.message}`);
      }
    }
  }
  return { valid: errors.length === 0, errors, checked: samples.length, samples };
}

export function assertMigrationCompatible(options) {
  const result = checkMigrationCompatibility(options);
  if (!result.valid) throw new Error(`Migration compatibility check failed: ${result.errors.join("; ")}`);
  return result;
}
