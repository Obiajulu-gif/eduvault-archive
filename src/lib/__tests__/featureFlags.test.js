/**
 * src/lib/__tests__/featureFlags.test.js
 *
 * Vitest unit tests for the feature flag registry (#797).
 *
 * Test coverage:
 *   ✓ Every flag falls back to its safe default when config is missing
 *   ✓ Explicit "enabled" and "disabled" values are both honored
 *   ✓ Malformed values fall back to the safe default (never to "enabled")
 *   ✓ Truthy/falsy parsing is case-insensitive and ignores whitespace
 *   ✓ Unknown flag keys throw (fail loudly on typos)
 *   ✓ listFeatureFlags reports definition, value, and source for every flag
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  FEATURE_FLAG_REGISTRY,
  isFeatureFlagEnabled,
  getFeatureFlag,
  listFeatureFlags,
} from '../featureFlags.js';

const ENV_VARS = Object.keys(FEATURE_FLAG_REGISTRY).map(
  (key) => `FEATURE_FLAG_${key}`,
);

const ORIGINAL_ENV = Object.fromEntries(
  ENV_VARS.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of ENV_VARS) {
    if (ORIGINAL_ENV[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = ORIGINAL_ENV[name];
    }
  }
});

describe('safe defaults', () => {
  it('every flag defaults to false when no configuration is present', () => {
    for (const name of ENV_VARS) delete process.env[name];

    for (const definition of Object.values(FEATURE_FLAG_REGISTRY)) {
      expect(definition.defaultValue).toBe(false);
      expect(isFeatureFlagEnabled(definition.key)).toBe(false);
    }
  });

  it('missing configuration falls back to the safer (disabled) behavior', () => {
    delete process.env.FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS;
    expect(isFeatureFlagEnabled('CRITICAL_LIFECYCLE_NOTIFICATIONS')).toBe(false);

    delete process.env.FEATURE_FLAG_LEARNER_DATA_EXPORT;
    expect(isFeatureFlagEnabled('LEARNER_DATA_EXPORT')).toBe(false);
  });

  it('an empty or whitespace-only value counts as missing', () => {
    process.env.FEATURE_FLAG_LEARNER_DATA_EXPORT = '';
    expect(isFeatureFlagEnabled('LEARNER_DATA_EXPORT')).toBe(false);

    process.env.FEATURE_FLAG_LEARNER_DATA_EXPORT = '   ';
    expect(isFeatureFlagEnabled('LEARNER_DATA_EXPORT')).toBe(false);
  });
});

describe('enabled and disabled states', () => {
  it('honors explicit enabled values', () => {
    process.env.FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS = 'true';
    expect(isFeatureFlagEnabled('CRITICAL_LIFECYCLE_NOTIFICATIONS')).toBe(true);

    process.env.FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS = '1';
    expect(isFeatureFlagEnabled('CRITICAL_LIFECYCLE_NOTIFICATIONS')).toBe(true);
  });

  it('honors explicit disabled values', () => {
    process.env.FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS = 'false';
    expect(isFeatureFlagEnabled('CRITICAL_LIFECYCLE_NOTIFICATIONS')).toBe(false);

    process.env.FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS = '0';
    expect(isFeatureFlagEnabled('CRITICAL_LIFECYCLE_NOTIFICATIONS')).toBe(false);
  });

  it('parses truthy/falsy values case-insensitively and ignores whitespace', () => {
    for (const value of ['TRUE', 'True', ' yes ', 'ON']) {
      process.env.FEATURE_FLAG_LEARNER_DATA_EXPORT = value;
      expect(isFeatureFlagEnabled('LEARNER_DATA_EXPORT')).toBe(true);
    }
    for (const value of ['FALSE', 'False', ' no ', 'OFF']) {
      process.env.FEATURE_FLAG_LEARNER_DATA_EXPORT = value;
      expect(isFeatureFlagEnabled('LEARNER_DATA_EXPORT')).toBe(false);
    }
  });

  it('malformed values fall back to the safe default, never to enabled', () => {
    for (const value of ['maybe', '2', 'enabled', 'true-ish', '']) {
      process.env.FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS = value;
      expect(isFeatureFlagEnabled('CRITICAL_LIFECYCLE_NOTIFICATIONS')).toBe(false);
    }
  });

  it('flags are independent — enabling one does not enable the others', () => {
    for (const name of ENV_VARS) delete process.env[name];
    process.env.FEATURE_FLAG_LEARNER_DATA_EXPORT = 'true';

    expect(isFeatureFlagEnabled('LEARNER_DATA_EXPORT')).toBe(true);
    expect(isFeatureFlagEnabled('CRITICAL_LIFECYCLE_NOTIFICATIONS')).toBe(false);
  });
});

describe('getFeatureFlag / listFeatureFlags', () => {
  it('reports the definition, evaluated value, and source', () => {
    process.env.FEATURE_FLAG_LEARNER_DATA_EXPORT = 'true';
    const flag = getFeatureFlag('LEARNER_DATA_EXPORT');

    expect(flag.key).toBe('LEARNER_DATA_EXPORT');
    expect(flag.enabled).toBe(true);
    expect(flag.source).toBe('env');
    expect(typeof flag.description).toBe('string');
    expect(flag.description.length).toBeGreaterThan(0);
  });

  it('reports source "default" when the env var is unset', () => {
    delete process.env.FEATURE_FLAG_LEARNER_DATA_EXPORT;
    const flag = getFeatureFlag('LEARNER_DATA_EXPORT');

    expect(flag.enabled).toBe(false);
    expect(flag.source).toBe('default');
  });

  it('lists every registered flag', () => {
    const all = listFeatureFlags();
    expect(all).toHaveLength(Object.keys(FEATURE_FLAG_REGISTRY).length);
    for (const flag of all) {
      expect(flag).toHaveProperty('key');
      expect(flag).toHaveProperty('description');
      expect(flag).toHaveProperty('defaultValue');
      expect(flag).toHaveProperty('enabled');
      expect(flag).toHaveProperty('source');
    }
  });
});

describe('unknown flags', () => {
  it('throws on an unrecognized flag key', () => {
    expect(() => isFeatureFlagEnabled('NOT_A_REAL_FLAG')).toThrow(/Unknown feature flag/);
    expect(() => getFeatureFlag('NOT_A_REAL_FLAG')).toThrow(/Unknown feature flag/);
  });
});
