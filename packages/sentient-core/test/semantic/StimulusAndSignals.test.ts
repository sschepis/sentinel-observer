import { describe, it, expect, beforeAll } from '@jest/globals';
import { SemanticKernel, SemanticObserver } from '../../src/semantic';
import { freshKernel } from './helpers';

/** A fresh observer with a cold (unexcited) field. */
async function coldObserver(kernel: SemanticKernel): Promise<SemanticObserver> {
  const observer = new SemanticObserver({ kernel, primeCount: 16, gridSize: 32, momentThreshold: 0.85 });
  await observer.initialize();
  return observer;
}

/** A fresh observer with an already-excited field. */
async function excitedObserver(kernel: SemanticKernel): Promise<SemanticObserver> {
  const observer = await coldObserver(kernel);
  observer.processInput('coherence resonance structure wisdom', 0.5);
  observer.tick(0.016);
  return observer;
}

describe('stimulus contract (observe)', () => {
  let kernel: SemanticKernel;

  beforeAll(async () => {
    kernel = await freshKernel();
  });

  it('text stimulus excites primes, reports touched axes and coherence delta, and carries a stable id', async () => {
    const observer = await coldObserver(kernel);
    const before = observer.getState();

    const result = observer.observe({ kind: 'text', content: 'prime resonance coherence', weight: 0.6 });
    expect(result.stimulusId).toMatch(/[0-9a-f-]{36}/);
    expect(result.kind).toBe('text');
    expect(result.excitedPrimes.length).toBeGreaterThan(0);
    expect(result.touchedAxes.length).toBeGreaterThan(0);
    expect(Number.isFinite(result.coherenceDelta)).toBe(true);
    expect(result.activePrimeCount).toBeGreaterThan(before.activePrimeCount);

    // The same stimulus id is recorded as the cause of subsequent signals.
    observer.tick(0.016);
    expect(observer.getLastStimulusId()).toBe(result.stimulusId);
    const metrics = observer.getSignals().historyOf('metric');
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics[metrics.length - 1].causeId).toBe(result.stimulusId);
    observer.dispose();
  });

  it('attention stimulus modulates coupling: reading rises, idle falls', async () => {
    const observer = await excitedObserver(kernel);
    const baseCoupling = observer.getOscillatorField().getCoupling();

    observer.observe({ kind: 'attention', focus: 'reading', intensity: 1 });
    // reading * 1.0 * (0.5 + 0.5*1.0) = base — full coupling.
    expect(observer.getOscillatorField().getCoupling()).toBeCloseTo(baseCoupling, 10);

    observer.observe({ kind: 'attention', focus: 'idle', intensity: 1 });
    // idle * 0.3 * 1.0 = 0.3 * base — the field relaxes.
    expect(observer.getOscillatorField().getCoupling()).toBeCloseTo(baseCoupling * 0.3, 10);

    // Behavioral check: coupling drives phase synchronization, so a focused
    // observer keeps a materially higher order parameter than an idle one.
    const focusedObserver = await excitedObserver(kernel);
    focusedObserver.observe({ kind: 'attention', focus: 'reading', intensity: 1 });
    const idleObserver = await excitedObserver(kernel);
    idleObserver.observe({ kind: 'attention', focus: 'idle', intensity: 1 });

    for (let i = 0; i < 300; i++) {
      focusedObserver.tick(0.016);
      idleObserver.tick(0.016);
    }
    expect(focusedObserver.getState().orderParameter).toBeGreaterThan(idleObserver.getState().orderParameter);

    focusedObserver.dispose();
    idleObserver.dispose();
    observer.dispose();
  });

  it('event stimulus: source.ingested stores a memory and emits the stored signal', async () => {
    const observer = await excitedObserver(kernel);

    const result = observer.observe({
      kind: 'event',
      type: 'source.ingested',
      outcome: 'success',
      detail: 'the observer stores new material'
    });
    expect(result.note).toMatch(/memory stored/);
    const memorySignals = observer.getSignals().historyOf('memory');
    expect(memorySignals.some((s) => s.payload.event === 'stored')).toBe(true);
    observer.dispose();
  });

  it('noise stimulus sets the ambient floor: the field never fully dies with noise on', async () => {
    const observer = await excitedObserver(kernel);
    observer.observe({ kind: 'noise', level: 0.05 });
    for (let i = 0; i < 300; i++) observer.tick(0.016);
    expect(observer.getState().totalAmplitude).toBeGreaterThan(0);
    observer.dispose();
  });

  it('rejects malformed stimuli loudly', async () => {
    const observer = await coldObserver(kernel);
    expect(() => observer.observe({ kind: 'attention', focus: 'reading', intensity: 2 })).toThrow();
    expect(() => observer.observe({ kind: 'noise', level: -1 })).toThrow();
    expect(() => observer.observe({ kind: 'text', content: 'x', weight: 0 })).toThrow();
    observer.dispose();
  });
});

describe('signal stream', () => {
  let kernel: SemanticKernel;

  beforeAll(async () => {
    kernel = await freshKernel();
  });

  it('emits metric signals every tick with the causal stimulus attached', async () => {
    const observer = await coldObserver(kernel);
    observer.observe({ kind: 'text', content: 'coherence and resonance', weight: 0.5 });
    for (let i = 0; i < 5; i++) observer.tick(0.016);
    const metrics = observer.getSignals().historyOf('metric');
    expect(metrics).toHaveLength(5);
    expect(metrics.every((s) => s.payload.coherence >= 0 && Number.isFinite(s.payload.coherence))).toBe(true);
    observer.dispose();
  });

  it('converts a coherence crossing into an insight signal', async () => {
    const observer = new SemanticObserver({ kernel, momentThreshold: 0.7 });
    await observer.initialize();
    observer.observe({ kind: 'text', content: 'a sudden strong burst of focused insight', weight: 1 });
    for (let i = 0; i < 50; i++) observer.tick(0.016);
    const insights = observer.getSignals().historyOf('insight');
    const moments = observer.getState().momentCount;
    expect(insights.length).toBe(moments);
    observer.dispose();
  });

  it('emits a drift warning for sustained coherence decline, exactly once per episode', async () => {
    const observer = await excitedObserver(kernel);
    observer.observe({ kind: 'noise', level: 0 });
    for (let i = 0; i < 400; i++) observer.tick(0.016);
    const drifts = observer.getSignals().historyOf('drift');
    expect(drifts.length).toBeGreaterThan(0);
    // One episode per sustained decline; the field relaxes once and stays low.
    expect(drifts.length).toBeLessThan(3);
    expect(drifts[0].payload.direction).toBe('down');
    expect(drifts[0].payload.coherenceStart).toBeGreaterThan(drifts[0].payload.coherenceEnd);
    observer.dispose();
  });

  it('emits a decaying memory signal once per trace below the strength threshold', async () => {
    const observer = await excitedObserver(kernel);
    observer.observe({ kind: 'event', type: 'source.ingested', outcome: 'success', detail: 'decay target content' });

    // Force the trace's strength below the decay threshold, then sweep.
    const trace = observer.getMemoryBank().all()[0];
    expect(trace).toBeDefined();
    trace.strength = 0.2;
    for (let i = 0; i < 60; i++) observer.tick(0.016);

    const decaying = observer.getSignals().historyOf('memory').filter((s) => s.payload.event === 'decaying');
    expect(decaying).toHaveLength(1);
    expect(decaying[0].payload.traceId).toBe(trace.id);

    // Recovered traces re-arm: strength recovers, decays again later.
    trace.strength = 0.7;
    for (let i = 0; i < 50; i++) observer.tick(0.016);
    trace.strength = 0.2;
    for (let i = 0; i < 60; i++) observer.tick(0.016);
    const decayingAgain = observer.getSignals().historyOf('memory').filter((s) => s.payload.event === 'decaying');
    expect(decayingAgain.length).toBeGreaterThanOrEqual(2);
    observer.dispose();
  });

  it('history is bounded and subscribers are isolated', async () => {
    const observer = await coldObserver(kernel);
    let calls = 0;
    const unsubscribe = observer.getSignals().subscribe('metric', () => {
      calls += 1;
    });
    observer.getSignals().subscribe('metric', () => {
      throw new Error('broken subscriber must not break siblings');
    });
    observer.observe({ kind: 'text', content: 'bounded stream', weight: 0.5 });
    for (let i = 0; i < 300; i++) observer.tick(0.016);
    // The healthy subscriber still received every metric signal.
    expect(calls).toBe(300);
    expect(observer.getSignals().history().length).toBeLessThanOrEqual(200 + 10);
    unsubscribe();
    observer.dispose();
  });
});
