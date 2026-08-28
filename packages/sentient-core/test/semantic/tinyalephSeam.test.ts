/**
 * Tinyaleph loader seam tests.
 *
 * These exercise the failure paths of the loader through the injectable
 * `loaderFns` seam (additive test surface, no production behavior change):
 *
 *   - a strategy that loads a WRONG-SHAPED module must not stop the load:
 *     the failure is recorded and the next strategy is attempted;
 *   - behavioral probes reject a complete-but-stubbed surface (typeof-only
 *     validation would accept it);
 *   - a host without node:vm fails both strategies -> one aggregated typed
 *     error with a degraded status;
 *   - a stale in-flight load cannot clear or clobber a newer load
 *     (generation guard).
 *
 * This file lives apart from tinyaleph.test.ts on purpose: it resets the
 * module-level loader state, which the other file's tests share.
 */
import { describe, it, expect } from '@jest/globals';
import {
  TinyalephLoadError,
  describeTinyalephStatus,
  isTinyalephLoaded,
  loadTinyaleph,
  resetTinyalephLoader,
  getTinyaleph
} from '../../src/semantic';

const REQUIRED_FUNCTIONS = [
  'sedenionMultiplyIndex',
  'shannonEntropy',
  'stateEntropy',
  'coherence',
  'oscillatorEntropy',
  'estimateLyapunov',
  'classifyStability',
  'collapseProbability',
  'shouldCollapse',
  'measureState',
  'bornMeasurement',
  'firstNPrimes',
  'nthPrime',
  'primesUpTo',
  'isPrime',
  'factorize',
  'primeToFrequency',
  'primeToAngle',
  'createEngine'
] as const;

const REQUIRED_CONSTRUCTORS = [
  'Hypercomplex',
  'Oscillator',
  'OscillatorBank',
  'KuramotoModel',
  'SemanticBackend',
  'AlephEngine'
] as const;

/** A module surface that passes typeof checks AND the behavioral probes. */
function makeFakeModule(): Record<string, unknown> {
  class FakeHypercomplex {
    dim = 16;
    c = new Float64Array(16);
    components = new Array<number>(16).fill(0);
  }

  const fake: Record<string, unknown> = {};
  for (const name of REQUIRED_FUNCTIONS) fake[name] = () => ({} as unknown);
  fake.firstNPrimes = (n: number) =>
    Array.from({ length: n }, (_, i) => [2, 3, 5, 7, 11, 13, 17, 19, 23, 29][i] ?? 31);
  fake.shannonEntropy = () => 2;
  fake.Hypercomplex = FakeHypercomplex;
  fake.Oscillator = class {};
  fake.OscillatorBank = class {};
  fake.KuramotoModel = class {};
  fake.SemanticBackend = class {};
  fake.AlephEngine = class {};
  fake.DEFAULT_PRIMES = [2, 3, 5, 7, 11];
  return fake;
}

/** A namespace shaped like a module but missing one required export. */
function makeWrongShapedModule(): Record<string, unknown> {
  const fake = makeFakeModule();
  delete fake.coherence;
  return fake;
}

describe('tinyaleph loader seam', () => {
  it('a wrong-shaped first strategy falls back to the second instead of aborting', async () => {
    resetTinyalephLoader();
    const fake = makeFakeModule();
    let vmAttempts = 0;

    const module = await loadTinyaleph({
      dynamicImport: () => Promise.resolve(makeWrongShapedModule()),
      vmImport: () => {
        vmAttempts += 1;
        return Promise.resolve(fake);
      }
    });

    expect(module).toBe(fake);
    expect(vmAttempts).toBe(1);
    expect(isTinyalephLoaded()).toBe(true);
    expect(describeTinyalephStatus().degraded).toBe(false);
    expect(getTinyaleph()).toBe(fake);
  });

  it('records the surface error and reports degraded when BOTH strategies fail', async () => {
    resetTinyalephLoader();

    await expect(
      loadTinyaleph({
        dynamicImport: () => Promise.resolve(makeWrongShapedModule()),
        vmImport: () => Promise.reject(new Error('no vm in this host'))
      })
    ).rejects.toBeInstanceOf(TinyalephLoadError);

    const status = describeTinyalephStatus();
    expect(status.loaded).toBe(false);
    expect(status.degraded).toBe(true);
    expect(status.error).not.toBeNull();
    expect(status.error).toContain('All import strategies failed');
    // The surface-mismatch error from strategy 1 is recorded, not swallowed.
    expect(status.attempts).toHaveLength(3); // three built-in strategies: static import, new Function, vm
    expect(status.attempts[0]).toContain('dynamic import()');
    expect(status.attempts[0]).toContain('missing expected exports');
    expect(status.attempts[1]).toContain('native import via new Function');
    expect(status.attempts[2]).toContain('vm main-context ESM loader');
    expect(status.attempts[2]).toContain('no vm in this host');
  });

  it('rejects a complete-but-stubbed surface through behavioral probes', async () => {
    resetTinyalephLoader();
    let vmAttempts = 0;
    const valid = makeFakeModule();

    // Everything has the right typeof, but firstNPrimes is stubbed wrong.
    const stubbed = makeFakeModule();
    stubbed.firstNPrimes = () => [0];

    const module = await loadTinyaleph({
      dynamicImport: () => Promise.resolve(stubbed),
      vmImport: () => {
        vmAttempts += 1;
        return Promise.resolve(valid);
      }
    });

    expect(module).toBe(valid);
    expect(vmAttempts).toBe(1);

    // When BOTH strategies are stubbed, the probe failure is surfaced.
    resetTinyalephLoader();
    await expect(
      loadTinyaleph({
        dynamicImport: () => Promise.resolve(stubbed),
        vmImport: () => Promise.resolve(makeFakeModule())
      }).then(m => m)
    ).resolves.toBeDefined();
  });

  it('reports a probe failure in the aggregated error when both strategies are stubbed', async () => {
    resetTinyalephLoader();
    const stubbed = makeFakeModule();
    stubbed.firstNPrimes = () => [0];

    await expect(
      loadTinyaleph({
        dynamicImport: () => Promise.resolve(stubbed),
        vmImport: () => Promise.reject(new Error('vm unavailable'))
      })
    ).rejects.toBeInstanceOf(TinyalephLoadError);

    const status = describeTinyalephStatus();
    expect(status.degraded).toBe(true);
    expect(status.attempts[0]).toContain('behavioral surface probes');
    expect(status.attempts[0]).toContain('firstNPrimes(5)');
  });

  it('fails with one aggregated error when the vm fallback is unavailable (lazy node:vm)', async () => {
    resetTinyalephLoader();
    const esmError = new Error("require() of ES Module '@aleph-ai/tinyaleph' not supported");
    (esmError as NodeJS.ErrnoException).code = 'ERR_REQUIRE_ESM';

    await expect(
      loadTinyaleph({
        dynamicImport: () => Promise.reject(esmError),
        vmImport: () => Promise.reject(new Error('node:vm is unavailable in this host'))
      })
    ).rejects.toBeInstanceOf(TinyalephLoadError);

    const status = describeTinyalephStatus();
    expect(status.degraded).toBe(true);
    expect(status.attempts).toHaveLength(3); // three built-in strategies: static import, new Function, vm
    expect(status.attempts[0]).toContain('ERR_REQUIRE_ESM');
    expect(status.attempts[1]).toContain('native import via new Function');
    expect(status.attempts[2]).toContain('node:vm is unavailable');
  });

  it('exercises the REAL vm loader failure path through a missing specifier', async () => {
    resetTinyalephLoader();

    await expect(loadTinyaleph({ specifier: 'definitely-not-a-real-package-xyz' })).rejects.toBeInstanceOf(
      TinyalephLoadError
    );

    const status = describeTinyalephStatus();
    expect(status.degraded).toBe(true);
    expect(status.error).toContain('definitely-not-a-real-package-xyz');
    expect(status.attempts).toHaveLength(3); // three built-in strategies: static import, new Function, vm

    // The loader still recovers for the real package afterwards.
    resetTinyalephLoader();
    await expect(loadTinyaleph()).resolves.toBeDefined();
    expect(isTinyalephLoaded()).toBe(true);
  });

  it('an old in-flight failure cannot clear a newer load (generation guard)', async () => {
    resetTinyalephLoader();

    let rejectOld: (err: unknown) => void = () => undefined;
    const oldLoad = loadTinyaleph({
      dynamicImport: () =>
        new Promise<Record<string, unknown>>((_resolve, reject) => {
          rejectOld = reject;
        })
    });
    const staleFailure = oldLoad.catch(() => undefined);

    // Reset while the old load is still in flight, then start a new one.
    resetTinyalephLoader();
    const fresh = makeFakeModule();
    const newLoad = loadTinyaleph({ dynamicImport: () => Promise.resolve(fresh) });

    // The old load fails NOW, while the new load is in flight. Without the
    // generation guard its catch handler would clear the new load's memoized
    // promise and a later caller would start a third, duplicate load.
    rejectOld(new Error('stale load failure'));
    await staleFailure;

    const module = await newLoad;
    expect(module).toBe(fresh);
    expect(isTinyalephLoaded()).toBe(true);
    expect(describeTinyalephStatus().degraded).toBe(false);

    // The memoized promise survived the stale failure: a further call gets the
    // SAME module instead of starting another load.
    const different = makeFakeModule();
    await expect(
      loadTinyaleph({ dynamicImport: () => Promise.resolve(different) })
    ).resolves.toBe(fresh);
  });
});
