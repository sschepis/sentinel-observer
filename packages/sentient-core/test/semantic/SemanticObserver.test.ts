/**
 * SemanticObserver integration tests - the integration test the legacy
 * engine never had.
 *
 * Also covers the crash fix: the legacy observer emitted 'error' on a raw
 * EventEmitter from inside a catch block, killing the process whenever a tick
 * failed. This observer publishes typed observables; errors with no
 * subscriber are safely dropped.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  ConfigurationLimitError,
  SemanticKernel,
  SemanticObserver,
  SemanticObserverConfigError,
  type SafetyMonitor
} from '../../src/semantic';
import { freshKernel } from './helpers';

describe('SemanticObserver', () => {
  let kernel: SemanticKernel;

  beforeAll(async () => {
    kernel = await freshKernel();
  });

  it('initializes, processes input, ticks, and returns finite metrics', async () => {
    const observer = new SemanticObserver({ kernel, primeCount: 16, gridSize: 32, momentThreshold: 0.85 });
    await observer.initialize();
    expect(observer.isInitialized()).toBe(true);

    // Both input modalities: text (through the real SemanticBackend) and primes.
    const foldedText = observer.processInput('the observer perceives coherence and time', 0.4);
    expect(foldedText.length).toBeGreaterThan(0);
    expect(foldedText.every(p => observer.getOscillatorField().primes.includes(p))).toBe(true);

    const foldedPrimes = observer.processInput([2, 3, 5, 7], 0.5);
    expect(foldedPrimes).toEqual([2, 3, 5, 7]);

    for (let i = 0; i < 5; i++) {
      const event = observer.tick(0.016);
      expect(Number.isFinite(event.metrics.coherence)).toBe(true);
      expect(Number.isFinite(event.metrics.entropy)).toBe(true);
      expect(Number.isFinite(event.metrics.orderParameter)).toBe(true);
      expect(Number.isFinite(event.smfNormalizedEntropy)).toBe(true);
      expect(event.safety).not.toBeNull();
    }

    const state = observer.getState();
    expect(state.tickCount).toBe(5);
    expect(Number.isFinite(state.coherence)).toBe(true);
    expect(Number.isFinite(state.entropy)).toBe(true);
    expect(Number.isFinite(state.orderParameter)).toBe(true);
    expect(Number.isFinite(state.holographicEnergy)).toBe(true);
    expect(Number.isFinite(state.holographicEntropy)).toBe(true);
    expect(Number.isFinite(state.holographicDrift)).toBe(true);
    expect(state.smf).toHaveLength(16);
    expect(state.smf.every(Number.isFinite)).toBe(true);
    expect(state.activePrimeCount).toBeGreaterThan(0);
    expect(state.safety).not.toBeNull();
    expect(state.kernel.loaded).toBe(true);
    expect(state.kernel.degraded).toBe(false);

    observer.dispose();
  });

  it('passes the fail-closed safety gate with real metrics', async () => {
    const observer = new SemanticObserver({ kernel, momentThreshold: 0.9 });
    await observer.initialize();
    observer.processInput([2, 3, 5], 0.5);
    observer.tick(0.016);

    const safety = observer.getState().safety!;
    expect(safety.allowed).toBe(true);
    expect(safety.violations).toEqual([]);
    observer.dispose();
  });

  it('emits a moment when coherence crosses the threshold going up', async () => {
    const observer = new SemanticObserver({ kernel, momentThreshold: 0.85 });
    await observer.initialize();

    const moments: string[] = [];
    const subscription = observer.moments.subscribe(moment => moments.push(moment.id));

    // Quiescent: no moment.
    observer.tick(0.016);
    expect(moments).toHaveLength(0);

    // Excite: the first tick after excitation crosses the threshold.
    observer.processInput([2, 3, 5], 0.5);
    const crossing = observer.tick(0.016);
    expect(crossing.moment).not.toBeNull();
    expect(crossing.moment!.coherence).toBeGreaterThan(0.85);
    expect(crossing.moment!.previousCoherence).toBeLessThanOrEqual(0.85);
    expect(moments).toHaveLength(1);
    expect(crossing.moment!.id).toBe(moments[0]);

    // Already above the threshold: no second moment on the next tick.
    const after = observer.tick(0.016);
    expect(after.moment).toBeNull();
    expect(moments).toHaveLength(1);

    const state = observer.getState();
    expect(state.momentCount).toBe(1);
    expect(state.lastMomentId).toBe(crossing.moment!.id);

    subscription.unsubscribe();
    observer.dispose();
  });

  it('ticks and moments observables deliver events', async () => {
    const observer = new SemanticObserver({ kernel });
    await observer.initialize();

    const tickEvents: number[] = [];
    const tickSubscription = observer.ticks.subscribe(event => tickEvents.push(event.tick));

    observer.tick(0.016);
    observer.tick(0.016);
    expect(tickEvents).toEqual([1, 2]);

    tickSubscription.unsubscribe();
    observer.tick(0.016);
    expect(tickEvents).toEqual([1, 2]); // unsubscribed: no delivery

    observer.dispose();
  });

  it('tick failures are published on the errors observable and rethrown', async () => {
    const observer = new SemanticObserver({ kernel });
    await observer.initialize();

    const errors: Error[] = [];
    const errorSubscription = observer.errors.subscribe(err => errors.push(err));

    // Without a subscriber the error would also be harmless (typed Subject),
    // unlike EventEmitter 'error' which crashes the process.
    expect(() => observer.tick(-1)).toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('dt');

    errorSubscription.unsubscribe();
    observer.dispose();
  });

  it('stores and recalls memories end-to-end', async () => {
    const observer = new SemanticObserver({ kernel });
    await observer.initialize();

    observer.processInput([2, 3, 5, 7], 0.5);
    observer.tick(0.016);

    const trace = observer.storeMemory('integration memory');
    expect(trace).not.toBeNull();

    const hits = observer.recallMemory(undefined, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].trace.id).toBe(trace!.id);

    // Reinforced by the recall.
    expect(observer.getMemoryBank().get(trace!.id)!.accessCount).toBe(1);
    observer.dispose();
  });

  it('primeCount 32 memories keep all 32 primes in the pattern (no content loss)', async () => {
    const observer = new SemanticObserver({ kernel, primeCount: 32, gridSize: 64 });
    await observer.initialize();

    const allPrimes = kernel.firstNPrimes(32);
    observer.processInput(allPrimes, 0.5);
    observer.tick(0.016);

    const trace = observer.storeMemory('wide-pattern memory');
    expect(trace).not.toBeNull();
    expect(trace!.pattern.primes).toHaveLength(32);
    expect(trace!.primes).toHaveLength(32);

    const hits = observer.getMemoryBank().recall(
      { primes: trace!.primes, amplitudes: trace!.amplitudes },
      5
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].trace.id).toBe(trace!.id);
    expect(hits[0].holographicScore).toBeCloseTo(1, 6);
    observer.dispose();
  });

  it('recallMemory is a pure read: it does not excite the oscillator field', async () => {
    const observer = new SemanticObserver({ kernel });
    await observer.initialize();
    observer.processInput([2, 3, 5], 0.5);
    observer.tick(0.016);

    const before = observer.getState();
    const amplitudesBefore = observer.getOscillatorField().getAmplitudes();
    const phasesBefore = observer.getOscillatorField().getPhases();

    const hits = observer.recallMemory('the observer perceives coherence and time', 5);
    expect(Array.isArray(hits)).toBe(true);

    const after = observer.getState();
    expect(after.tickCount).toBe(before.tickCount);
    expect(after.time).toBe(before.time);
    expect(after.coherence).toBe(before.coherence);
    expect(after.entropy).toBe(before.entropy);
    expect(after.orderParameter).toBe(before.orderParameter);
    expect(after.totalAmplitude).toBe(before.totalAmplitude);
    expect(observer.getOscillatorField().getAmplitudes()).toEqual(amplitudesBefore);
    expect(observer.getOscillatorField().getPhases()).toEqual(phasesBefore);
    observer.dispose();
  });

  it('rejects primeCount >= gridSize at construction with a typed error', () => {
    expect(() => new SemanticObserver({ kernel, primeCount: 32, gridSize: 32 })).toThrow(
      SemanticObserverConfigError
    );
    expect(() => new SemanticObserver({ kernel, primeCount: 64, gridSize: 32 })).toThrow(
      SemanticObserverConfigError
    );
  });

  it('caps primeCount and gridSize at construction with typed errors', () => {
    expect(() => new SemanticObserver({ kernel, primeCount: 300 })).toThrow(ConfigurationLimitError);
    expect(() => new SemanticObserver({ kernel, gridSize: 5000 })).toThrow(ConfigurationLimitError);
    expect(() => new SemanticObserver({ kernel, gridSize: 1e7 })).toThrow(ConfigurationLimitError);
  });

  it('isolates a throwing tick subscriber: siblings still fire and the tick succeeds', async () => {
    const observer = new SemanticObserver({ kernel });
    await observer.initialize();

    let received = 0;
    observer.ticks.subscribe(() => {
      throw new Error('subscriber boom');
    });
    const subscription = observer.ticks.subscribe(() => {
      received += 1;
    });

    const event = observer.tick(0.016);
    expect(event).toBeDefined();
    expect(received).toBe(1);

    subscription.unsubscribe();
    observer.dispose();
  });

  it('a mid-tick failure rolls the observer state back atomically', async () => {
    let allow = false;
    const flakySafety = {
      checkMetrics: () => {
        if (!allow) throw new Error('injected tick failure');
        return { allowed: true, violations: [], evaluated: [], maxSeverity: null };
      }
    } as unknown as SafetyMonitor;
    const observer = new SemanticObserver({ kernel, safety: flakySafety });
    await observer.initialize();

    const errors: Error[] = [];
    const errorSubscription = observer.errors.subscribe(err => errors.push(err));

    observer.processInput([2, 3, 5], 0.5);

    const before = observer.getState();
    const amplitudesBefore = observer.getOscillatorField().getAmplitudes();
    const smfBefore = observer.getMemoryField().toArray();
    const energyBefore = observer.getHologram().energy();

    expect(() => observer.tick(0.016)).toThrow('injected tick failure');
    expect(errors).toHaveLength(1);

    const after = observer.getState();
    expect(after.tickCount).toBe(before.tickCount);
    expect(after.time).toBe(before.time);
    expect(after.momentCount).toBe(before.momentCount);
    expect(after.totalAmplitude).toBe(before.totalAmplitude);
    expect(observer.getOscillatorField().getAmplitudes()).toEqual(amplitudesBefore);
    expect(observer.getMemoryField().toArray()).toEqual(smfBefore);
    expect(observer.getHologram().energy()).toBeCloseTo(energyBefore, 10);

    // The rollback leaves a consistent observer: the next tick is tick #1 and
    // still sees the excitation that was made before the failed tick.
    allow = true;
    const event = observer.tick(0.016);
    expect(event.tick).toBe(1);

    errorSubscription.unsubscribe();
    observer.dispose();
  });

  it('rejects use before initialization', async () => {
    const observer = new SemanticObserver({ kernel });
    expect(() => observer.tick(0.016)).toThrow(/initialize/);
    expect(() => observer.processInput([2])).toThrow(/initialize/);
  });

  it('reset clears runtime state but keeps configuration', async () => {
    const observer = new SemanticObserver({ kernel, momentThreshold: 0.85 });
    await observer.initialize();
    observer.processInput([2, 3], 0.5);
    observer.tick(0.016);
    observer.tick(0.016);

    observer.reset();
    const state = observer.getState();
    expect(state.tickCount).toBe(0);
    expect(state.momentCount).toBe(0);
    expect(state.totalAmplitude).toBe(0);
    expect(state.memoryTraceCount).toBe(0);
    expect(observer.getMomentThreshold()).toBe(0.85);

    observer.dispose();
  });

  it('runs a bounded number of ticks with an early-exit predicate', async () => {
    const observer = new SemanticObserver({ kernel, momentThreshold: 0.5 });
    await observer.initialize();

    // Baseline tick establishes previousCoherence (0, quiescent).
    observer.tick(0.016);

    // Excitation makes the next tick cross the threshold going up.
    observer.processInput([2, 3, 5], 0.5);

    const events = observer.runTicks(50, 0.016, event => event.moment !== null);
    expect(events.length).toBeLessThanOrEqual(50);
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].moment).not.toBeNull();
    observer.dispose();
  });
});
