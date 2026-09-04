/**
 * @jest-environment node
 *
 * POLYSEMY PROBE SET (Phase F.1, §7.1/§7.5) — measure the cross-sense
 * fabrication path WITHOUT changing production code.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FINDINGS NOTE (recorded against base main @ 466eb2a, shipped 20k record
 * generated 2026-09-03):
 *
 * §7.1's claim is that a word carrying is-a edges from more than one sense
 * (e.g. 'bank' → institution AND slope) can answer cross-sense probes "Yes"
 * with provenance — a CONFIDENT, wrong answer — and that the adversarial
 * bench cannot see it because `negativeTargetsFor` computes the merged
 * closure.
 *
 * The measurement below reproduces the shipped-record mechanism faithfully
 * and measures it: a small deck of real polysemous words is taught with
 * definitions carrying the PRIMARY sense (regex-extracted, one is-a edge,
 * 'curriculum' source class, strength 1.0), and the SECONDARY senses are
 * injected through the SAME direct-assignment path the shipped record uses
 * (`importBootstrap` sets `chaperoneRelations = record.relations` verbatim,
 * bypassing the reconcile that would otherwise flag a same-predicate
 * disagreement as a belief). The cross-sense probes are then run through the
 * real `chatAnswer`.
 *
 * MEASURED RESULT: the merged-sense path EXISTS, but it is HEDGED, not
 * confident. The secondary (chaperone-sourced) sense carries a single
 * 'definition' source class → corroborationConfidence 0.6 → the is-a operator
 * answers "Probably, a bank is a slope." (never a flat "Yes"). The confident
 * "Yes" answers come only from each word's DEFINITIONAL sense, which is the
 * correct reading — not a fabrication. The count of CONFIDENT cross-sense
 * "Yes" answers is therefore ZERO in this reproduction (and `cli/polysemy-bench.ts`
 * prints the same number for the full shipped record when a
 * `public/bootstrap.json` is present). §7.1's "confident" wrong answer does
 * not reproduce: the P14 corroboration hedge downgrades the merged sense to
 * "Probably" before it can become a confident lie.
 *
 * CONCLUSION: §7.1 should be amended, not confirmed as written. The latent
 * fabrication it describes is real in the GRAPH (a word does hold two
 * unrelated is-a parents), but the honesty contract's hedging turns the
 * cross-sense answer into an uncertainty-marked one. The residual risk is a
 * HEDGED wrong answer (arguably honest), not a confident one. The test
 * asserts the measured confident count (0) and logs the full breakdown so a
 * future record that corroborates a secondary sense (and thereby restores
 * confidence) would fail loudly.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { claimsRelationalYes, negativeTargetsFor } from './adversarial';
import { PRIME_SPACE, deckVocabulary, primeSignature, sensePrimeSignature } from './primeSignature';
import { BOOTSTRAP_VERSION, BOOTSTRAP_VOCABULARY_SCHEME, type BootstrapRecord } from './bootstrap';
import {
  isAParentsOf,
  wordsWithUnrelatedIsAParents,
  crossSenseProbesFor,
  isAQuestion
} from './polysemyProbes';
import {
  assignSenses,
  mergedGraphFor,
  reservedSignatureKeys,
  senseGroupsFor,
  senseVocabulary,
  signatureKey,
  splitRelationsBySense
} from './senseModel';
import { isATypeOf } from './chain';
import { classifyRegime } from './cde';
import type { Relation } from './relations';
import type { DeckWord } from './deck';

// ── Pure-function unit tests (the adversarial.test.ts style) ────────────────
const RELATIONS: Relation[] = [
  { subject: 'bank', predicate: 'is-a', object: 'institution', source: 'a financial institution', origin: 'regex' },
  { subject: 'bank', predicate: 'is-a', object: 'slope', source: 'sloping land beside water', origin: 'chaperone' },
  { subject: 'institution', predicate: 'is-a', object: 'building', source: 'a building...', origin: 'regex' },
  { subject: 'bat', predicate: 'is-a', object: 'animal', source: 'a flying animal', origin: 'authored' },
  { subject: 'bat', predicate: 'is-a', object: 'mammal', source: 'a mammal', origin: 'authored' },
  { subject: 'mammal', predicate: 'is-a', object: 'animal', source: 'a mammal', origin: 'authored' },
  { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'a small bird', origin: 'regex' }
];

describe('polysemy probe predicates', () => {
  it('isAParentsOf lists direct is-a parents only, deduplicated', () => {
    expect(isAParentsOf(RELATIONS, 'bank')).toEqual(['institution', 'slope']);
    expect(isAParentsOf(RELATIONS, 'robin')).toEqual(['bird']);
    expect(isAParentsOf(RELATIONS, 'slope')).toEqual([]);
  });

  it('wordsWithUnrelatedIsAParents flags only parents in unrelated closures', () => {
    // 'bank' → institution and slope: neither is-a the other → UNRELATED.
    // 'bat' → animal and mammal: mammal is-a animal → RELATED (not flagged).
    // 'robin' → bird: a single parent → not a candidate.
    expect(wordsWithUnrelatedIsAParents(RELATIONS)).toEqual(['bank']);
  });

  it('crossSenseProbesFor derives the is-a probes and the converse', () => {
    expect(crossSenseProbesFor(RELATIONS, 'bank')).toEqual([
      'is a bank an institution',
      'is a bank a slope'
    ]);
    expect(isAQuestion('organ', 'instrument')).toBe('is an organ an instrument');
    expect(isAQuestion('crane', 'machine')).toBe('is a crane a machine');
  });
});

// ── The measured reproduction (the ciGates.test.ts style) ───────────────────
// A small deck of real polysemous words, taught with definitions carrying the
// PRIMARY sense. The SECONDARY senses below are what the chaperone pass adds
// when asked about the WORD, not the sense — they land in record.relations
// and are assigned DIRECTLY on import (agent/persistence.ts importBootstrap),
// bypassing the reconcile that would flag a same-predicate disagreement.
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

/** Secondary (chaperone-supplied) senses: the cross-sense is-a parents. */
const CHAPERONE_SENSES: readonly Relation[] = [
  { subject: 'bank', predicate: 'is-a', object: 'slope', source: 'sloping land beside a body of water', origin: 'chaperone' },
  { subject: 'spring', predicate: 'is-a', object: 'coil', source: 'a wound metal device that returns to shape', origin: 'chaperone' },
  { subject: 'bark', predicate: 'is-a', object: 'sound', source: 'the sharp sound a dog makes', origin: 'chaperone' },
  { subject: 'mole', predicate: 'is-a', object: 'unit', source: 'a chemical unit of amount', origin: 'chaperone' },
  { subject: 'organ', predicate: 'is-a', object: 'part', source: 'a part of the body that does a job', origin: 'chaperone' },
  { subject: 'crane', predicate: 'is-a', object: 'machine', source: 'a machine that lifts and moves heavy things', origin: 'chaperone' }
];

function setupOptions() {
  return {
    primeCount: 64,
    gridSize: 128,
    memoryMode: 'compact' as const,
    smfWidth: 128,
    vocabulary: deckVocabulary(DECK, PRIME_SPACE)
  };
}

describe('polysemy probe set — measured reproduction of §7.1', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeAll(async () => {
    session = new ObserverSession(setupOptions(), 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DECK);
    for (const entry of DECK) teacher.teach(entry.word);
    // Inject the secondary senses through the SAME import path the shipped
    // record uses: a minimal record whose `relations` field is assigned
    // directly to `chaperoneRelations` (no reconciliation). No production
    // code is modified — this is the record the batch trainer would have
    // written after asking the chaperone about the word, not the sense.
    const record: BootstrapRecord = {
      version: BOOTSTRAP_VERSION,
      vocabularyScheme: BOOTSTRAP_VOCABULARY_SCHEME,
      deck: 'polysemy-probe',
      generatedAt: new Date().toISOString(),
      source: { words: DECK.map((d) => d.word), conversation: false, definitionsFilled: true },
      traces: [],
      wordStates: [],
      definitions: DECK.map((d) => ({ word: d.word, definition: d.definition, example: d.example })),
      relations: CHAPERONE_SENSES.map((r) => ({ ...r }))
    };
    teacher.importBootstrap(record);
  }, 120000);

  afterAll(() => {
    session.dispose();
  });

  it('reproduces the merged-sense graph: every probe word has two UNRELATED is-a parents', () => {
    const relations = teacher.relations();
    const exposed = wordsWithUnrelatedIsAParents(relations);
    // eslint-disable-next-line no-console
    console.log(`\nPOLYSEMY PROBE SET — words with unrelated is-a parents: ${exposed.length}\n  ${exposed.join(', ')}`);
    // The six words each carry one regex parent + one chaperone parent.
    expect(exposed).toEqual(['bank', 'bark', 'crane', 'mole', 'organ', 'spring']);
  });

  it('measures the confident cross-sense "Yes" count — the size of the exposure', () => {
    const relations = teacher.relations();
    const exposed = wordsWithUnrelatedIsAParents(relations);

    // A parent is a CROSS-SENSE parent when its origin is not 'regex' (the
    // word's definitional gloss). Those are the "other senses" §7.1 is about.
    let confidentYes = 0; // definitional sense, correct reading
    let hedgedYes = 0; // cross (chaperone) sense, hedged by corroboration
    let crossSenseConfidentYes = 0; // the exposure: confident "Yes" on a cross sense
    for (const word of exposed) {
      for (const parent of isAParentsOf(relations, word)) {
        const origin = relations.find(
          (r) => r.subject === word && r.predicate === 'is-a' && r.object === parent
        )?.origin;
        const probe = isAQuestion(word, parent);
        const answer = teacher.chatAnswer(probe);
        if (claimsRelationalYes(answer)) {
          confidentYes += 1;
          if (origin !== 'regex') crossSenseConfidentYes += 1;
        } else if (answer.mode === 'operator' && /^(Probably|I believe)/.test(answer.response)) {
          hedgedYes += 1;
        }
        const spoken = 'response' in answer ? answer.response : '';
        // eslint-disable-next-line no-console
        console.log(`  ${probe.padEnd(34)} [${origin ?? '?'}] -> [${answer.mode}] ${spoken}`);
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `POLYSEMY PROBE SET — confident "Yes" ${confidentYes} (definitional), hedged "Probably" ${hedgedYes} (cross-sense), CONFIDENT cross-sense "Yes" ${crossSenseConfidentYes}`
    );

    // THE FINDING (asserted, not assumed — this is the measurement §7.5 asks
    // for): every word's definitional sense is answered confidently, and every
    // CROSS (chaperone) sense is answered "Probably" — the P14 corroboration
    // gate (single 'definition' class → strength 0.6) downgrades it. The
    // confident cross-sense "Yes" count is therefore ZERO.
    expect(exposed.length).toBe(6);
    expect(confidentYes).toBe(exposed.length); // one confident Yes per word = its own definitional sense
    expect(hedgedYes).toBe(exposed.length); // one hedged "Probably" per word = the cross (chaperone) sense
    expect(crossSenseConfidentYes).toBe(0);
  });
});

// ── F.2 SENSE SPLIT (§7.2) — pure sense-model predicates ───────────────────
describe('sense model (§7.2 signature-per-sense) predicates', () => {
  it('senseGroupsFor clusters is-a parents into readings, definitional first', () => {
    const groups = senseGroupsFor(RELATIONS, 'bank');
    expect(groups.map((g) => g.key)).toEqual(['bank#1', 'bank#2']);
    expect(groups[0].parents).toEqual(['institution']);
    expect(groups[0].reading).toBe('a financial institution');
    expect(groups[1].parents).toEqual(['slope']);
    expect(groups[1].reading).toBe('sloping land beside water');
    // 'bat' → animal and mammal: mammal is-a animal → ONE reading, no split.
    expect(senseGroupsFor(RELATIONS, 'bat')).toEqual([]);
    // 'robin' → a single parent → no split.
    expect(senseGroupsFor(RELATIONS, 'robin')).toEqual([]);
  });

  it('readings are DISTINCT — an identical gloss falls back to the distinct parent, and generic curriculum labels never become readings', () => {
    // Both edges carry the SAME definition as their source: the ask must
    // not repeat it ("as in X, or as in X").
    const shared = senseGroupsFor(
      [
        { subject: 'star', predicate: 'is-a', object: 'sphere', source: 'a luminous sphere of plasma', origin: 'regex' },
        { subject: 'star', predicate: 'is-a', object: 'matter', source: 'a luminous sphere of plasma', origin: 'authored' }
      ],
      'star'
    );
    expect(shared).toHaveLength(2);
    expect(shared[0].reading).toBe('a luminous sphere of plasma');
    expect(shared[1].reading).toBe('a matter');
    expect(shared[0].reading).not.toBe(shared[1].reading);
    // An authored edge whose only gloss is a curriculum label names the
    // parent itself — with the probe questions' article convention.
    const labeled = senseGroupsFor(
      [
        { subject: 'tiger', predicate: 'is-a', object: 'person', source: 'a fierce or audacious person', origin: 'regex' },
        { subject: 'tiger', predicate: 'is-a', object: 'animal', source: 'everyday-knowledge curriculum', origin: 'authored' }
      ],
      'tiger'
    );
    expect(labeled).toHaveLength(2);
    expect(labeled[0].reading).toBe('a fierce or audacious person');
    expect(labeled[1].reading).toBe('an animal');
  });

  it('a gloss quotes only its primary clause ("a person; impressive in size" -> "a person")', () => {
    const readings = senseGroupsFor(
      [
        { subject: 'whale', predicate: 'is-a', object: 'person', source: 'a very large person; impressive in size or qualities', origin: 'regex' },
        { subject: 'whale', predicate: 'is-a', object: 'animal', source: 'everyday-knowledge curriculum', origin: 'authored' }
      ],
      'whale'
    );
    expect(readings).toHaveLength(2);
    expect(readings[0].reading).toBe('a very large person');
    expect(readings[1].reading).toBe('an animal');
  });

  it('assignSenses mints deterministic, distinct, in-basis sense signatures and leaves legacy word signatures byte-identical', () => {
    const legacy = primeSignature('bank');
    const first = assignSenses(RELATIONS, PRIME_SPACE);
    const second = assignSenses(RELATIONS, PRIME_SPACE);
    // Determinism: the same graph mints the same assignment, twice.
    expect(first.signatures['bank#1']).toEqual(second.signatures['bank#1']);
    expect(first.signatures['bank#2']).toEqual(second.signatures['bank#2']);
    // Each sense's signature: 4 distinct in-basis primes, distinct from the
    // other sense's and from the surface word's LEGACY signature.
    for (const key of ['bank#1', 'bank#2']) {
      const signature = first.signatures[key];
      expect(signature).toHaveLength(4);
      expect(new Set(signature).size).toBe(4);
      for (const prime of signature) expect(PRIME_SPACE).toContain(prime);
      expect(signatureKey(signature)).not.toBe(signatureKey(legacy));
    }
    expect(signatureKey(first.signatures['bank#1'])).not.toBe(signatureKey(first.signatures['bank#2']));
    expect(sensePrimeSignature('bank', 1)).not.toEqual(primeSignature('bank'));
    // The surface union excites BOTH senses' primes exactly once each.
    expect(first.surfaceUnions['bank']).toEqual([
      ...first.signatures['bank#1'],
      ...first.signatures['bank#2']
    ]);
  });

  it('senseVocabulary layers the union and sense keys without touching other entries', () => {
    const base = deckVocabulary(DECK, PRIME_SPACE);
    const assignment = assignSenses(RELATIONS, PRIME_SPACE);
    const deployed = senseVocabulary(base, assignment);
    expect(deployed['bank']).toEqual(assignment.surfaceUnions['bank']);
    expect(deployed['bank#1']).toEqual(assignment.signatures['bank#1']);
    expect(deployed['bank#2']).toEqual(assignment.signatures['bank#2']);
    // Non-split words keep their legacy entries byte-identical.
    for (const entry of DECK) {
      if (entry.word !== 'bank') expect(deployed[entry.word]).toEqual(base[entry.word]);
    }
  });

  it('splitRelationsBySense moves edges onto sense nodes and never crosses senses', () => {
    const assignment = assignSenses(RELATIONS, PRIME_SPACE);
    const split = splitRelationsBySense(RELATIONS, assignment);
    // No edge remains on the surface word.
    expect(split.some((r) => r.subject === 'bank')).toBe(false);
    // The definitional is-a edge lives on bank#1, the chaperone edge on bank#2.
    expect(split.some((r) => r.subject === 'bank#1' && r.predicate === 'is-a' && r.object === 'institution')).toBe(true);
    expect(split.some((r) => r.subject === 'bank#2' && r.predicate === 'is-a' && r.object === 'slope')).toBe(true);
    // Chain walks run over sense nodes and cannot cross senses.
    expect(isATypeOf(split, 'bank#1', 'institution')).toBe(true);
    expect(isATypeOf(split, 'bank#2', 'slope')).toBe(true);
    expect(isATypeOf(split, 'bank#1', 'slope')).toBe(false);
    expect(isATypeOf(split, 'bank#2', 'institution')).toBe(false);
    expect(isATypeOf(split, 'bank', 'institution')).toBe(false);
    // Non-split words pass through untouched.
    expect(split.filter((r) => r.subject === 'robin')).toEqual(
      RELATIONS.filter((r) => r.subject === 'robin')
    );
  });

  it('the negative-target selector computes closure per sense', () => {
    const assignment = assignSenses(RELATIONS, PRIME_SPACE);
    const split = splitRelationsBySense(RELATIONS, assignment);
    const readings = assignment.readingsOf.get('bank') ?? [];
    const negatives = negativeTargetsFor(
      'bank',
      split,
      ['institution', 'building', 'slope', 'season', 'sound'],
      100,
      readings.map((r) => ({ key: r.key }))
    );
    // Each sense's closure excludes its own is-a parents: 'institution' via
    // bank#1, 'building' via its ancestor chain, 'slope' via bank#2.
    expect(negatives).not.toContain('institution');
    expect(negatives).not.toContain('building');
    expect(negatives).not.toContain('slope');
    expect(negatives).toContain('season');
    expect(negatives).toContain('sound');
  });
});

// ── F.2 SENSE SPLIT — the measured after-split reproduction ────────────────
describe('sense split (§7.2/F.2) — after-split measurement', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeAll(async () => {
    const baseVocabulary = deckVocabulary(DECK, PRIME_SPACE);
    // The same merged graph the teacher derives (regex + authored + chaperone),
    // minted against the deployed vocabulary so session and teacher agree.
    const assignment = assignSenses(
      mergedGraphFor(
        DECK.map((d) => ({ word: d.word, definition: d.definition })),
        new Set(DECK.map((d) => d.word)),
        CHAPERONE_SENSES
      ),
      PRIME_SPACE,
      reservedSignatureKeys(baseVocabulary)
    );
    session = new ObserverSession(
      { ...setupOptions(), vocabulary: senseVocabulary(baseVocabulary, assignment) },
      100
    );
    await session.initialize();
    teacher = new TeacherAgent(session, DECK, null, 1, 0, 7, undefined, undefined, undefined, false, { assignment });
    // Split-era teaching order: the chaperone senses arrive BEFORE teaching,
    // so teach stores one trace PER SENSE.
    const record: BootstrapRecord = {
      version: BOOTSTRAP_VERSION,
      vocabularyScheme: BOOTSTRAP_VOCABULARY_SCHEME,
      deck: 'polysemy-probe',
      generatedAt: new Date().toISOString(),
      source: { words: DECK.map((d) => d.word), conversation: false, definitionsFilled: true },
      traces: [],
      wordStates: [],
      definitions: DECK.map((d) => ({ word: d.word, definition: d.definition, example: d.example })),
      relations: CHAPERONE_SENSES.map((r) => ({ ...r }))
    };
    teacher.importBootstrap(record);
    for (const entry of DECK) teacher.teach(entry.word);
  }, 120000);

  afterAll(() => {
    session.dispose();
  });

  it('the graph lives on sense nodes and the unsplit view stays available', () => {
    const relations = teacher.relations();
    const unsplit = teacher.unsplitRelations();
    // The served graph has no surface-word edges for the split word...
    expect(relations.some((r) => r.subject === 'bank')).toBe(false);
    expect(relations.some((r) => r.subject === 'bank#1' && r.object === 'institution')).toBe(true);
    expect(relations.some((r) => r.subject === 'bank#2' && r.object === 'slope')).toBe(true);
    // ...and the unsplit view still carries the merged surface edges.
    expect(unsplit.some((r) => r.subject === 'bank' && r.object === 'institution')).toBe(true);
    expect(unsplit.some((r) => r.subject === 'bank' && r.object === 'slope')).toBe(true);
  });

  it('recall over the sense candidates is not a single clear winner — the §2 instrument routes the ask', () => {
    // The instrument reads the MOMENT (excite + settle), the same discipline
    // the disambiguation routing uses before recall.
    teacher.exciteAndSettle('bank');
    const scores = session.recall('bank', 5).map((result) => result.score);
    // eslint-disable-next-line no-console
    console.log(`SENSE SPLIT — recall over 'bank' candidates: [${scores.map((s) => s.toFixed(3)).join(', ')}]`);
    // The routing fires the disambiguating ask unless ONE candidate clearly
    // dominates. At this 64-prime / 18-word scale the candidate distribution
    // reads 'flat' (no prime-prefilter discrimination — every trace shares
    // the whole basis); a bimodal sense distribution reads 'disambiguate'
    // (cde.test.ts). Either way the observer asks, naming both readings —
    // never answering from the merged graph.
    expect(['disambiguate', 'flat']).toContain(classifyRegime(scores));
  });

  it('the same probes produce 0 confident cross-sense answers, with a disambiguating ask', () => {
    const relations = teacher.unsplitRelations();
    const exposed = wordsWithUnrelatedIsAParents(relations);

    let confidentYes = 0;
    let crossSenseConfidentYes = 0;
    let disambiguatingAsks = 0;
    for (const word of exposed) {
      for (const parent of isAParentsOf(relations, word)) {
        const origin = relations.find(
          (r) => r.subject === word && r.predicate === 'is-a' && r.object === parent
        )?.origin;
        const probe = isAQuestion(word, parent);
        const answer = teacher.chatAnswer(probe);
        if (claimsRelationalYes(answer)) {
          confidentYes += 1;
          if (origin !== 'regex') crossSenseConfidentYes += 1;
        }
        const spoken = 'response' in answer ? answer.response : '';
        if (answer.mode === 'ask' && /^Do you mean /.test(spoken)) disambiguatingAsks += 1;
        // eslint-disable-next-line no-console
        console.log(`  ${probe.padEnd(34)} [${origin ?? '?'}] -> [${answer.mode}] ${spoken}`);
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `SENSE SPLIT — confident "Yes" ${confidentYes}, CONFIDENT cross-sense "Yes" ${crossSenseConfidentYes}, disambiguating asks ${disambiguatingAsks}`
    );

    // THE AFTER-SPLIT FINDING (§7.5): 0 confident cross-sense answers, and
    // the disambiguating ask names both readings where context is absent.
    // The exact ask COUNT is environment-sensitive — it follows the recall
    // blend, and the §4.2 DROP verdict removed the phase term from the
    // blend by default (PhaseTermArms), which re-routes a few probes to a
    // hedged belief or a plain ask instead of the disambiguating ask (the
    // per-probe lines above are the source of truth). The CONTRACT is the
    // zeros: no probe may be asserted confidently under the wrong sense.
    expect(exposed.length).toBe(6);
    expect(confidentYes).toBe(0);
    expect(crossSenseConfidentYes).toBe(0);
    expect(disambiguatingAsks).toBe(9);
  });
});
