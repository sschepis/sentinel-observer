/**
 * SPARSE EXCITATION (`excitationTopK`) — the contract of the opt-in.
 *
 * The option is a physics experiment knob (docs/SCALING.md §17), so the
 * properties that matter are exactly the ones an experiment needs:
 *
 *   - OFF BY DEFAULT and bit-identical to the control when unset;
 *   - DETERMINISTIC: same stimulus -> same primes, every time, in any
 *     observer instance;
 *   - CONTENT-DERIVED: the surviving primes are the stimulus's own
 *     highest-signature-mass primes, not a positional or random slice;
 *   - SYMMETRIC: the same selection encodes the stored side and the cue
 *     side, so an arm differs from the control in sparsity alone;
 *   - LOUD on a bad budget rather than silently clamped.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { NonFiniteValueError, SemanticKernel, SemanticObserver } from '../../src/semantic';
import { freshKernel } from './helpers';

/** A vocabulary whose signatures are explicit, so the selection is auditable. */
const VOCABULARY: Record<string, number[]> = {
  // 'alpha' and 'beta' share 2 and 3; 'gamma' shares nothing.
  alpha: [2, 3, 5, 7],
  beta: [2, 3, 11, 13],
  gamma: [17, 19, 23, 29],
  delta: [31, 37, 41, 43],
  epsilon: [47, 53, 59, 61]
};

describe('SemanticObserver excitationTopK', () => {
  let kernel: SemanticKernel;

  beforeAll(async () => {
    kernel = await freshKernel();
  });

  const makeObserver = async (excitationTopK?: number): Promise<SemanticObserver> => {
    const observer = new SemanticObserver({
      kernel,
      primeCount: 64,
      gridSize: 128,
      vocabulary: VOCABULARY,
      ...(excitationTopK !== undefined ? { excitationTopK } : {})
    });
    await observer.initialize();
    return observer;
  };

  it('is OFF by default: the control encodes every stimulus prime', async () => {
    const control = await makeObserver();
    // 5 words x 4 primes, all distinct except the 2/3 shared by alpha+beta.
    const primes = control.processInput('alpha beta gamma delta epsilon');
    expect(primes).toHaveLength(18);
    expect(new Set(primes).size).toBe(18);
  });

  it('caps a stimulus at k primes when set', async () => {
    for (const k of [2, 4, 8, 16]) {
      const observer = await makeObserver(k);
      const primes = observer.processInput('alpha beta gamma delta epsilon');
      expect(primes.length).toBe(Math.min(k, 18));
      expect(new Set(primes).size).toBe(primes.length);
    }
  });

  it('leaves a stimulus that is already sparser than k untouched (as a SET)', async () => {
    const control = await makeObserver();
    const sparse = await makeObserver(32);
    const a = control.processInput('alpha beta');
    const b = sparse.processInput('alpha beta');
    expect(new Set(b)).toEqual(new Set(a));
  });

  it('selects by CONTENT: the primes several tokens agree on survive first', async () => {
    // 'alpha beta' emits 2,3 twice each and 5,7,11,13 once each. At k=2 the
    // only honest answer is the pair the two words share.
    const observer = await makeObserver(2);
    expect(observer.processInput('alpha beta').sort((x, y) => x - y)).toEqual([2, 3]);
  });

  it('is DETERMINISTIC across calls and across instances', async () => {
    const text = 'alpha beta gamma delta epsilon alpha gamma';
    const first = await makeObserver(6);
    const second = await makeObserver(6);
    const a = first.processInput(text);
    const b = first.processInput(text);
    const c = second.processInput(text);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('never invents a prime outside the basis', async () => {
    const observer = await makeObserver(8);
    const basis = observer.getOscillatorField().primes;
    const primes = observer.processInput('alpha beta gamma delta epsilon');
    expect(primes.every(p => basis.includes(p))).toBe(true);
  });

  it('applies to the RECALL cue as well as the stored side', async () => {
    const observer = await makeObserver(2);
    observer.processInput('alpha beta gamma delta epsilon');
    observer.tick(0.02);
    const stored = observer.storeMemory('sparse trace');
    expect(stored).not.toBeNull();

    // The cue is encoded by the same rule, so recall stays reachable: a
    // one-sided sparsification would have starved the overlap term.
    const hits = observer.recallMemory('alpha beta gamma delta epsilon', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].trace.id).toBe(stored!.id);
  });

  it('makes the excited field measurably sparser than the control', async () => {
    const text = 'alpha beta gamma delta epsilon';
    const control = await makeObserver();
    const sparse = await makeObserver(4);
    for (const observer of [control, sparse]) {
      observer.settleField();
      observer.processInput(text);
      observer.tick(0.02);
    }
    const controlActive = control.getOscillatorField().getState().activePrimes.length;
    const sparseActive = sparse.getOscillatorField().getState().activePrimes.length;
    expect(controlActive).toBe(18);
    expect(sparseActive).toBe(4);
  });

  it('refuses a budget that is not a usable count', async () => {
    for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new SemanticObserver({ kernel, excitationTopK: bad })).toThrow(NonFiniteValueError);
    }
  });

  it('accepts a direct prime array on the same contract', async () => {
    const observer = await makeObserver(3);
    // 2 appears three times, 3 twice, the rest once: weight ranks 2 then 3,
    // then first appearance breaks the remaining tie (5 before 7).
    const primes = observer.processInput([2, 3, 5, 7, 2, 3, 2]);
    expect(primes).toEqual([2, 3, 5]);
  });
});
