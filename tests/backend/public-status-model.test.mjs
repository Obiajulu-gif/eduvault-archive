import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import {
  SYSTEM_STATE,
  SUBSYSTEMS,
  sanitizeText,
  sanitizeErrorMessage,
  setSubsystemStatus,
  calculateOverallState,
  getPublicStatus,
  getOperatorStatus,
  checkSubsystemAvailability,
  assertSubsystemOperational,
  resetAllSubsystems,
} from '../../src/lib/status/publicStatusModel.js';

beforeEach(() => {
  resetAllSubsystems();
});

test('sanitizeText redacts Stellar secret seeds, Mongo URIs, and JWT tokens', () => {
  const stellarSecret = 'SB5K6X7Q52ZXZ5O7X7U2Y4P23A2M4D5F6G7H8J9K0L1M2N3P4Q5R6S7T';
  const mongoUri = 'mongodb+srv://adminUser:SuperSecretPass123@cluster.eduvault.mongodb.net/eduvault?retryWrites=true';
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

  const rawLog = `Failed to connect to ${mongoUri} using seed ${stellarSecret} and bearer ${jwt}`;
  const sanitized = sanitizeText(rawLog);

  assert.ok(!sanitized.includes('SuperSecretPass123'), 'Mongo password must not leak');
  assert.ok(!sanitized.includes(stellarSecret), 'Stellar secret must not leak');
  assert.ok(!sanitized.includes(jwt), 'JWT must not leak');
  assert.ok(sanitized.includes('[REDACTED_CREDENTIALS]'));
  assert.ok(sanitized.includes('[REDACTED_STELLAR_SECRET]'));
  assert.ok(sanitized.includes('[REDACTED_JWT]'));
});

test('sanitizeErrorMessage strips stack traces and returns clean single-line error', () => {
  const err = new Error(
    'MongoNetworkError: connection pool closed for mongodb://service_acc:secretP@ss@10.0.4.12:27017\n' +
    '    at ConnectionPool.checkOut (C:\\src\\node_modules\\mongodb\\lib\\cmap\\connection_pool.js:280:23)\n' +
    '    at async getDb (C:\\src\\lib\\mongodb.js:45:12)'
  );

  const clean = sanitizeErrorMessage(err);
  assert.ok(!clean.includes('secretP@ss'));
  assert.ok(!clean.includes('ConnectionPool.checkOut'));
  assert.ok(!clean.includes('C:\\src\\node_modules'));
  assert.ok(clean.includes('[REDACTED_CREDENTIALS]'));
});

test('subsystem transitions and overall state computation', () => {
  assert.equal(calculateOverallState(), SYSTEM_STATE.OPERATIONAL);

  // Degrade indexing
  setSubsystemStatus(SUBSYSTEMS.INDEXER, SYSTEM_STATE.DEGRADED, 'RPC latency above 800ms');
  assert.equal(calculateOverallState(), SYSTEM_STATE.DEGRADED);

  // Pause checkout (higher severity than degraded)
  setSubsystemStatus(SUBSYSTEMS.CHECKOUT, SYSTEM_STATE.PAUSED, 'Soroban fee surge guard triggered');
  assert.equal(calculateOverallState(), SYSTEM_STATE.PAUSED);

  // Set storage to maintenance (highest severity)
  setSubsystemStatus(SUBSYSTEMS.STORAGE, SYSTEM_STATE.MAINTENANCE, 'IPFS cluster migration');
  assert.equal(calculateOverallState(), SYSTEM_STATE.MAINTENANCE);

  const publicStatus = getPublicStatus();
  assert.equal(publicStatus.status, SYSTEM_STATE.MAINTENANCE);
  assert.equal(publicStatus.subsystems[SUBSYSTEMS.CHECKOUT].status, SYSTEM_STATE.PAUSED);
  assert.equal(publicStatus.subsystems[SUBSYSTEMS.INDEXER].status, SYSTEM_STATE.DEGRADED);
  assert.equal(publicStatus.subsystems[SUBSYSTEMS.STORAGE].status, SYSTEM_STATE.MAINTENANCE);
  assert.ok(publicStatus.activeIncidents.length >= 3);
});

test('checkSubsystemAvailability enforces read vs write operation rules', () => {
  // 1. Operational: both read and write allowed
  assert.equal(checkSubsystemAvailability(SUBSYSTEMS.CHECKOUT, 'read').allowed, true);
  assert.equal(checkSubsystemAvailability(SUBSYSTEMS.CHECKOUT, 'write').allowed, true);

  // 2. Degraded: both read and write allowed
  setSubsystemStatus(SUBSYSTEMS.CHECKOUT, SYSTEM_STATE.DEGRADED, 'Minor backlog');
  assert.equal(checkSubsystemAvailability(SUBSYSTEMS.CHECKOUT, 'read').allowed, true);
  assert.equal(checkSubsystemAvailability(SUBSYSTEMS.CHECKOUT, 'write').allowed, true);

  // 3. Paused: read allowed, write blocked with 503
  setSubsystemStatus(SUBSYSTEMS.CHECKOUT, SYSTEM_STATE.PAUSED, 'Risk check in progress');
  assert.equal(checkSubsystemAvailability(SUBSYSTEMS.CHECKOUT, 'read').allowed, true);
  const writeCheck = checkSubsystemAvailability(SUBSYSTEMS.CHECKOUT, 'write');
  assert.equal(writeCheck.allowed, false);
  assert.equal(writeCheck.statusCode, 503);
  assert.equal(writeCheck.retryAfterSeconds, 60);

  // 4. Maintenance: both read and write blocked
  setSubsystemStatus(SUBSYSTEMS.CHECKOUT, SYSTEM_STATE.MAINTENANCE, 'Contract upgrade');
  assert.equal(checkSubsystemAvailability(SUBSYSTEMS.CHECKOUT, 'read').allowed, false);
  assert.equal(checkSubsystemAvailability(SUBSYSTEMS.CHECKOUT, 'write').allowed, false);
});

test('assertSubsystemOperational throws sanitized SubsystemUnavailableError', () => {
  setSubsystemStatus(SUBSYSTEMS.MARKETPLACE, SYSTEM_STATE.MAINTENANCE, 'Catalog re-indexing');

  assert.throws(
    () => assertSubsystemOperational(SUBSYSTEMS.MARKETPLACE, 'write'),
    (err) => {
      assert.equal(err.name, 'SubsystemUnavailableError');
      assert.equal(err.subsystem, 'marketplace');
      assert.equal(err.statusCode, 503);
      assert.ok(err.message.includes('Catalog re-indexing'));
      return true;
    }
  );
});

test('operator view contains transition history while maintaining confidentiality', () => {
  setSubsystemStatus(
    SUBSYSTEMS.ENTITLEMENTS,
    SYSTEM_STATE.DEGRADED,
    'RPC connection error to SAA7XYZ555555555555555555555555555555555555555555555555555',
    'operator-alice'
  );

  const opStatus = getOperatorStatus();
  assert.ok(Array.isArray(opStatus.history));
  assert.ok(opStatus.history.length > 0);

  const latest = opStatus.history[0];
  assert.equal(latest.subsystem, 'entitlements');
  assert.equal(latest.actor, 'operator-alice');
  assert.ok(!latest.reason.includes('SAA7XYZ'), 'Must redact Stellar secret seed in operator view as well');
  assert.ok(latest.reason.includes('[REDACTED_STELLAR_SECRET]'));
});
