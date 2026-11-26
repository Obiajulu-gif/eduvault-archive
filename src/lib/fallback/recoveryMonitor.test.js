import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createRecoveryMonitor,
  getOutageSummary,
  getUserFacingStatus,
  RECOVERY_EVENT,
} from './recoveryMonitor.js';
import {
  registerService,
  reportServiceState,
  resetFallbackRegistry,
  SERVICE_STATE,
  FALLBACK_ACTION,
} from '../fallback.js';

beforeEach(() => {
  resetFallbackRegistry();
});

describe('createRecoveryMonitor', () => {
  it('throws when name missing', () => {
    expect(() => createRecoveryMonitor({ probe: vi.fn() })).toThrow(TypeError);
  });

  it('throws when probe is not a function', () => {
    expect(() => createRecoveryMonitor({ name: 'db', probe: 'not-fn' })).toThrow(TypeError);
  });

  describe('_runProbe()', () => {
    it('emits SERVICE_RECOVERED when service transitions from degraded to healthy', async () => {
      registerService('pinata', {
        policy: {
          [SERVICE_STATE.DEGRADED]: FALLBACK_ACTION.DEGRADE,
        },
      });
      reportServiceState('pinata', SERVICE_STATE.DEGRADED, 'manual');

      const emitted = [];
      const monitor = createRecoveryMonitor({
        name: 'pinata',
        probe: vi.fn().mockResolvedValue(undefined),
        emit: (ev, payload) => emitted.push({ ev, payload }),
      });

      await monitor._runProbe();

      expect(emitted.some((e) => e.ev === RECOVERY_EVENT.SERVICE_RECOVERED)).toBe(true);
      expect(emitted.some((e) => e.ev === RECOVERY_EVENT.PROBE_SUCCESS)).toBe(true);
    });

    it('emits SERVICE_DEGRADED on first probe failure', async () => {
      registerService('stellar', {});
      const emitted = [];
      const monitor = createRecoveryMonitor({
        name: 'stellar',
        probe: vi.fn().mockRejectedValue(new Error('timeout')),
        emit: (ev, payload) => emitted.push({ ev, payload }),
      });

      await monitor._runProbe();

      expect(emitted.some((e) => e.ev === RECOVERY_EVENT.PROBE_FAILURE)).toBe(true);
      expect(emitted.some((e) => e.ev === RECOVERY_EVENT.SERVICE_DEGRADED)).toBe(true);
    });

    it('emits SERVICE_UNAVAILABLE after 3 consecutive failures', async () => {
      registerService('mongo', {});
      const emitted = [];
      const monitor = createRecoveryMonitor({
        name: 'mongo',
        probe: vi.fn().mockRejectedValue(new Error('connection refused')),
        emit: (ev, payload) => emitted.push({ ev, payload }),
      });

      // 3 consecutive failures => UNAVAILABLE
      await monitor._runProbe();
      await monitor._runProbe();
      await monitor._runProbe();

      expect(emitted.filter((e) => e.ev === RECOVERY_EVENT.SERVICE_UNAVAILABLE).length).toBeGreaterThanOrEqual(1);
    });

    it('applies exponential backoff when UNAVAILABLE', async () => {
      registerService('email', {});
      const monitor = createRecoveryMonitor({
        name: 'email',
        probe: vi.fn().mockRejectedValue(new Error('down')),
        intervalMs: 1000,
        backoffFactor: 2,
        maxBackoffMs: 8000,
      });

      for (let i = 0; i < 4; i++) await monitor._runProbe();
      const status = monitor.getStatus();
      // After 4 failures, delay should have grown beyond base interval
      expect(status.currentDelayMs).toBeGreaterThan(1000);
    });

    it('resets backoff on successful probe', async () => {
      registerService('ipfs', {});
      const probe = vi
        .fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValue(undefined);

      const monitor = createRecoveryMonitor({
        name: 'ipfs',
        probe,
        intervalMs: 1000,
        backoffFactor: 2,
      });

      for (let i = 0; i < 4; i++) await monitor._runProbe();
      expect(monitor.getStatus().currentDelayMs).toBe(1000);
    });

    it('does not emit recovered event when already healthy', async () => {
      registerService('healthy-svc', {});
      const emitted = [];
      const monitor = createRecoveryMonitor({
        name: 'healthy-svc',
        probe: vi.fn().mockResolvedValue(undefined),
        emit: (ev, payload) => emitted.push({ ev, payload }),
      });

      await monitor._runProbe();
      expect(emitted.some((e) => e.ev === RECOVERY_EVENT.SERVICE_RECOVERED)).toBe(false);
    });
  });

  describe('getStatus()', () => {
    it('returns running=false before start', () => {
      registerService('svc', {});
      const monitor = createRecoveryMonitor({ name: 'svc', probe: vi.fn() });
      expect(monitor.getStatus().running).toBe(false);
    });

    it('returns running=true after start, false after stop', () => {
      registerService('svc2', {});
      const monitor = createRecoveryMonitor({ name: 'svc2', probe: vi.fn() });
      monitor.start();
      expect(monitor.getStatus().running).toBe(true);
      monitor.stop();
      expect(monitor.getStatus().running).toBe(false);
    });
  });
});

describe('getOutageSummary()', () => {
  it('returns empty array when all services healthy', () => {
    registerService('db', {});
    registerService('cdn', {});
    expect(getOutageSummary()).toHaveLength(0);
  });

  it('includes degraded services', () => {
    registerService('pinata', {
      policy: {
        [SERVICE_STATE.DEGRADED]: FALLBACK_ACTION.DEGRADE,
        [SERVICE_STATE.UNAVAILABLE]: FALLBACK_ACTION.BLOCK,
      },
    });
    reportServiceState('pinata', SERVICE_STATE.DEGRADED, 'test');
    const summary = getOutageSummary();
    expect(summary.some((s) => s.service === 'pinata')).toBe(true);
  });

  it('includes unavailable services', () => {
    registerService('smtp', {
      policy: {
        [SERVICE_STATE.UNAVAILABLE]: FALLBACK_ACTION.BLOCK,
      },
    });
    reportServiceState('smtp', SERVICE_STATE.UNAVAILABLE, 'test');
    const summary = getOutageSummary();
    expect(summary.some((s) => s.service === 'smtp')).toBe(true);
  });

  it('summary entries have required fields', () => {
    registerService('stellar2', {
      policy: { [SERVICE_STATE.UNAVAILABLE]: FALLBACK_ACTION.BLOCK },
    });
    reportServiceState('stellar2', SERVICE_STATE.UNAVAILABLE, 'test');
    const [entry] = getOutageSummary();
    expect(entry).toMatchObject({
      service: 'stellar2',
      state: SERVICE_STATE.UNAVAILABLE,
      message: expect.any(String),
      action: expect.any(String),
    });
  });
});

describe('getUserFacingStatus()', () => {
  it('returns healthy=true when no outages', () => {
    registerService('healthy', {});
    expect(getUserFacingStatus().healthy).toBe(true);
  });

  it('returns healthy=false with services array when outage', () => {
    registerService('mongo2', {
      policy: { [SERVICE_STATE.UNAVAILABLE]: FALLBACK_ACTION.BLOCK },
    });
    reportServiceState('mongo2', SERVICE_STATE.UNAVAILABLE, 'test');
    const status = getUserFacingStatus();
    expect(status.healthy).toBe(false);
    expect(status.services.length).toBeGreaterThan(0);
    expect(status.services[0]).toMatchObject({
      service: 'mongo2',
      willBlock: true,
      message: expect.any(String),
    });
  });

  it('marks canQueue for QUEUE action', () => {
    registerService('queue-svc', {
      policy: {
        [SERVICE_STATE.DEGRADED]: FALLBACK_ACTION.QUEUE,
      },
    });
    reportServiceState('queue-svc', SERVICE_STATE.DEGRADED, 'test');
    const status = getUserFacingStatus();
    const svc = status.services.find((s) => s.service === 'queue-svc');
    expect(svc?.canQueue).toBe(true);
  });
});
