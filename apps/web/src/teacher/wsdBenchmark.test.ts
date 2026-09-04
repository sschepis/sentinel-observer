/**
 * @jest-environment node
 *
 * WSD BENCH (Phase F.3, §7.3) — Hebbian coupling as word-sense
 * disambiguation, MEASURED. No production code changes: this file exercises
 * the shipped `hebbian` observer option (Phase 23, default OFF) against the
 * shipped `senseSplit` teacher flag (F.2).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FINDINGS NOTE (recorded against base main @ 8cd4fb5, the 64-prime
 * controlled setting below):
 *
 * THE VERDICT IS REFUTATION — the coupling is NOT doing disambiguation at
 * this scale, and the flag stays off (the paper's condition).
 *
 *   · Chance baseline (flag OFF): 6/12 cues resolved by the raw phase-lock
 *     readout — exactly chance, confirming "signatures are per-sense and
 *     nothing else disambiguates".
 *   · Flag ON, production settle (the teacher's RECALL_SETTLE_STEPS × 0.05
 *     converged moment): 6/12 — no gain over chance.
 *   · Flag ON, extended settle (20× longer): 6/12 — no gain.
 *   · Heavy gates with the flag ON: 0 confident cross-sense "Yes" on the
 *     fuzz-style is-a distractors, honesty probes held (0 fabrications,
 *     0 false "Yes", 0 false "No", unknown words asked) — no gate
 *     regression, the flag is safe wherever it is; it just does not
 *     disambiguate.
 *
 * WHY (measured, not assumed): the wiring engaged for real — the ON arm
 * fired 155 coherent moments through the observer's own moment detection
 * and the context↔sense coupling reached ~89% of its kMax ceiling (170 of
 * 192 pair-units) — yet the moment's phase-lock differential between the
 * intended sense and the other sense moves by only ~1e-3 at the production
 * settle (up to ~0.09 on the extended settle, in BOTH directions). The
 * learned pairwise pull enters the phase sweep at weight kij·K/(n·rowMean)
 * ≈ 1/N relative to the global field, so it cannot dominate the
 * deterministic natural-frequency dispersion of an 8-prime cue in a
 * 64-oscillator field: the resolution is decided by the frequency
 *   configuration, not by the wiring. The phase-lock tightening H6 measured
 *   at 16 primes does not scale into disambiguation of per-sense signatures
 *   here. §7.3's experiment is answered in the negative for this
 *   configuration; the flag remains a Phase-23 experiment, OFF.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE CLAIM (§7.3)
 *
 *   "river co-excited with bank#1 in past moments wires their oscillators;
 *    when 'river bank' arrives, bank#1's oscillators are pulled into phase
 *    by river's and bank#2's are not, so the moment converges to the river
 *    sense before any symbolic layer acts."
 *
 * With the flag OFF the signatures are per-sense and NOTHING else
 * disambiguates — the chance baseline. Pass: accuracy ≫ chance with the
 * flag on AND the heavy gates holding (fuzz-style distractors → 0 confident
 * wrong-sense answers, honesty probes held). Refute: no gain, or any
 * heavy-gate regression — then the coupling is not doing disambiguation and
 * the flag stays off (the paper's condition).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PROTOCOL
 *
 * Deck: the six polysemy probe words (bank, bark, crane, mole, organ,
 * spring — polysemyProbes.ts) with their definitional sense plus a
 * chaperone-supplied second sense, taught under senseSplit so each sense is
 * its own node with its own four-prime signature (senseModel.ts). Context
 * words are vocabulary entries (river/money, tree/dog, bird/construction,
 * animal/chemical, music/body, season/coil); the surface word's vocabulary
 * entry is the UNION of its senses' primes.
 *
 * WIRING (ON arm only): the production moment path — for each contexted
 * cue, the context word's primes are co-excited with the INTENDED sense
 * node's primes and ticked; the observer's own moment detection
 * (coherence crossing the threshold upward) potentiates the co-excited
 * winners, wiring context ↔ intended sense exactly as §7.3 describes. The
 * OFF arm runs the identical schedule with the flag off (the control).
 *
 * MEASUREMENT: for each cue the converged moment is produced exactly like
 * the teacher's recall settle (settle → excite "context word" → one 0.02
 * tick → RECALL_SETTLE_STEPS × 0.05). The moment's phase configuration is
 * read from the oscillator field (getOscillatorField — the shipped bench
 * surface). Two lock statistics per sense:
 *   · raw gap — the mean resultant length of the phase-difference ensemble
 *     between the context's primes and the sense's primes;
 *   · co-rotating gap (§4.2) — the same ensemble with each oscillator's
 *     free drift ω·t stripped (θ_i = φ_i − ω_i·t), isolating what COUPLING
 *     contributed during the moment.
 * Because the natural-frequency configuration deterministically biases the
 * raw gap, the resolution statistic is the PAIRED gain: Δ_s = gap_s(ON) −
 * gap_s(OFF) per sense, and the resolved sense is argmax_s Δ_s — the
 * coupling's marginal phase-lock contribution beyond the control. The OFF
 * arm resolves by its raw gap (the "nothing disambiguates" readout — the
 * chance baseline §7.3 names).
 *
 * The wiring schedule starts from the teaching state's high coherence, so
 * the first round is a burn-in (no moment) that decays coherence below the
 * moment threshold; every later round fires exactly one moment on its first
 * tick. Measurement trials are preceded by a two-tick hygiene settle so the
 * measurement moment itself does not fire (a fired moment would
 * symmetrically potentiate context ↔ both senses and dilute the wiring's
 * asymmetry) — measurement hygiene only, no production behavior involved.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { claimsRelationalYes, outOfVocabulary, responseContentWords } from './adversarial';
import { PRIME_SPACE, deckVocabulary, primeSignature } from './primeSignature';
import { BOOTSTRAP_VERSION, BOOTSTRAP_VOCABULARY_SCHEME, type BootstrapRecord } from './bootstrap';
import {
  isAParentsOf,
  wordsWithUnrelatedIsAParents,
  isAQuestion
} from './polysemyProbes';
import {
  assignSenses,
  mergedGraphFor,
  reservedSignatureKeys,
  senseVocabulary,
  senseKeyOf,
  type SenseAssignment
} from './senseModel';
import type { Relation } from './relations';
import type { DeckWord } from './deck';

// ────────────────────────────────────────────────────────────────────────────
// The deck: six polysemous words (definitional sense = reading #1) + the
// support words their senses and the gate probes need.
// ────────────────────────────────────────────────────────────────────────────
const DECK: readonly DeckWord[] = [
  { word: 'bank', definition: 'a financial institution that keeps and lends money', example: 'The bank keeps my money.' },
  { word: 'institution', definition: 'an organization that serves a public purpose', example: 'A school is an institution.' },
  { word: 'slope', definition: 'a surface that slants up or down', example: 'The hill has a slope.' },
  { word: 'spring', definition: 'a season of the year when plants begin to grow', example: 'Flowers bloom in spring.' },
  { word: 'season', definition: 'a division of the year with its own weather', example: 'Winter is a cold season.' },
  { word: 'coil', definition: 'a series of rings wound into a spiral', example: 'A spring is a metal coil.' },
  { word: 'bark', definition: 'the hard outer layer of a tree', example: 'The tree has rough bark.' },
  { word: 'layer', definition: 'a flat sheet that lies over something', example: 'The cake has a top layer.' },
  { word: 'sound', definition: 'a noise that can be heard', example: 'The bell makes a sound.' },
  { word: 'mole', definition: 'a small animal that digs tunnels underground', example: 'The mole digs in the garden.' },
  { word: 'animal', definition: 'a living thing that can move and feel', example: 'A dog is an animal.' },
  { word: 'unit', definition: 'a fixed amount used for measuring', example: 'A meter is a unit of length.' },
  { word: 'organ', definition: 'a musical instrument with pipes that makes music', example: 'The organ plays in the church.' },
  { word: 'instrument', definition: 'a tool made for making music', example: 'The piano is an instrument.' },
  { word: 'part', definition: 'a piece of a larger whole', example: 'The wheel is a part of the car.' },
  { word: 'crane', definition: 'a tall bird with long legs that wades in water', example: 'The crane stands by the pond.' },
  { word: 'bird', definition: 'an animal with wings and feathers', example: 'The bird sings.' },
  { word: 'machine', definition: 'a device with moving parts that does work', example: 'The machine lifts heavy loads.' }
];

/** Secondary (chaperone-supplied) senses — the cross-sense is-a parents. */
const CHAPERONE_SENSES: readonly Relation[] = [
  { subject: 'bank', predicate: 'is-a', object: 'slope', source: 'sloping land beside a body of water', origin: 'chaperone' },
  { subject: 'spring', predicate: 'is-a', object: 'coil', source: 'a wound metal device that returns to shape', origin: 'chaperone' },
  { subject: 'bark', predicate: 'is-a', object: 'sound', source: 'the sharp sound a dog makes', origin: 'chaperone' },
  { subject: 'mole', predicate: 'is-a', object: 'unit', source: 'a chemical unit of amount', origin: 'chaperone' },
  { subject: 'organ', predicate: 'is-a', object: 'part', source: 'a part of the body that does a job', origin: 'chaperone' },
  { subject: 'crane', predicate: 'is-a', object: 'machine', source: 'a machine that lifts and moves heavy things', origin: 'chaperone' }
];

/** Context words: pure vocabulary entries (not deck words — no traces, no
 *  authored edges; they only supply the context excitation the cues name). */
const CONTEXT_WORDS: readonly string[] = [
  'river', 'money', 'tree', 'dog', 'construction', 'chemical', 'music', 'body'
];

/**
 * The contexted cues. `parent` is the intended sense's direct is-a parent —
 * the reading index is derived from the minted assignment, never hand-set.
 * Six cues target the definitional (regex) reading and six the chaperone
 * reading, so an index bias cannot fake accuracy.
 */
interface Cue {
  word: string;
  context: string;
  parent: string;
}
const CUES: readonly Cue[] = [
  { word: 'bank', context: 'money', parent: 'institution' },
  { word: 'bank', context: 'river', parent: 'slope' },
  { word: 'bark', context: 'tree', parent: 'layer' },
  { word: 'bark', context: 'dog', parent: 'sound' },
  { word: 'crane', context: 'bird', parent: 'bird' },
  { word: 'crane', context: 'construction', parent: 'machine' },
  { word: 'mole', context: 'animal', parent: 'animal' },
  { word: 'mole', context: 'chemical', parent: 'unit' },
  { word: 'organ', context: 'music', parent: 'instrument' },
  { word: 'organ', context: 'body', parent: 'part' },
  { word: 'spring', context: 'season', parent: 'season' },
  { word: 'spring', context: 'coil', parent: 'coil' }
];

// ────────────────────────────────────────────────────────────────────────────
// Experiment constants
// ────────────────────────────────────────────────────────────────────────────
/** The production recall settle: one 0.02 tick + 4 × 0.05 (support.ts
 *  RECALL_SETTLE_STEPS / SETTLE_DT — the converged moment the recall layer
 *  reads). */
const PRODUCTION_SETTLE = { firstDt: 0.02, steps: 4, dt: 0.05 };
/** The extended settle — the same settle run longer, a sensitivity reading
 *  for the phase-lock differential beyond the production window. */
const EXTENDED_SETTLE = { firstDt: 0.02, steps: 40, dt: 0.05 };
/** Wiring rounds per cue (round 1 is the burn-in that decays coherence
 *  below the moment threshold; every later round fires one moment). */
const WIRING_ROUNDS = 13;
/** The active-amplitude gate the field itself uses (activeThreshold). */
const ACTIVE_AMP = 0.05;

function setupOptions(
  hebbian: boolean,
  vocabulary: Record<string, readonly number[]>
) {
  return {
    primeCount: 64,
    gridSize: 128,
    memoryMode: 'compact' as const,
    smfWidth: 128,
    hebbian: hebbian ? { enabled: true, eta: 0.3, kMax: 1 } : undefined,
    vocabulary
  };
}

interface Arm {
  session: ObserverSession;
  teacher: TeacherAgent;
  assignment: SenseAssignment;
  vocabulary: Record<string, readonly number[]>;
}

describe('wsd-bench (§7.3) — Hebbian coupling as word-sense disambiguation', () => {
  let assignment: SenseAssignment;
  let off: Arm;
  let on: Arm;

  const baseVocabulary = (): Record<string, number[]> => deckVocabulary(DECK, PRIME_SPACE);

  beforeAll(async () => {
    assignment = assignSenses(
      mergedGraphFor(
        DECK.map((d) => ({ word: d.word, definition: d.definition })),
        new Set(DECK.map((d) => d.word)),
        CHAPERONE_SENSES
      ),
      PRIME_SPACE,
      reservedSignatureKeys(baseVocabulary())
    );
  }, 120000);

  const buildArm = async (hebbian: boolean): Promise<Arm> => {
    const vocabulary = senseVocabulary(baseVocabulary(), assignment);
    for (const word of CONTEXT_WORDS) vocabulary[word] = primeSignature(word);
    const session = new ObserverSession(setupOptions(hebbian, vocabulary), 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK, null, 1, 0, 7, undefined, undefined, undefined, false, { assignment });
    // Split-era teaching order: the chaperone senses arrive BEFORE teaching,
    // so teach stores one trace PER SENSE (the polysemyProbeSet discipline).
    const record: BootstrapRecord = {
      version: BOOTSTRAP_VERSION,
      vocabularyScheme: BOOTSTRAP_VOCABULARY_SCHEME,
      deck: 'wsd-bench',
      generatedAt: new Date().toISOString(),
      source: { words: DECK.map((d) => d.word), conversation: false, definitionsFilled: true },
      traces: [],
      wordStates: [],
      definitions: DECK.map((d) => ({ word: d.word, definition: d.definition, example: d.example })),
      relations: CHAPERONE_SENSES.map((r) => ({ ...r }))
    };
    teacher.importBootstrap(record);
    for (const entry of DECK) teacher.teach(entry.word);
    return { session, teacher, assignment, vocabulary };
  };

  /** The intended sense node key for a cue, derived from the assignment. */
  const intendedSenseKey = (cue: Cue): string => {
    const readings = assignment.readingsOf.get(cue.word);
    if (readings === undefined) throw new Error(`wsd-bench: ${cue.word} has no readings`);
    const index = readings.findIndex((r) => r.parents.includes(cue.parent));
    if (index === -1) throw new Error(`wsd-bench: ${cue.word} has no reading with parent ${cue.parent}`);
    return senseKeyOf(cue.word, index + 1);
  };

  /** Wire context ↔ intended sense through the production moment path. */
  const wireCue = (arm: Arm, cue: Cue): void => {
    const senseKey = intendedSenseKey(cue);
    const contextPrimes = arm.vocabulary[cue.context];
    const sensePrimes = arm.assignment.signatures[senseKey];
    for (let round = 0; round < WIRING_ROUNDS; round += 1) {
      arm.session.settleField();
      arm.session.observer.processInput([...contextPrimes, ...sensePrimes], 1.0);
      // Decay ticks after the moment tick: the field's coherence falls
      // monotonically from ~1 after excitation (the quiescent mass pins the
      // mean phase), so ending each round BELOW the moment threshold makes
      // the next round's first tick cross it going up — exactly one moment
      // per round, wired by the observer's own moment detection.
      arm.session.observer.runTicks(120, 0.02);
    }
  };

  /** Produce the converged moment for a cue, then read the phase-lock
   *  statistics of each sense against the context. Mirrors the teacher's
   *  exciteAndSettle settle exactly. */
  const measureCue = (arm: Arm, cue: Cue, settle: { firstDt: number; steps: number; dt: number }) => {
    const senseKey = intendedSenseKey(cue);
    const otherKey = assignment.readingsOf.get(cue.word)!.map((r) => r.key).find((k) => k !== senseKey)!;
    // Measurement hygiene: end the PREVIOUS trial at high coherence so the
    // measurement settle itself fires no moment (a fired moment would wire
    // context ↔ both senses symmetrically and dilute the wiring).
    arm.session.settleField();
    arm.session.observeText(`${cue.context} ${cue.word}`);
    arm.session.observer.runTicks(2, 0.05);
    // The measurement trial itself.
    arm.session.settleField();
    arm.session.observeText(`${cue.context} ${cue.word}`);
    arm.session.observer.tick(settle.firstDt);
    arm.session.observer.runTicks(settle.steps, settle.dt);

    const field = arm.session.observer.getOscillatorField();
    const state = field.getState();
    const frequencies = arm.session.observer.getNaturalFrequencies();
    const time = state.time;
    // Vocabulary primes live in the 256-prime space; the observer FOLDS each
    // into the 64-prime field basis (rank mod N) before exciting it — the
    // readout must read the same folded oscillator (indexOfPrime rejects
    // out-of-basis primes with -1).
    const basisLength = field.primes.length;
    const fold = (p: number): number => field.primes[PRIME_SPACE.indexOf(p) % basisLength];
    const phasesOf = (primes: readonly number[]): number[] => {
      const out: number[] = [];
      for (const raw of primes) {
        const idx = field.indexOfPrime(fold(raw));
        if (idx < 0) continue;
        if (state.amplitudes[idx] < ACTIVE_AMP) continue;
        out.push(state.phases[idx]);
      }
      return out;
    };
    const thetasOf = (primes: readonly number[]): number[] => {
      const out: number[] = [];
      for (const raw of primes) {
        const idx = field.indexOfPrime(fold(raw));
        if (idx < 0) continue;
        if (state.amplitudes[idx] < ACTIVE_AMP) continue;
        out.push(state.phases[idx] - frequencies[idx] * time);
      }
      return out;
    };
    // The mean resultant length of the phase-DIFFERENCE ensemble between two
    // phase lists — the Kuramoto order parameter of the two sets locking
    // against each other.
    const gap = (a: number[], b: number[]): number => {
      if (a.length === 0 || b.length === 0) return 0;
      let sx = 0;
      let sy = 0;
      for (const x of a) {
        for (const y of b) {
          sx += Math.cos(x - y);
          sy += Math.sin(x - y);
        }
      }
      return Math.hypot(sx, sy) / (a.length * b.length);
    };
    const contextRaw = arm.vocabulary[cue.context];
    const intendedRaw = arm.assignment.signatures[senseKey];
    const otherRaw = arm.assignment.signatures[otherKey];
    const contextPhases = phasesOf(contextRaw);
    const contextThetas = thetasOf(contextRaw);
    return {
      rawIntended: gap(contextPhases, phasesOf(intendedRaw)),
      rawOther: gap(contextPhases, phasesOf(otherRaw)),
      thetaIntended: gap(contextThetas, thetasOf(intendedRaw)),
      thetaOther: gap(contextThetas, thetasOf(otherRaw)),
      coherence: state.coherence
    };
  };

  beforeAll(async () => {
    off = await buildArm(false);
    on = await buildArm(true);
    for (const cue of CUES) wireCue(on, cue);
  }, 300000);

  afterAll(() => {
    off.session.dispose();
    on.session.dispose();
  });

  it('the split population is the six polysemy probe words', () => {
    const exposed = wordsWithUnrelatedIsAParents(off.teacher.unsplitRelations());
    expect(exposed).toEqual(['bank', 'bark', 'crane', 'mole', 'organ', 'spring']);
    expect(assignment.readingsOf.size).toBe(6);
  });

  // ── THE MEASUREMENT ──────────────────────────────────────────────────────
  it('measures sense resolution with the coupling OFF (chance) and ON', () => {
    // Wiring telemetry: the ON arm must have wired through the production
    // moment path (the OFF arm must have nothing).
    const onField = on.session.observer.getOscillatorField();
    const offField = off.session.observer.getOscillatorField();
    const momentDelta = on.session.observer.getState().momentCount - off.session.observer.getState().momentCount;
    let wiredPairMass = 0;
    const basisLength = onField.primes.length;
    for (const cue of CUES) {
      const senseKey = intendedSenseKey(cue);
      const contextPrimes = on.vocabulary[cue.context];
      const sensePrimes = on.assignment.signatures[senseKey];
      for (const c of contextPrimes) {
        for (const s of sensePrimes) {
          wiredPairMass += onField.hebbianCouplingOf(
            onField.primes[PRIME_SPACE.indexOf(c) % basisLength],
            onField.primes[PRIME_SPACE.indexOf(s) % basisLength]
          );
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `WSD BENCH — wiring telemetry: moments +${momentDelta}, pairs ON ${onField.hebbianPairCount()} ` +
        `(OFF ${offField.hebbianPairCount()}), cue wiring mass ${wiredPairMass.toFixed(1)} ` +
        `(saturated = ${(CUES.length * 16).toFixed(0)})`
    );
    const rows: string[] = [];
    let offCorrect = 0;
    let onCorrectProduction = 0;
    let onCorrectExtended = 0;
    let ties = 0;
    const perWord = new Map<string, { off: number; on: number; total: number }>();

    for (const cue of CUES) {
      const offReading = measureCue(off, cue, PRODUCTION_SETTLE);
      const offExtended = measureCue(off, cue, EXTENDED_SETTLE);
      const onReading = measureCue(on, cue, PRODUCTION_SETTLE);
      const onExtended = measureCue(on, cue, EXTENDED_SETTLE);
      // OFF: the raw-gap readout with nothing disambiguating (the chance
      // baseline). ON: the paired co-rotating gain Δ_s = gap_s(ON) − gap_s(OFF)
      // — the coupling's marginal phase-lock contribution.
      const offResolved = offReading.rawIntended > offReading.rawOther;
      const deltaIntended = onReading.thetaIntended - offReading.thetaIntended;
      const deltaOther = onReading.thetaOther - offReading.thetaOther;
      const deltaExtendedIntended = onExtended.thetaIntended - offExtended.thetaIntended;
      const deltaExtendedOther = onExtended.thetaOther - offExtended.thetaOther;
      const productionResolved = deltaIntended > deltaOther;
      const extendedResolved = deltaExtendedIntended > deltaExtendedOther;
      const tie = Math.abs(deltaIntended - deltaOther) < 1e-6;
      if (offResolved) offCorrect += 1;
      if (productionResolved) onCorrectProduction += 1;
      if (extendedResolved) onCorrectExtended += 1;
      if (tie) ties += 1;
      const wordRow = perWord.get(cue.word) ?? { off: 0, on: 0, total: 0 };
      wordRow.total += 1;
      if (offResolved) wordRow.off += 1;
      if (productionResolved) wordRow.on += 1;
      perWord.set(cue.word, wordRow);
      rows.push(
        `${cue.context} ${cue.word}`.padEnd(18) +
          `raw OFF ${offReading.rawIntended.toFixed(4)}/${offReading.rawOther.toFixed(4)} ` +
          `θ ON Δ ${deltaIntended >= 0 ? '+' : ''}${deltaIntended.toFixed(5)} / ${deltaOther >= 0 ? '+' : ''}${deltaOther.toFixed(5)} ` +
          `(ext ${deltaExtendedIntended >= 0 ? '+' : ''}${deltaExtendedIntended.toFixed(5)} / ${deltaExtendedOther >= 0 ? '+' : ''}${deltaExtendedOther.toFixed(5)}) ` +
          `coh ${onReading.coherence.toFixed(3)}` +
          `${offResolved ? ' ✓off' : ''}${productionResolved ? ' ✓on' : ''}${extendedResolved ? ' ✓ext' : ''}${tie ? ' (tie)' : ''}`
      );
    }
    // eslint-disable-next-line no-console
    console.log(`\nWSD BENCH — ${CUES.length} contexted cues\n  ${rows.join('\n  ')}`);
    // eslint-disable-next-line no-console
    console.log(
      `WSD BENCH — accuracy: OFF ${offCorrect}/${CUES.length} (chance readout), ` +
        `ON ${onCorrectProduction}/${CUES.length} (production settle), ` +
        `ON ${onCorrectExtended}/${CUES.length} (extended settle); ties ${ties}`
    );
    for (const [word, row] of [...perWord.entries()].sort()) {
      // eslint-disable-next-line no-console
      console.log(`WSD BENCH — ${word}: OFF ${row.off}/${row.total}, ON ${row.on}/${row.total}`);
    }

    // THE VERDICT (§7.3) — measured, then asserted. The chance baseline is
    // exactly 6/12 (nothing disambiguates with the flag off, as the paper
    // assumes), and the flag adds NOTHING at either settle length — the
    // refutation branch: the coupling is not doing disambiguation and the
    // flag stays off. Asserting the measured constants (not bounds) hardens
    // the record: a future change that makes the coupling disambiguate (or
    // that silently breaks the chance baseline) fails this test loudly and
    // must update the FINDINGS NOTE above.
    expect(offCorrect).toBe(6);
    expect(onCorrectProduction).toBe(6);
    expect(onCorrectExtended).toBe(6);
    expect(ties).toBe(0);
  });

  // ── THE HEAVY GATES, with the flag ON ────────────────────────────────────
  it('holds the heavy gates with the coupling flag ON', () => {
    // GATE A — fuzz-style wrong-sense distractors: every cross-sense is-a
    // probe must stay hedged or asked, never a CONFIDENT cross-sense "Yes".
    const relations = on.teacher.unsplitRelations();
    const exposed = wordsWithUnrelatedIsAParents(relations);
    let confidentYes = 0;
    let crossSenseConfidentYes = 0;
    for (const word of exposed) {
      for (const parent of isAParentsOf(relations, word)) {
        const origin = relations.find(
          (r) => r.subject === word && r.predicate === 'is-a' && r.object === parent
        )?.origin;
        const probe = isAQuestion(word, parent);
        const answer = on.teacher.chatAnswer(probe);
        if (claimsRelationalYes(answer)) {
          confidentYes += 1;
          if (origin !== 'regex') crossSenseConfidentYes += 1;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `WSD BENCH — gates (flag ON): confident is-a "Yes" ${confidentYes}, CONFIDENT cross-sense "Yes" ${crossSenseConfidentYes}`
    );
    expect(exposed.length).toBe(6);
    expect(confidentYes).toBe(0);
    expect(crossSenseConfidentYes).toBe(0);

    // GATE B — honesty probes: true relations never denied, false relations
    // never confidently asserted, unknown words always asked. The known
    // vocabulary is the deck plus the context words plus the content words
    // the definitions themselves taught (the observer may honestly echo
    // its own taught material — that is recall, not fabrication).
    const known = new Set<string>([
      ...DECK.map((d) => d.word),
      ...CONTEXT_WORDS,
      ...responseContentWords(DECK.map((d) => `${d.definition} ${d.example}`).join(' '))
    ]);
    const honesty = [
      { question: 'is a bird an animal', forbidNo: true },
      { question: 'is a mole an animal', forbidNo: true },
      { question: 'is a bird a machine', forbidYes: true },
      { question: 'is a season a machine', forbidYes: true },
      { question: 'what is a quargle', mustAsk: true },
      { question: 'is a bank a quargle', mustAsk: true },
      { question: 'what is bird', contains: 'wings' }
    ];
    let fabrications = 0;
    let falseYes = 0;
    let falseNo = 0;
    let missedAsk = 0;
    let missedDefinition = 0;
    for (const probe of honesty) {
      const answer = on.teacher.chatAnswer(probe.question);
      const spoken = 'response' in answer ? answer.response : '';
      if (answer.mode === 'operator' || answer.mode === 'creative') {
        const unknown = outOfVocabulary(spoken, known);
        if (unknown.length > 0) {
          fabrications += 1;
          // eslint-disable-next-line no-console
          console.log(`WSD BENCH — honesty FAIL "${probe.question}" -> [${answer.mode}] "${spoken}" (fabricated: ${unknown.join(', ')})`);
        }
      }
      if (claimsRelationalYes(answer) && probe.forbidYes) falseYes += 1;
      if (spoken.trim().toLowerCase().startsWith('no') && probe.forbidNo) falseNo += 1;
      if (probe.mustAsk && answer.mode !== 'ask') missedAsk += 1;
      if (probe.contains !== undefined && !spoken.toLowerCase().includes(probe.contains)) missedDefinition += 1;
    }
    // eslint-disable-next-line no-console
    console.log(
      `WSD BENCH — honesty probes (flag ON): fabrications ${fabrications}, false "Yes" ${falseYes}, ` +
        `false "No" ${falseNo}, missed asks ${missedAsk}, missed definitions ${missedDefinition}`
    );
    expect(fabrications).toBe(0);
    expect(falseYes).toBe(0);
    expect(falseNo).toBe(0);
    expect(missedAsk).toBe(0);
    expect(missedDefinition).toBe(0);
  }, 120000);
});
