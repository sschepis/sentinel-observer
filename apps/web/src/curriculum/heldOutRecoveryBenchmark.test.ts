/**
 * @jest-environment node
 *
 * HELD-OUT RECOVERY, AND THE PREDICTION (docs/SYNTHETIC_MIND.md tasks 40 + 41).
 *
 * The feeder never ingests every tenth ConceptNet row. This bench feeds the
 * corpus step by step and, after each step, asks the observer about a fixed
 * sample of those held-out rows — claims it was never shown — and reads the
 * network entropy over a fixed set of concepts. Two things come out:
 *
 *   40. RECOVERY: how much of the unseen tenth the observer answers (flat,
 *       hedged), asks about, or gets wrong — by relation and by how it got
 *       there (direct edge, inheritance, the graded layer).
 *   41. THE PREDICTION: the principle says the steps that LOWER the network
 *       entropy most are the ones after which recovery improves most. The
 *       bench reports the Spearman rank correlation between the per-step
 *       entropy drop and the per-step recovery gain — and, as the null
 *       predictor, the same for "edges added". Reported whichever sign it
 *       has; the artifact is the result.
 *
 * Reads the operator's corpus (absent in CI): a measurement, not a unit test.
 *
 *   cd apps/web && npx jest -c jest.bench.config.cjs --testPathPatterns heldOutRecovery
 *   RECOVERY_STEPS=10 RECOVERY_BUDGET=1000 RECOVERY_PROBES=300 RECOVERY_TAUGHT=2000 …
 */
import { describe, it, expect } from '@jest/globals';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mulberry32 } from '@sschepis/sentient-core';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { CONCEPTNET_RELATIONS, parseConceptNetJsonl, type ConceptNetRow } from './conceptnet';
import { CurriculumFeeder, discoverSources } from './registry';
import { readYesNo, yesNoQuestion, type YesNoReading } from './questions';
import { auditAnswer } from '../teacher/soundness';
import { WORD_SHAPE } from './types';

const CORPUS = resolve(process.cwd(), process.env.RECOVERY_CORPUS ?? 'corpus');
const STEPS = Number(process.env.RECOVERY_STEPS ?? '10');
const BUDGET = Number(process.env.RECOVERY_BUDGET ?? '1000');
const PROBES = Number(process.env.RECOVERY_PROBES ?? '300');
const TAUGHT = Number(process.env.RECOVERY_TAUGHT ?? '2000');

interface Probe {
  row: ConceptNetRow;
  predicate: string;
  question: string;
}

interface StepRecord {
  step: number;
  rows: number;
  edgesAdded: number;
  grown: number;
  entropyTotal: number;
  entropyMean: number;
  entropyWeighted: number;
  entropyDelta: number;
  recovered: number;
  recoveredFlat: number;
  recoveredHedged: number;
  wrong: number;
  abstained: number;
  recoveryRate: number;
  recoveryDelta: number;
  byRelation: Record<string, { asked: number; recovered: number }>;
  byPath: Record<string, number>;
  ms: number;
}

/** Spearman rank correlation of two equal-length series (ties → mean rank). */
export function spearman(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const rank = (xs: readonly number[]): number[] => {
    const order = xs.map((x, i) => ({ x, i })).sort((p, q) => p.x - q.x);
    const ranks = new Array<number>(xs.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1].x === order[i].x) j += 1;
      const mean = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) ranks[order[k].i] = mean;
      i = j + 1;
    }
    return ranks;
  };
  const ra = rank(a.slice(0, n));
  const rb = rank(b.slice(0, n));
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let k = 0; k < n; k += 1) {
    cov += (ra[k] - ma) * (rb[k] - mb);
    va += (ra[k] - ma) ** 2;
    vb += (rb[k] - mb) ** 2;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
}

describe('held-out recovery + the prediction (src/curriculum)', () => {
  it('feeds the ConceptNet corpus step by step and measures recovery of the unseen tenth against the entropy drop', async () => {
    const sources = discoverSources(CORPUS).filter((source) => source.id === 'conceptnet');
    if (sources.length === 0) {
      console.log(`no corpus/conceptnet.en.jsonl under ${CORPUS} — run npm run fetch-conceptnet first; nothing measured`);
      return;
    }
    const session = new ObserverSession(OBSERVER_OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, ACTIVE_DECK, null, 500, 4, 7);
    for (const entry of ACTIVE_DECK.slice(0, TAUGHT)) teacher.teach(entry.word);
    const feeder = new CurriculumFeeder(teacher, sources);
    const source = sources[0];

    // The fixed concept set: the deck's single words (never the grown ones,
    // so vocabulary growth cannot move the mean by adding ignorance).
    const deckWords = new Set(ACTIVE_DECK.map((e) => e.word.toLowerCase()).filter((w) => WORD_SHAPE.test(w)));

    // The fixed held-out probe sample: rows with a closed question form, both
    // ends single words, drawn deterministically from the held-out tenth.
    const heldOut = parseConceptNetJsonl(feeder.heldOutRows(source).join('\n'));
    const rng = mulberry32(0x5eed);
    const candidates: Probe[] = [];
    for (const row of heldOut) {
      const mapping = CONCEPTNET_RELATIONS[row.rel];
      if (mapping === undefined || mapping.negation === true) continue;
      if (!WORD_SHAPE.test(row.start) || !WORD_SHAPE.test(row.end)) continue;
      const subject = mapping.swap === true ? row.end : row.start;
      const object = mapping.swap === true ? row.start : row.end;
      const question = yesNoQuestion(mapping.predicate, subject, object);
      if (question === null) continue;
      candidates.push({ row, predicate: mapping.predicate, question });
    }
    for (let i = candidates.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const probes = candidates.slice(0, PROBES);
    console.log(`held-out rows: ${heldOut.length} · askable: ${candidates.length} · probing ${probes.length} · feeding ${STEPS} × ${BUDGET} rows of ${feeder.remaining(source)}`);

    const store = teacher.soundnessStore();
    const measure = (step: number, rows: number, edgesAdded: number, grown: number, previous: StepRecord | null): StepRecord => {
      const started = Date.now();
      const entropy = teacher.networkEntropy({ concepts: deckWords, topN: 0 });
      const byRelation: Record<string, { asked: number; recovered: number }> = {};
      const byPath: Record<string, number> = {};
      let recoveredFlat = 0;
      let recoveredHedged = 0;
      let wrong = 0;
      let abstained = 0;
      for (const probe of probes) {
        const answer = teacher.chatAnswer(probe.question);
        const reading: YesNoReading = readYesNo(answer);
        const rel = (byRelation[probe.predicate] ??= { asked: 0, recovered: 0 });
        rel.asked += 1;
        if (reading === 'yes' || reading === 'yes-hedged') {
          rel.recovered += 1;
          if (reading === 'yes') recoveredFlat += 1;
          else recoveredHedged += 1;
          // How it got there — the soundness checker's reading of the derivation.
          const verdict = auditAnswer(answer, store);
          const path = verdict.kind === 'graded' ? 'graded layer' : /inherited/.test(verdict.reason) ? 'inherited' : /direct/.test(verdict.reason) ? 'direct edge' : verdict.kind;
          byPath[path] = (byPath[path] ?? 0) + 1;
        } else if (reading === 'no') wrong += 1;
        else abstained += 1;
      }
      const recovered = recoveredFlat + recoveredHedged;
      const recoveryRate = probes.length === 0 ? 0 : recovered / probes.length;
      return {
        step,
        rows,
        edgesAdded,
        grown,
        entropyTotal: entropy.total,
        entropyMean: entropy.mean,
        entropyWeighted: entropy.weightedTotal,
        entropyDelta: previous === null ? 0 : Math.round((entropy.mean - previous.entropyMean) * 1e6) / 1e6,
        recovered,
        recoveredFlat,
        recoveredHedged,
        wrong,
        abstained,
        recoveryRate,
        recoveryDelta: previous === null ? 0 : recoveryRate - previous.recoveryRate,
        byRelation,
        byPath,
        ms: Date.now() - started
      };
    };

    const series: StepRecord[] = [];
    let record = measure(0, 0, 0, 0, null);
    series.push(record);
    console.log(`  step 0: entropy mean ${record.entropyMean.toFixed(3)} · recovery ${(record.recoveryRate * 100).toFixed(1)}% (${record.recoveredFlat} flat, ${record.recoveredHedged} hedged, ${record.wrong} wrong, ${record.abstained} asked) · ${record.ms} ms`);
    for (let step = 1; step <= STEPS; step += 1) {
      const fed = feeder.feed(source, BUDGET);
      record = measure(step, fed.rows, fed.accepted, fed.grown, record);
      series.push(record);
      console.log(
        `  step ${step}: +${fed.accepted} edges (+${fed.grown} words) · entropy mean ${record.entropyMean.toFixed(3)} (Δ ${record.entropyDelta >= 0 ? '+' : ''}${record.entropyDelta.toFixed(4)}) · recovery ${(record.recoveryRate * 100).toFixed(1)}% (Δ ${record.recoveryDelta >= 0 ? '+' : ''}${(record.recoveryDelta * 100).toFixed(1)}) · ${record.recoveredFlat} flat, ${record.recoveredHedged} hedged, ${record.wrong} wrong, ${record.abstained} asked · ${record.ms} ms`
      );
      if (fed.remaining === 0) break;
    }

    // THE PREDICTION. A drop in entropy is a negative Δ; the principle says
    // larger drops go with larger recovery gains — so the expected sign of
    // rho(Δentropy, Δrecovery) is NEGATIVE. The null predictor is edges added.
    const steps = series.slice(1);
    const rhoEntropy = spearman(steps.map((s) => s.entropyDelta), steps.map((s) => s.recoveryDelta));
    const rhoEdges = spearman(steps.map((s) => s.edgesAdded), steps.map((s) => s.recoveryDelta));
    const first = series[0];
    const last = series[series.length - 1];
    const summary = {
      at: new Date().toISOString(),
      corpus: source.path,
      config: { steps: STEPS, budget: BUDGET, probes: probes.length, taught: TAUGHT, heldOutRows: heldOut.length, askable: candidates.length },
      recovery: { before: first.recoveryRate, after: last.recoveryRate, byRelation: last.byRelation, byPath: last.byPath, wrongAfter: last.wrong, abstainedAfter: last.abstained },
      entropy: { meanBefore: first.entropyMean, meanAfter: last.entropyMean, totalBefore: first.entropyTotal, totalAfter: last.entropyTotal },
      prediction: {
        statement: 'steps that lower the network entropy most show the largest held-out recovery gains: expect rho(Δentropy, Δrecovery) < 0',
        rhoEntropyDelta: rhoEntropy,
        rhoEdgesAddedNull: rhoEdges,
        steps: steps.length
      },
      series
    };
    const dir = resolve(process.cwd(), '..', '..', 'bench', 'curriculum');
    mkdirSync(dir, { recursive: true });
    const out = resolve(dir, `held-out-recovery-${new Date().toISOString().slice(0, 10)}.json`);
    writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      `\n=== held-out recovery: ${(first.recoveryRate * 100).toFixed(1)}% → ${(last.recoveryRate * 100).toFixed(1)}% over ${steps.length} steps · entropy mean ${first.entropyMean.toFixed(3)} → ${last.entropyMean.toFixed(3)}\n` +
        `    by path after: ${Object.entries(last.byPath).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}\n` +
        `    by relation after: ${Object.entries(last.byRelation).map(([k, v]) => `${k} ${v.recovered}/${v.asked}`).join(', ')}\n` +
        `    THE PREDICTION: rho(Δentropy, Δrecovery) = ${rhoEntropy === null ? 'n/a' : rhoEntropy.toFixed(3)} (expect < 0) · null predictor rho(edges added, Δrecovery) = ${rhoEdges === null ? 'n/a' : rhoEdges.toFixed(3)}\n` +
        `    → ${out}`
    );
    expect(existsSync(out)).toBe(true);
    session.dispose();
  }, 60 * 60 * 1000);
});
