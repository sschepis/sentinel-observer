/**
 * @jest-environment node
 *
 * COUNCIL-AGREEMENT-BENCH (improvements.md §4.5 / Phase C.5) + the
 * NETWORK-TRACE-BENCH (§3.4 / Phase B.3).
 *
 * §4.5: council agreement measured over CITED EDGE SETS, not token overlap.
 *   · pure gate tests — genuine agreement (shared citations, no shared
 *     tokens) is found; false agreement (token overlap high, cited edges
 *     disjoint) is rejected; composed answers (no edges) cannot gate.
 *   · the 10 council probes + the 12-probe niche bench re-run twice: once
 *     token-gated (the pre-§4.5 baseline) and once edge-gated — every
 *     genuine token-agreement case must be found by the edge gate.
 *
 * §3.4: after a settled answer the network stores a network-agreement trace
 *   (settled answer + cited edges + contributing members) via a member
 *   teacher's memory. Re-asking each settled probe must resolve from the
 *   trace: rounds = 0, same answer — 100% recall of settled answers.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import {
  ObserverNetwork,
  agreementReading,
  gatedAgreement,
  edgeCitingMembers,
  maxPairwiseEdgeAgreement,
  maxPairwiseTokenAgreement,
  edgeDistributionEntropy,
  type CouncilMemberVerdict,
  type CouncilResult
} from './network';
import { ALL_CONVERSATION_PAIRS, CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

const NATURE: readonly DeckWord[] = [
  { word: 'water', definition: 'a clear liquid that falls as rain', example: 'Water is wet.' },
  { word: 'bird', definition: 'an animal with wings', example: 'A bird can fly.' },
  { word: 'tree', definition: 'a tall plant with a trunk and leaves', example: 'The tree is tall.' },
  // Taught to nature AND daily so an edge-citing relational probe has two
  // members grounding the SAME cited edge (a genuine edge-agreement case).
  { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' }
];
const DAILY: readonly DeckWord[] = [
  { word: 'house', definition: 'a building where people live', example: 'The house is big.' },
  { word: 'chair', definition: 'a seat with a back', example: 'Sit on the chair.' },
  { word: 'table', definition: 'a piece of furniture with a flat top', example: 'Set the table.' },
  { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' }
];
const MIND: readonly DeckWord[] = [
  { word: 'thought', definition: 'an idea in the mind', example: 'A thought came.' },
  { word: 'word', definition: 'a unit of language', example: 'Say the word.' },
  { word: 'memory', definition: 'something remembered from the past', example: 'A memory lasts.' },
  { word: 'question', definition: 'a sentence that asks for an answer', example: 'Ask a question.' }
];

const ALL_DECK = [...NATURE, ...DAILY, ...MIND];
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...ALL_DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

/** The 10 council probes (council-bench.ts "COUNCIL PROBES"). */
const COUNCIL_PROBES: readonly string[] = [
  'what is water',
  'what is a bird',
  'what is a house',
  'what is a chair',
  'what is a thought',
  'does golf have rules',
  'is water a person',
  'what is zzz',
  'zzz xyz qqq',
  'what is a word'
];

/** The 12-probe niche bench (council-bench.ts domainProbes). */
const NICHE_PROBES: ReadonlyArray<{ domain: 'nature' | 'daily' | 'mind'; question: string }> = [
  { domain: 'nature', question: 'what is water' },
  { domain: 'nature', question: 'what is a bird' },
  { domain: 'nature', question: 'what is a tree' },
  { domain: 'nature', question: 'where does a bird live' },
  { domain: 'daily', question: 'what is a house' },
  { domain: 'daily', question: 'what is a chair' },
  { domain: 'daily', question: 'what is a table' },
  { domain: 'daily', question: 'what are clothes' },
  { domain: 'mind', question: 'what is a thought' },
  { domain: 'mind', question: 'what is a word' },
  { domain: 'mind', question: 'what is a memory' },
  { domain: 'mind', question: 'what is a question' }
];

/** Relational probes that cite edges when grounded (the §4.5 signal). */
const EDGE_PROBES: string[] = ['is a robin a bird'];

/** The bench order mirrors council-bench.ts: the niche bench first (so
 *  first-ask rounds are measured there), then the council probes. */
const ALL_PROBES: readonly string[] = [...NICHE_PROBES.map((p) => p.question), ...COUNCIL_PROBES, ...EDGE_PROBES];

const COUNCIL_PAIRS = ALL_CONVERSATION_PAIRS.slice(0, 150);

async function member(deck: readonly DeckWord[]): Promise<{ teacher: TeacherAgent; session: ObserverSession }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, deck);
  for (const entry of deck) teacher.teach(entry.word);
  teacher.teachConversationDeck(COUNCIL_PAIRS);
  for (const pair of COUNCIL_PAIRS) teacher.respond(pair.cue);
  return { teacher, session };
}

async function council(useEdgeAgreement: boolean, agreementThreshold = 0.55): Promise<{
  network: ObserverNetwork;
  dispose: () => void;
}> {
  const members = await Promise.all([member(NATURE), member(DAILY), member(MIND)]);
  const network = new ObserverNetwork(
    [
      { name: 'nature', teacher: members[0].teacher },
      { name: 'daily', teacher: members[1].teacher },
      { name: 'mind', teacher: members[2].teacher }
    ],
    3,
    agreementThreshold,
    undefined,
    undefined,
    undefined,
    useEdgeAgreement
  );
  return {
    network,
    dispose: () => {
      for (const { session } of members) session.dispose();
    }
  };
}

/**
 * Creative composition samples with Math.random, so deterministic streams
 * keep every council run reproducible (the same discipline as
 * network.test.ts). The LCG seed is re-installed before each probe loop so
 * the baseline and edge-gated runs draw from identical streams.
 */
let randomSpy: ReturnType<typeof jest.spyOn> | null = null;

function seedRandom(seed: number): void {
  let state = seed >>> 0;
  randomSpy?.mockRestore();
  randomSpy = jest.spyOn(Math, 'random').mockImplementation(() => {
    state = (Math.imul(state, 48271) % 2147483647) >>> 0;
    return state / 2147483647;
  });
}

beforeEach(() => {
  seedRandom(0x2f6e2b1);
});

afterEach(() => {
  randomSpy?.mockRestore();
  randomSpy = null;
});

const verdict = (
  name: string,
  response: string,
  citedEdges: CouncilMemberVerdict['citedEdges'],
  mode = 'operator'
): CouncilMemberVerdict => ({ name, mode, response, confidence: 1, citedEdges });

describe('council agreement by cited edges (§4.5)', () => {
  it('genuine agreement: shared citations are found even with no shared tokens', () => {
    // The §4.5 example — the same claim in different words, the same edge.
    const genuine = [
      verdict('a', 'Yes — a robin is a bird.', [{ subject: 'robin', predicate: 'is-a', object: 'bird' }]),
      verdict('b', 'Robins are birds, so yes.', [{ subject: 'robin', predicate: 'is-a', object: 'bird' }])
    ];
    expect(maxPairwiseTokenAgreement(genuine)).toBeLessThan(0.55); // tokens would miss it
    const reading = agreementReading(genuine);
    expect(reading.edgeGated).toBe(true);
    expect(reading.edge).toBe(1); // identical cited edge sets
    expect(gatedAgreement(reading, true)).toBe(1); // edge gate finds it
  });

  it('false agreement: token overlap high with disjoint cited edges is rejected', () => {
    // Identical wording, different evidence — the token path would accept.
    const falseAgreement = [
      verdict('a', 'Yes — water is a liquid thing.', [{ subject: 'water', predicate: 'is-a', object: 'liquid' }]),
      verdict('b', 'Yes — water is a liquid thing.', [{ subject: 'water', predicate: 'made-of', object: 'liquid' }])
    ];
    expect(maxPairwiseTokenAgreement(falseAgreement)).toBe(1); // token path clears
    const reading = agreementReading(falseAgreement);
    expect(reading.edgeGated).toBe(true);
    expect(reading.edge).toBe(0); // disjoint edge sets
    expect(gatedAgreement(reading, true)).toBe(0); // edge gate rejects
    // The token path is kept: without edge gating the same verdicts still
    // clear the threshold (the pre-§4.5 behavior, intact).
    expect(gatedAgreement(reading, false)).toBe(1);
  });

  it('composed answers cite no edges and cannot gate the edge signal', () => {
    const mixed = [
      verdict('a', 'Yes — water is a liquid thing.', [{ subject: 'water', predicate: 'is-a', object: 'liquid' }]),
      verdict('b', 'Yes — water is a liquid thing.', []), // composed: no edges
      verdict('c', 'I do not know.', [], 'ask')
    ];
    expect(edgeCitingMembers(mixed)).toBe(1); // fewer than two cite edges
    const reading = agreementReading(mixed);
    expect(reading.edgeGated).toBe(false);
    // Only one member cites edges: the token path stays in force.
    expect(gatedAgreement(reading, true)).toBe(reading.token);
    // A composed answer raising the edge score is impossible — empty edge
    // sets are skipped, never counted as agreement.
    const composedOnly = [verdict('a', 'same words', []), verdict('b', 'same words', [])];
    expect(maxPairwiseEdgeAgreement(composedOnly)).toBe(0);
  });

  it('the edge-distribution entropy concentrates as citations agree', () => {
    const agreeing = [
      verdict('a', 'x', [{ subject: 'robin', predicate: 'is-a', object: 'bird' }]),
      verdict('b', 'x', [{ subject: 'robin', predicate: 'is-a', object: 'bird' }])
    ];
    const disagreeing = [
      verdict('a', 'x', [{ subject: 'robin', predicate: 'is-a', object: 'bird' }]),
      verdict('b', 'x', [{ subject: 'robin', predicate: 'made-of', object: 'bird' }])
    ];
    const noEdges = [verdict('a', 'x', []), verdict('b', 'x', [])];
    expect(edgeDistributionEntropy(agreeing)).toBe(0); // fully concentrated
    expect(edgeDistributionEntropy(disagreeing)).toBeGreaterThan(edgeDistributionEntropy(agreeing));
    expect(edgeDistributionEntropy(noEdges)).toBe(0); // no citations, no spread
  });
});

describe('council-agreement-bench: probes re-run with edge-based agreement (§4.6)', () => {
  it('the 10 council probes + 12-probe niche bench: every genuine token agreement is found', async () => {
    // The pre-§4.5 baseline (token-gated) and the §4.5 network
    // (edge-gated) — identical members, identical seeded randomness.
    const baseline = await council(false);
    const edged = await council(true);
    try {
      const run = (network: ObserverNetwork, label: string, sink: Map<string, CouncilResult>): number => {
        seedRandom(0x2f6e2b1);
        let firstRounds = 0;
        let falseTokenAgreements = 0;
        // eslint-disable-next-line no-console
        console.log(`\nCOUNCIL-AGREEMENT ${label}:`);
        for (const probe of ALL_PROBES) {
          const result = network.respond(probe);
          const first = !sink.has(probe);
          if (first) {
            sink.set(probe, result);
            firstRounds += result.rounds;
            // A token-gated composed cluster whose cited edges are disjoint
            // (or absent) is exactly the §4.6 false agreement.
            if (result.mode === 'composed' && result.edgeAgreement < 0.55) falseTokenAgreements += 1;
          }
          // eslint-disable-next-line no-console
          console.log(
            `  ${probe.padEnd(22)} mode=${result.mode.padEnd(9)} rounds=${result.rounds}` +
              ` tok=${result.agreement.toFixed(2)} edge=${result.edgeAgreement.toFixed(2)}` +
              (result.edgeGated ? ' GATED' : '') +
              (result.recalledFromTrace === true ? ' TRACE' : '') +
              (first ? '' : ' (re-ask)')
          );
        }
        // eslint-disable-next-line no-console
        console.log(
          `  ${label} first-ask rounds ${firstRounds} · false token agreements ${falseTokenAgreements}`
        );
        return firstRounds;
      };

      const baselineSink = new Map<string, CouncilResult>();
      const edgedSink = new Map<string, CouncilResult>();
      const baselineRounds = run(baseline.network, 'token gate (before)', baselineSink);
      const edgeRounds = run(edged.network, 'edge gate (after)', edgedSink);

      let genuineFound = 0;
      let genuineTotal = 0;
      let falseRejected = 0;
      let falseTotal = 0;
      for (const probe of ALL_PROBES) {
        const before = baselineSink.get(probe)!;
        const after = edgedSink.get(probe)!;
        if (before.mode === 'grounded' || before.mode === 'composed') {
          genuineTotal += 1;
          const found = after.mode === 'grounded' || after.mode === 'composed';
          if (found) genuineFound += 1;
          // §4.6 pass: edge agreement finds every token-agreement case
          // that was genuine.
          expect(found).toBe(true);
        }
        // A token-based acceptance whose cited edges are disjoint (or
        // absent in a gated round) must NOT survive the edge gate.
        if (before.mode === 'composed' && before.edgeGated && before.edgeAgreement < 0.55) {
          falseTotal += 1;
          if (after.mode !== 'composed') falseRejected += 1;
          expect(after.mode).not.toBe('composed');
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `\nCOUNCIL-AGREEMENT SUMMARY: genuine cases found ${genuineFound}/${genuineTotal} ·` +
          ` false agreements rejected ${falseRejected}/${falseTotal} ·` +
          ` rounds before ${baselineRounds} → after ${edgeRounds}`
      );
      expect(genuineFound).toBe(genuineTotal);
    } finally {
      baseline.dispose();
      edged.dispose();
    }
  }, 300000);
});

describe('network-trace-bench: the network recalls its own settled agreements (§3.4)', () => {
  it('re-asking each settled probe resolves from the trace with rounds = 0 and the same answer', async () => {
    const { network, dispose } = await council(true);
    try {
      seedRandom(0x2f6e2b1);
      const settled = new Map<string, CouncilResult>();
      // eslint-disable-next-line no-console
      console.log('\nNETWORK-TRACE first asks:');
      for (const probe of ALL_PROBES) {
        const result = network.respond(probe);
        if (!settled.has(probe) && (result.mode === 'grounded' || result.mode === 'composed')) {
          settled.set(probe, result);
        }
        // eslint-disable-next-line no-console
        console.log(`  ${probe.padEnd(22)} mode=${result.mode.padEnd(9)} rounds=${result.rounds}`);
      }

      // §3.4 pass: 100% recall of settled answers with rounds = 0.
      let recalled = 0;
      // eslint-disable-next-line no-console
      console.log('\nNETWORK-TRACE re-asks:');
      for (const [probe, first] of settled) {
        const second = network.respond(probe);
        expect(second.recalledFromTrace).toBe(true);
        expect(second.rounds).toBe(0);
        expect(second.answer).toBe(first.answer);
        expect(second.mode).toBe(first.mode);
        expect(second.contributors).toEqual(first.contributors);
        if (second.recalledFromTrace === true && second.answer === first.answer) recalled += 1;
        // eslint-disable-next-line no-console
        console.log(`  ${probe.padEnd(22)} rounds=${second.rounds} answer="${second.answer.slice(0, 48)}"`);
      }
      // eslint-disable-next-line no-console
      console.log(`\nNETWORK-TRACE SUMMARY: ${recalled}/${settled.size} settled answers recalled with rounds = 0`);
      expect(recalled).toBe(settled.size);
      expect(settled.size).toBeGreaterThan(0);
    } finally {
      dispose();
    }
  }, 300000);
});
