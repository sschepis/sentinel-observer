/**
 * @jest-environment node
 *
 * SENSE-SPLIT BENCH (Phase F.4, §7.4/§7.5) — sense induction as SPLIT from
 * CONTEXT. The §7.4 proposal: a trace's contexts — the prime sets
 * co-excited with it across its stores and recalls — form a distribution;
 * when that distribution is BIMODAL (two distinguishable context clusters),
 * splitting the trace into two senses reduces the conditional entropy of
 * context given sense, and the split is taken exactly when the reduction
 * exceeds the cost of the new sense node (an MDL gain in the same currency
 * as §9).
 *
 * This bench hides the relation-graph senses (the §7.2 path) and drives the
 * observer with CONTEXT cues drawn from both known senses of a held-out set
 * of polysemous words (bank, bark, crane, mole, organ, spring): each word
 * is taught, then recalled in several two-word context cues per sense
 * ("river water bank", "money teller bank", …). The context-distribution
 * recorder (senseModel.ts §7.4, behind CONTEXT_SENSE_SPLIT_FLAGS) records
 * the co-excited context primes at each store/recall, and the split rule
 * reads the distribution. The measurement: do the induced splits match the
 * known sense sets (precision/recall), and — THE CRITICAL CONTROL — does a
 * monosemous word taught in several SIMILAR contexts (one overlapping
 * context family) fragment? Pass = induced splits match the known senses
 * with 0 splits on the monosemous control; refute = the rule fragments
 * monosemous words, and only supplied senses should be used.
 *
 * The measured outcome is asserted at the end of the measured describe (0
 * control splits, 6/6 known splits recovered, precision 1). The per-word
 * gate readings (bimodality vs. MDL) are logged so a future regression
 * names which gate refused.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import {
  CONTEXT_SENSE_SPLIT_FLAGS,
  ContextSenseRecorder,
  contextSplitDecision,
  resetContextSenseSplitFlags,
  senseNodeCostBits,
  senseNodeSignatureCostBits,
  setContextSenseSplitEnabled,
  type ContextSplitDecision
} from './senseModel';
import { UNKNOWN_TOKEN_COST } from './mdl';
import type { DeckWord } from './deck';

// ── The held-out corpus ─────────────────────────────────────────────────────
// Six KNOWN polysemous words, each with two known sense families of context
// words (WordNet's distinctions, hidden from the rule — the rule sees only
// the recorded context prime sets). Context families of the same word are
// signature-DISJOINT (guarded below): the bench construction is invalid
// if a prime is shared across a word's two families.
const KNOWN_FAMILIES: Readonly<Record<string, readonly [readonly string[], readonly string[]]>> = {
  bank: [['river', 'water', 'shore'], ['money', 'teller', 'deposit']],
  bark: [['tree', 'trunk', 'forest'], ['dog', 'sound', 'noise']],
  crane: [['bird', 'wing', 'pond'], ['machine', 'lift', 'heavy']],
  mole: [['animal', 'tunnel', 'garden'], ['unit', 'amount', 'chemical']],
  organ: [['instrument', 'music', 'pipes'], ['part', 'heart', 'liver']],
  spring: [['season', 'flowers', 'warm'], ['coil', 'metal', 'spiral']]
};

/** The monosemous control: each word has ONE context family whose words all
 *  co-occur across its cues — "several similar contexts" that a real
 *  monosemous word receives and that must NOT fragment into senses. */
const MONOSEMOUS_CONTROLS: Readonly<Record<string, readonly string[]>> = {
  gull: ['coast', 'sea', 'sky'],
  marsh: ['reed', 'bog', 'mud'],
  vault: ['lock', 'steel', 'gold'],
  ledger: ['page', 'column', 'total'],
  flint: ['stone', 'spark', 'hard'],
  linen: ['cloth', 'weave', 'fiber']
};

const TARGETS = Object.keys(KNOWN_FAMILIES);
const CONTROLS = Object.keys(MONOSEMOUS_CONTROLS);

/** Definitions do not participate in the induction measurement (the rule
 *  reads context primes only); the targets carry real glosses for the
 *  record, the context words a labeled placeholder. */
const DECK: readonly DeckWord[] = (() => {
  const seen = new Set<string>();
  const entries: DeckWord[] = [];
  const push = (word: string, definition?: string): void => {
    if (seen.has(word)) return;
    seen.add(word);
    entries.push({
      word,
      definition: definition ?? `a context word of the sense-split bench`,
      example: `The ${word} appears in a context cue.`
    });
  };
  const GLOSSES: Record<string, string> = {
    bank: 'a financial institution that keeps and lends money',
    bark: 'the sharp sound a dog makes',
    crane: 'a tall bird with long legs that wades in water',
    mole: 'a small animal that digs tunnels underground',
    organ: 'a musical instrument with pipes that makes music',
    spring: 'a season of the year when plants begin to grow'
  };
  for (const target of TARGETS) push(target, GLOSSES[target]);
  for (const families of Object.values(KNOWN_FAMILIES)) {
    for (const family of families) for (const word of family) push(word);
  }
  for (const word of CONTROLS) push(word);
  for (const family of Object.values(MONOSEMOUS_CONTROLS)) {
    for (const word of family) push(word);
  }
  return entries;
})();

/** The deployed vocabulary — the same table the session excites. */
const VOCABULARY = deckVocabulary(DECK, PRIME_SPACE);

/** The co-excited context primes of a cue: the context words' signatures,
 *  minus the target word's own primes (the word's own excitation is the
 *  trace, not its context). */
function contextPrimesOf(target: string, contextWords: readonly string[]): number[] {
  const own = new Set(VOCABULARY[target] ?? []);
  const primes: number[] = [];
  for (const word of contextWords) {
    for (const prime of VOCABULARY[word] ?? []) {
      if (!own.has(prime) && !primes.includes(prime)) primes.push(prime);
    }
  }
  return primes;
}

const familyPrimeSet = (target: string, family: readonly string[]): Set<number> =>
  new Set(contextPrimesOf(target, family));

const PAIRS: ReadonlyArray<readonly [number, number]> = [[0, 1], [0, 2], [1, 2]];

// ── Pure unit tests (the cde.test.ts style) ─────────────────────────────────
describe('§7.4 context split rule — pure unit tests', () => {
  afterEach(() => {
    resetContextSenseSplitFlags();
  });

  it('defaults OFF: recording is a no-op and the rule refuses to split', () => {
    expect(CONTEXT_SENSE_SPLIT_FLAGS.enabled).toBe(false);
    const recorder = new ContextSenseRecorder();
    recorder.record('bank', [2, 3, 5, 7]);
    expect(recorder.eventsOf('bank')).toEqual([]);
    expect(recorder.recordedWords()).toEqual([]);
    expect(contextSplitDecision('bank', recorder).split).toBe(false);
  });

  it('records when enabled, and the flag gates the decision', () => {
    setContextSenseSplitEnabled(true);
    const recorder = new ContextSenseRecorder();
    recorder.record('bank', [7, 3, 7, 3, 5]);
    expect(recorder.eventsOf('bank')).toEqual([{ primes: [3, 5, 7] }]);
    recorder.clear();
    expect(recorder.recordedWords()).toEqual([]);
    // Recorded while ON, decided while OFF — the flag gates both ends.
    recorder.record('bank', [2, 3]);
    resetContextSenseSplitFlags();
    expect(contextSplitDecision('bank', recorder).split).toBe(false);
  });

  it('the sense-node cost is the §9 currency: name (unseen token) + signature (a 4-of-P prime selection)', () => {
    const combinations = (n: number): number => (n * (n - 1) * (n - 2) * (n - 3)) / 24;
    expect(senseNodeSignatureCostBits(8)).toBeCloseTo(Math.log2(combinations(8)));
    expect(senseNodeCostBits(256)).toBeCloseTo(UNKNOWN_TOKEN_COST + Math.log2(combinations(256)));
  });

  it('splits a word whose contexts fall into two distinguishable, disjoint families', () => {
    setContextSenseSplitEnabled(true);
    const recorder = new ContextSenseRecorder();
    const familyA = [[2, 3, 5, 7], [11, 13, 17, 19], [23, 29, 31, 37]];
    const familyB = [[41, 43, 47, 53], [59, 61, 67, 71], [73, 79, 83, 89]];
    for (const family of [familyA, familyB]) {
      for (const [i, j] of PAIRS) {
        for (let repeat = 0; repeat < 3; repeat += 1) {
          recorder.record('bank', [...family[i], ...family[j]]);
        }
      }
    }
    const decision = contextSplitDecision('bank', recorder, 256);
    expect(decision.split).toBe(true);
    expect(decision.bimodal).toBe(true);
    expect(decision.gainBits).toBeGreaterThan(0);
    expect(decision.entropyReductionBits).toBeGreaterThan(decision.nodeCostBits);
    // The induced clusters are exactly the two families' prime sets.
    const expected = [new Set(familyA.flat()), new Set(familyB.flat())];
    const clusters = (decision.clusters ?? []).map((cluster) => new Set(cluster));
    expect(clusters).toHaveLength(2);
    expect(
      (clusters[0].size === expected[0].size &&
        [...expected[0]].every((p) => clusters[0].has(p))) ||
      (clusters[0].size === expected[1].size &&
        [...expected[1]].every((p) => clusters[0].has(p)))
    ).toBe(true);
  });

  it('the MDL gate blocks a bimodal but under-evidenced split', () => {
    setContextSenseSplitEnabled(true);
    const recorder = new ContextSenseRecorder();
    const familyA = [[2, 3, 5, 7], [11, 13, 17, 19]];
    const familyB = [[23, 29, 31, 37], [41, 43, 47, 53]];
    for (const [i, j] of PAIRS.slice(0, 1)) {
      for (let repeat = 0; repeat < 2; repeat += 1) {
        recorder.record('bank', [...familyA[i], ...familyA[j]]);
        recorder.record('bank', [...familyB[i], ...familyB[j]]);
      }
    }
    const decision = contextSplitDecision('bank', recorder, 256);
    // Two clean clusters — distinguishable — but the reduction does not yet
    // pay for the new sense node.
    expect(decision.bimodal).toBe(true);
    expect(decision.split).toBe(false);
    expect(decision.gainBits).toBeLessThanOrEqual(0);
    expect(decision.entropyReductionBits).toBeLessThan(decision.nodeCostBits);
  });

  it('does not fragment one overlapping context family (the monosemous signature)', () => {
    setContextSenseSplitEnabled(true);
    const recorder = new ContextSenseRecorder();
    const family = [[2, 3, 5, 7], [11, 13, 17, 19], [23, 29, 31, 37]];
    for (const [i, j] of PAIRS) {
      for (let repeat = 0; repeat < 2; repeat += 1) {
        recorder.record('shore', [...family[i], ...family[j]]);
      }
    }
    const decision = contextSplitDecision('shore', recorder, 256);
    // Every context word co-occurs with every other: no two clusters are
    // distinguishable, so the read is not bimodal and nothing splits.
    expect(decision.split).toBe(false);
    expect(decision.gainBits).toBeLessThanOrEqual(0);
  });
});

// ── The measured bench (§7.5) ───────────────────────────────────────────────
describe('sense-split bench — context bimodality recovers known splits, never fragments the control', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;
  const recorder = new ContextSenseRecorder();
  const decisions = new Map<string, ContextSplitDecision>();

  const recallEvent = (target: string, a: string, b: string): void => {
    const cue = `${a} ${b} ${target}`;
    // The observer really hears the context cue: excite + settle + recall,
    // then record the co-excited context primes of THIS store/recall.
    teacher.exciteAndSettle(cue);
    session.recall(cue, 5);
    recorder.record(target, contextPrimesOf(target, [a, b]));
  };

  beforeAll(async () => {
    setContextSenseSplitEnabled(true);
    session = new ObserverSession(
      {
        primeCount: 64,
        gridSize: 128,
        memoryMode: 'compact',
        smfWidth: 128,
        vocabulary: VOCABULARY
      },
      100
    );
    await session.initialize();
    teacher = new TeacherAgent(session, DECK, null, 1, 0, 7);
    // STORES: teach every word; the teach cue is the bare word, so the
    // recorded store event carries an empty context (ignored by the rule —
    // no co-excited context primes at store time).
    for (const entry of DECK) {
      teacher.teach(entry.word);
      if (TARGETS.includes(entry.word) || CONTROLS.includes(entry.word)) {
        recorder.record(entry.word, []);
      }
    }
    // RECALLS with context cues drawn from BOTH known senses: each sense
    // family's word pairs, three recalls per pair (a realistic
    // several-cues-per-sense exposure).
    for (const [target, [senseA, senseB]] of Object.entries(KNOWN_FAMILIES)) {
      for (const family of [senseA, senseB]) {
        for (const [i, j] of PAIRS) {
          for (let repeat = 0; repeat < 3; repeat += 1) {
            recallEvent(target, family[i], family[j]);
          }
        }
      }
    }
    // The monosemous control: the same cue discipline, ONE context family,
    // two recalls per pair.
    for (const [control, family] of Object.entries(MONOSEMOUS_CONTROLS)) {
      for (const [i, j] of PAIRS) {
        for (let repeat = 0; repeat < 2; repeat += 1) {
          recallEvent(control, family[i], family[j]);
        }
      }
    }
    for (const word of [...TARGETS, ...CONTROLS]) {
      decisions.set(word, contextSplitDecision(word, recorder, PRIME_SPACE.length));
    }
  }, 120000);

  afterAll(() => {
    resetContextSenseSplitFlags();
    session.dispose();
  });

  it('bench construction: each word\'s two known sense families are signature-disjoint', () => {
    for (const [target, [senseA, senseB]] of Object.entries(KNOWN_FAMILIES)) {
      const familyA = familyPrimeSet(target, senseA);
      const familyB = familyPrimeSet(target, senseB);
      const shared = [...familyA].filter((prime) => familyB.has(prime));
      // eslint-disable-next-line no-console
      console.log(`  ${target}: family primes ${familyA.size} / ${familyB.size}, shared ${shared.length}`);
      expect(shared).toEqual([]);
    }
  });

  it('recovers every known split and produces 0 splits on the monosemous control', () => {
    const clustersMatch = (decision: ContextSplitDecision, target: string): boolean => {
      if (!decision.split || decision.clusters === null) return false;
      const families = KNOWN_FAMILIES[target];
      const [f1, f2] = [familyPrimeSet(target, families[0]), familyPrimeSet(target, families[1])];
      const [c1, c2] = decision.clusters;
      const same = (cluster: readonly number[], family: ReadonlySet<number>): boolean =>
        cluster.length === family.size && cluster.every((prime) => family.has(prime));
      return (same(c1, f1) && same(c2, f2)) || (same(c1, f2) && same(c2, f1));
    };

    let matchedKnown = 0;
    // eslint-disable-next-line no-console
    console.log('\nSENSE-SPLIT BENCH — per-word gate readings:');
    for (const target of TARGETS) {
      const decision = decisions.get(target);
      const matched = decision !== undefined && clustersMatch(decision, target);
      if (matched) matchedKnown += 1;
      // eslint-disable-next-line no-console
      console.log(
        `  ${target.padEnd(8)} split=${decision?.split === true ? 'YES' : 'no '}  ` +
        `bimodal=${decision?.bimodal === true ? 'yes' : 'no '}  ` +
        `Δbits=${decision?.entropyReductionBits.toFixed(1) ?? '-'}  ` +
        `node=${decision?.nodeCostBits.toFixed(1) ?? '-'}  ` +
        `gain=${decision?.gainBits.toFixed(1) ?? '-'}  match=${matched}`
      );
    }
    let controlSplits = 0;
    let controlBimodal = 0;
    for (const control of CONTROLS) {
      const decision = decisions.get(control);
      if (decision?.split === true) controlSplits += 1;
      if (decision?.bimodal === true) controlBimodal += 1;
      // eslint-disable-next-line no-console
      console.log(
        `  ${control.padEnd(8)} (control) split=${decision?.split === true ? 'YES' : 'no '}  ` +
        `bimodal=${decision?.bimodal === true ? 'yes' : 'no '}  ` +
        `Δbits=${decision?.entropyReductionBits.toFixed(1) ?? '-'}  ` +
        `gain=${decision?.gainBits.toFixed(1) ?? '-'}`
      );
    }

    const inducedSplits = TARGETS.filter((target) => decisions.get(target)?.split === true).length;
    const totalInduced = inducedSplits + controlSplits;
    const precision = totalInduced === 0 ? 1 : matchedKnown / totalInduced;
    const recall = matchedKnown / TARGETS.length;

    // eslint-disable-next-line no-console
    console.log(
      `SENSE-SPLIT BENCH — induced ${inducedSplits}/${TARGETS.length} known splits, ` +
      `${controlSplits} monosemous-control splits (${controlBimodal} control bimodal reads blocked by the MDL gate), ` +
      `precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)}`
    );

    // THE §7.5 PASS GATE: induced splits match the known senses, with 0
    // splits on the monosemous control. The rule earns its flag exactly
    // when this holds; a control split (or a missed/mismatched known split)
    // is the §7.5 refutation — the context distribution is too noisy to
    // induce senses and only supplied senses should be used.
    expect(controlSplits).toBe(0);
    expect(matchedKnown).toBe(TARGETS.length);
    expect(recall).toBe(1);
    expect(precision).toBe(1);
  });
});
