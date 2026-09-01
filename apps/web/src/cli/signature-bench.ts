/**
 * SIGNATURE BENCH — Phase 1 of docs/PRIME_SEMANTICS_PLAN.md.
 *
 * Head-to-head: hash signatures (control) vs semantic signatures on the
 * same deck slice, same field, same teacher. Reports top-1 recognition
 * accuracy (H2), sibling vs unrelated Jaccard overlap (H1), and
 * within-category confusion (the interference risk semantic overlap
 * introduces). No LLM involved: grading is by trace identity, every number
 * is exact.
 *
 *   npm run signature-bench            # 100 words
 *   WORDS=300 npm run signature-bench
 */
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { DECK_20000 } from '../teacher/decks/en-20000';
import { PRIME_SPACE, deckVocabulary, fnv1a } from '../teacher/primeSignature';
import { jaccard, semanticAssignment, siblingClusters } from '../teacher/semanticSignature';
import type { DeckWord } from '../teacher/deck';

const WORDS = Number(process.env.WORDS ?? 100);
const H3_CLUSTERS = Number(process.env.CLUSTERS ?? 25);

/**
 * The bench deck: sibling-cluster words from the 20k deck (the words
 * semantic overlap is most likely to confuse), padded with the most
 * frequent defined words to reach the requested size.
 */
function benchDeck(size: number): DeckWord[] {
  const source = DECK_20000 as readonly DeckWord[];
  const byWord = new Map(source.map((entry) => [entry.word.toLowerCase(), entry]));
  const picked: DeckWord[] = [];
  const taken = new Set<string>();
  const structured = source.slice(0, 5000);
  for (const cluster of siblingClusters(structured)) {
    for (const word of cluster.words) {
      const entry = byWord.get(word);
      if (entry !== undefined && entry.definition.trim().length > 0 && !taken.has(word)) {
        picked.push(entry);
        taken.add(word);
      }
      if (picked.length >= size) return picked;
    }
  }
  for (const entry of structured) {
    if (picked.length >= size) break;
    const word = entry.word.toLowerCase();
    if (!taken.has(word) && entry.definition.trim().length > 0) {
      picked.push(entry);
      taken.add(word);
    }
  }
  return picked;
}

interface BenchResult {
  scheme: string;
  accuracy: number;
  correct: number;
  total: number;
  siblingConfusions: number;
  confusions: string[];
}

interface GeneralizationResult {
  scheme: string;
  hits: number;
  holdouts: number;
  rate: number;
  misses: string[];
}

/**
 * H3 — category retrieval on NEVER-TAUGHT words. Each cluster contributes
 * up to 3 taught siblings and 1 held-out sibling; the held-out word (in
 * vocabulary, never taught) is the recall cue, and a hit means the top
 * trace is a taught same-parent sibling. Hash signatures give the held-out
 * cue no prime overlap with anything, so this isolates exactly what
 * semantic inheritance adds to the field.
 */
async function benchGeneralization(
  scheme: string,
  structured: readonly DeckWord[],
  vocabulary: Record<string, number[]>,
  parents: ReadonlyMap<string, string>
): Promise<GeneralizationResult> {
  const byWord = new Map(structured.map((entry) => [entry.word.toLowerCase(), entry]));
  const taught: DeckWord[] = [];
  const holdouts: Array<{ word: string; parent: string }> = [];
  for (const cluster of siblingClusters(structured)) {
    if (holdouts.length >= H3_CLUSTERS) break;
    const defined = cluster.words.filter((word) => {
      const entry = byWord.get(word);
      return entry !== undefined && entry.definition.trim().length > 0;
    });
    if (defined.length < 3) continue;
    for (const word of defined.slice(0, 3)) taught.push(byWord.get(word) as DeckWord);
    holdouts.push({ word: defined[3] ?? defined[defined.length - 1], parent: cluster.parent });
  }
  // A holdout that is also taught (tiny cluster fallback) must be excluded.
  const taughtSet = new Set(taught.map((entry) => entry.word.toLowerCase()));
  const probes = holdouts.filter((h) => !taughtSet.has(h.word));

  const session = new ObserverSession(
    // Production sketch width (P3): the fold-era default (JL-16) measured 12
    // points lower on this recognition bench than the width-128 sketch.
    { primeCount: 128, gridSize: 256, memoryMode: 'compact', memoryCapacity: 5000, smfWidth: 128, vocabulary },
    100
  );
  await session.initialize();
  const teacher = new TeacherAgent(session, taught);
  for (const entry of taught) teacher.teach(entry.word);

  let hits = 0;
  const misses: string[] = [];
  for (const probe of probes) {
    const results = session.recall(probe.word, 1);
    const top = results[0]?.trace.content.split(':')[0]?.trim().toLowerCase() ?? '(blank)';
    if (parents.get(top) === probe.parent) {
      hits += 1;
    } else {
      misses.push(`${probe.word} (${probe.parent}) -> ${top}`);
    }
  }

  session.dispose();
  return { scheme, hits, holdouts: probes.length, rate: probes.length === 0 ? 0 : hits / probes.length, misses };
}

async function benchScheme(
  scheme: string,
  deck: readonly DeckWord[],
  vocabulary: Record<string, number[]>,
  parents: ReadonlyMap<string, string>
): Promise<BenchResult> {
  const session = new ObserverSession(
    { primeCount: 128, gridSize: 256, memoryMode: 'compact', memoryCapacity: 5000, smfWidth: 128, vocabulary },
    100
  );
  await session.initialize();
  const teacher = new TeacherAgent(session, [...deck]);

  for (const entry of deck) teacher.teach(entry.word);

  let correct = 0;
  let siblingConfusions = 0;
  const confusions: string[] = [];
  const words = teacher.listWords().filter((w) => w.traceId !== null);
  for (const state of words) {
    const answer = teacher.ask(state.word.word, 'recognition');
    if (answer.recall !== null && answer.recall.trace.id === state.traceId) {
      correct += 1;
    } else {
      const got = answer.recall !== null ? answer.recall.trace.content.split(':')[0] : '(blank)';
      confusions.push(`${state.word.word} -> ${got}`);
      // Interference metric: was the wrong answer a sibling (same is-a parent)?
      const asked = state.word.word.toLowerCase();
      const gotWord = got.trim().toLowerCase();
      if (parents.get(asked) !== undefined && parents.get(asked) === parents.get(gotWord)) {
        siblingConfusions += 1;
      }
    }
  }

  session.dispose();
  return { scheme, accuracy: correct / words.length, correct, total: words.length, siblingConfusions, confusions };
}

function overlapReport(
  vocabulary: Record<string, number[]>,
  parents: ReadonlyMap<string, string>,
  categoryPrimes: ReadonlyMap<string, number>
): { siblingMean: number; siblingN: number; unrelatedMean: number; unrelatedN: number } {
  const children = new Map<string, string[]>();
  for (const [word, parent] of parents) {
    if (!categoryPrimes.has(parent) || vocabulary[word] === undefined) continue;
    const list = children.get(parent) ?? [];
    list.push(word);
    children.set(parent, list);
  }
  const siblingScores: number[] = [];
  for (const list of children.values()) {
    for (let i = 0; i < list.length - 1 && siblingScores.length < 500; i += 1) {
      siblingScores.push(jaccard(vocabulary[list[i]], vocabulary[list[i + 1]]));
    }
  }
  const words = Object.keys(vocabulary).sort((a, b) => fnv1a(a) - fnv1a(b));
  const unrelatedScores: number[] = [];
  for (let i = 0; i + 1 < words.length && unrelatedScores.length < 500; i += 2) {
    const [a, b] = [words[i], words[i + 1]];
    if (parents.get(a) !== undefined && parents.get(a) === parents.get(b)) continue;
    unrelatedScores.push(jaccard(vocabulary[a], vocabulary[b]));
  }
  const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);
  return {
    siblingMean: mean(siblingScores),
    siblingN: siblingScores.length,
    unrelatedMean: mean(unrelatedScores),
    unrelatedN: unrelatedScores.length
  };
}

async function main(): Promise<void> {
  const deck = benchDeck(WORDS);
  // Assignment over the structured slice: is-a parents are rarely among the
  // bench words themselves; a bench-only assignment would degrade to hash.
  const structured = DECK_20000.slice(0, 5000) as readonly DeckWord[];
  const assignment = semanticAssignment(structured, PRIME_SPACE);
  const fusionAssignment = semanticAssignment(structured, PRIME_SPACE, { categoryStrategy: 'fusion' });
  const hashVocabulary = deckVocabulary(structured, PRIME_SPACE);

  console.log(`SIGNATURE BENCH — ${deck.length} sibling-cluster words from DECK_20000, 128-prime field\n`);

  // H1 — overlap structure (only meaningful for the semantic scheme; the
  // hash numbers are the control's baseline noise).
  const semanticOverlap = overlapReport(assignment.vocabulary, assignment.parents, assignment.categoryPrimes);
  const hashOverlap = overlapReport(hashVocabulary, assignment.parents, assignment.categoryPrimes);
  console.log('H1 — sibling vs unrelated Jaccard overlap:');
  console.log(
    `  semantic: siblings ${semanticOverlap.siblingMean.toFixed(3)} (n=${semanticOverlap.siblingN})` +
      `  unrelated ${semanticOverlap.unrelatedMean.toFixed(3)} (n=${semanticOverlap.unrelatedN})`
  );
  console.log(
    `  hash:     siblings ${hashOverlap.siblingMean.toFixed(3)} (n=${hashOverlap.siblingN})` +
      `  unrelated ${hashOverlap.unrelatedMean.toFixed(3)} (n=${hashOverlap.unrelatedN})\n`
  );

  // H2 — recall accuracy plus interference, both schemes.
  const results: BenchResult[] = [];
  results.push(await benchScheme('hash (control)', deck, hashVocabulary, assignment.parents));
  results.push(await benchScheme('semantic', deck, assignment.vocabulary, assignment.parents));

  console.log('H2 — top-1 recognition accuracy:');
  for (const r of results) {
    console.log(
      `  ${r.scheme.padEnd(16)} ${(r.accuracy * 100).toFixed(1)}% (${r.correct}/${r.total})` +
        `  sibling confusions: ${r.siblingConfusions}`
    );
    for (const line of r.confusions.slice(0, 5)) console.log(`    confusion: ${line}`);
  }

  const [hash, semantic] = results;
  const delta = (semantic.accuracy - hash.accuracy) * 100;
  console.log(`\nH2 VERDICT: semantic − hash = ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} points (no degradation required)\n`);

  // H3 — generalization to never-taught sibling words.
  const h3Results: GeneralizationResult[] = [];
  h3Results.push(await benchGeneralization('hash (control)', structured, hashVocabulary, assignment.parents));
  h3Results.push(await benchGeneralization('semantic', structured, assignment.vocabulary, assignment.parents));

  console.log('H3 — category retrieval on never-taught words (top-1 recall is a same-parent sibling):');
  for (const r of h3Results) {
    console.log(`  ${r.scheme.padEnd(16)} ${(r.rate * 100).toFixed(1)}% (${r.hits}/${r.holdouts})`);
    for (const line of r.misses.slice(0, 4)) console.log(`    miss: ${line}`);
  }
  const [h3Hash, h3Semantic] = h3Results;
  const h3Delta = (h3Semantic.rate - h3Hash.rate) * 100;
  console.log(`\nH3 VERDICT: semantic − hash = ${h3Delta >= 0 ? '+' : ''}${h3Delta.toFixed(1)} points` +
    ` (H3 asks: untaught siblings retrieve their category)`);

  // H5 — same inherited-set structure, only category-prime minting differs.
  const h5Control = await benchGeneralization(
    'hash-minted', structured, assignment.vocabulary, assignment.parents
  );
  const h5Fusion = await benchGeneralization(
    'fusion-minted', structured, fusionAssignment.vocabulary, fusionAssignment.parents
  );
  console.log('\nH5 — triadic fusion vs hash-probed category-prime minting:');
  for (const r of [h5Control, h5Fusion]) {
    console.log(`  ${r.scheme.padEnd(16)} ${(r.rate * 100).toFixed(1)}% (${r.hits}/${r.holdouts})`);
  }
  const h5Delta = (h5Fusion.rate - h5Control.rate) * 100;
  console.log(`\nH5 VERDICT: fusion − hash-minted = ${h5Delta >= 0 ? '+' : ''}${h5Delta.toFixed(1)} points` +
    ` (fusion must improve retrieval to justify its arithmetic)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
