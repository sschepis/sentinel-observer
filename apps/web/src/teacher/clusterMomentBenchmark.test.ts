/**
 * @jest-environment node
 */
/**
 * CLUSTER-GATED vs GLOBAL-R-GATED EMISSION — the moment criterion A/B.
 *
 * THE HYPOTHESIS UNDER TEST. `coherence` is the GLOBAL Kuramoto order
 * parameter R over the active oscillators, and a moment is emitted when R
 * crosses `momentThreshold` going up. A globally synchronized field carries
 * almost no information: R -> 1 means every active oscillator shares one
 * phase, so the phase configuration is a single point. The informative
 * regime for coupled oscillators is PARTIAL (cluster / chimera)
 * synchronization: several groups lock internally at DIFFERENT phases, and
 * WHICH groups lock is a partition — combinatorial, not a point. If the
 * emission criterion is what starves the code of information, gating on
 * cluster structure instead should RAISE the retrieval margin.
 *
 * WHAT IS MEASURED, identically on both arms:
 *   1. the distribution of emitted moments (count, rate, cluster count at
 *      emission) during teaching AND during a free-running probe;
 *   2. RETRIEVAL MARGIN over the taught conversation cues — top-1 rank rate,
 *      mean true score, mean best-distractor score, mean margin;
 *   3. the sketch DC ratio and the mean unrelated-pair cosine;
 *   4. conversation competency and word recognition (the honest controls
 *      that must not regress).
 *
 * TWO EXTRA CONTROLS, because an emission criterion that fires is not the
 * same as an emission criterion that fires on ORGANIZATION:
 *   - the UNCOUPLED (K = 0) baseline. An ensemble of independent oscillators
 *     drifts through many transient phase partitions. A cluster criterion
 *     that fires just as often there is measuring accidental bunching, not
 *     locking — exactly the role the random-split baseline plays for the
 *     auto-sharder in docs/SCALING.md section 14.
 *   - the SETTLE DEPTH experiment. Emission is decoupled from storage in
 *     this engine (the teacher stores unconditionally), so the two arms
 *     above cannot differ in retrieval by construction. The phase
 *     configuration DOES reach retrieval through another path: the compact
 *     bank stores the moment's phases and scores a cue by their order
 *     parameter. Storing and recalling at a settle depth where the field has
 *     actually entered the cluster regime is therefore the causal test of
 *     "does a stored PARTITION retrieve better than a stored POINT".
 *
 * Run with `npm run test:bench -- clusterMomentBenchmark` or directly:
 *   npx jest src/teacher/clusterMomentBenchmark.test.ts
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation';
import { MemoryPersistenceStore } from '../persistence/store';
import {
  phaseClusterMetrics,
  type MomentCriterion,
  type SemanticMoment
} from '@sschepis/sentient-core';

// The teacher's own recall preamble (TeacherAgent.exciteAndSettle).
const RECALL_SETTLE_STEPS = 4;
const SETTLE_DT = 0.05;

const WORDS = Number(process.env.CLUSTER_BENCH_WORDS ?? 200);
const PAIRS = Number(process.env.CLUSTER_BENCH_PAIRS ?? ALL_CONVERSATION_PAIRS.length);
const MARGIN_CUES = Number(process.env.CLUSTER_BENCH_CUES ?? 200);
/** Free-run probe: how deep the field is allowed to evolve, and on how many cues. */
const FREE_RUN_TICKS = Number(process.env.CLUSTER_BENCH_FREE_TICKS ?? 600);
const FREE_RUN_CUES = Number(process.env.CLUSTER_BENCH_FREE_CUES ?? 20);
/** Settle-depth experiment: smaller, because every store costs DEPTH ticks. */
const DEPTH_PAIRS = Number(process.env.CLUSTER_BENCH_DEPTH_PAIRS ?? 200);
const DEPTH_WORDS = Number(process.env.CLUSTER_BENCH_DEPTH_WORDS ?? 60);
const DEEP_TICKS = Number(process.env.CLUSTER_BENCH_DEPTH ?? 200);

// ═══════════════════════════════════════════════════════════════════════════
// MEASUREMENTS
// ═══════════════════════════════════════════════════════════════════════════

interface MarginReading {
  cues: number;
  inTop5: number;
  rankedFirst: number;
  top1Rate: number;
  meanTrueScore: number;
  meanDistractorScore: number;
  meanMargin: number;
}

/**
 * The retrieval distribution over taught cues, as recorded in
 * docs/SCALING.md section 15: for each cue, is the trace it taught ranked
 * FIRST, what does it score, what does the best competitor score, and what
 * is the separation between them. The margin is the number that must RISE if
 * the emitted code carries more information.
 */
function measureMargin(
  session: ObserverSession,
  cueToTraceId: ReadonlyMap<string, string>,
  cues: readonly string[]
): MarginReading {
  let inTop5 = 0;
  let rankedFirst = 0;
  let trueSum = 0;
  let distractorSum = 0;
  let marginSum = 0;
  let scored = 0;

  for (const cue of cues) {
    const trueId = cueToTraceId.get(cue);
    if (trueId === undefined) continue;

    session.settleField();
    session.observeText(cue);
    session.observer.tick(0.02);
    for (let i = 0; i < RECALL_SETTLE_STEPS; i++) session.observer.tick(SETTLE_DT);

    const results = session.recall(cue, 5);
    const index = results.findIndex(r => r.trace.id === trueId);
    if (index >= 0) inTop5 += 1;
    if (index === 0) rankedFirst += 1;

    const trueScore = index >= 0 ? results[index].score : 0;
    let best = 0;
    for (const r of results) {
      if (r.trace.id === trueId) continue;
      if (r.score > best) best = r.score;
    }
    trueSum += trueScore;
    distractorSum += best;
    marginSum += trueScore - best;
    scored += 1;
  }

  const n = Math.max(1, scored);
  return {
    cues: scored,
    inTop5,
    rankedFirst,
    top1Rate: rankedFirst / n,
    meanTrueScore: trueSum / n,
    meanDistractorScore: distractorSum / n,
    meanMargin: marginSum / n
  };
}

interface SketchReading {
  traces: number;
  dcRatio: number;
  meanUnrelatedCosine: number;
}

/**
 * The sketch's shared component. `dcRatio` is the norm of the corpus MEAN
 * sketch over the mean trace norm — how much of a typical trace is the
 * component every trace shares. `meanUnrelatedCosine` samples deterministic
 * random trace pairs (a fixed LCG, so the reading is reproducible), which is
 * where that shared component shows up as a similarity floor.
 */
function measureSketch(session: ObserverSession): SketchReading {
  const vectors: number[][] = [];
  for (const trace of session.observer.getMemoryBank().all()) {
    vectors.push(trace.smf.toArray());
  }
  if (vectors.length < 2) return { traces: vectors.length, dcRatio: 0, meanUnrelatedCosine: 0 };

  const width = vectors[0].length;
  const mean = new Array<number>(width).fill(0);
  let normSum = 0;
  for (const v of vectors) {
    let sq = 0;
    for (let i = 0; i < width; i++) {
      mean[i] += v[i];
      sq += v[i] * v[i];
    }
    normSum += Math.sqrt(sq);
  }
  let meanSq = 0;
  for (let i = 0; i < width; i++) {
    mean[i] /= vectors.length;
    meanSq += mean[i] * mean[i];
  }
  const meanNorm = normSum / vectors.length;
  const dcRatio = meanNorm > 0 ? Math.sqrt(meanSq) / meanNorm : 0;

  // Deterministic pair sampling: a fixed-seed LCG, so "unrelated pair" is a
  // reproducible sample of the whole corpus rather than an artifact of
  // insertion order (words are stored before conversations).
  let seed = 0x5eed;
  const nextIndex = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % vectors.length;
  };
  let cosSum = 0;
  let pairs = 0;
  const samples = Math.min(20000, vectors.length * 20);
  for (let s = 0; s < samples; s++) {
    const i = nextIndex();
    const j = nextIndex();
    if (i === j) continue;
    const a = vectors[i];
    const b = vectors[j];
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let k = 0; k < width; k++) {
      dot += a[k] * b[k];
      na += a[k] * a[k];
      nb += b[k] * b[k];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    if (denom > 0) {
      cosSum += dot / denom;
      pairs += 1;
    }
  }

  return {
    traces: vectors.length,
    dcRatio,
    meanUnrelatedCosine: pairs > 0 ? cosSum / pairs : 0
  };
}

interface EmissionReading {
  moments: number;
  ticks: number;
  perThousandTicks: number;
  clusterCountHistogram: Record<number, number>;
  meanWithinR: number;
  meanBetweenR: number;
  meanCoherence: number;
}

function summarizeMoments(moments: readonly SemanticMoment[], ticks: number): EmissionReading {
  const histogram: Record<number, number> = {};
  let withinSum = 0;
  let betweenSum = 0;
  let coherenceSum = 0;
  for (const m of moments) {
    histogram[m.clusters.clusterCount] = (histogram[m.clusters.clusterCount] ?? 0) + 1;
    withinSum += m.clusters.withinR;
    betweenSum += m.clusters.betweenR;
    coherenceSum += m.coherence;
  }
  const n = Math.max(1, moments.length);
  return {
    moments: moments.length,
    ticks,
    perThousandTicks: ticks > 0 ? (moments.length * 1000) / ticks : 0,
    clusterCountHistogram: histogram,
    meanWithinR: moments.length > 0 ? withinSum / n : 0,
    meanBetweenR: moments.length > 0 ? betweenSum / n : 0,
    meanCoherence: moments.length > 0 ? coherenceSum / n : 0
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ARMS
// ═══════════════════════════════════════════════════════════════════════════

interface Arm {
  criterion: MomentCriterion;
  session: ObserverSession;
  teacher: TeacherAgent;
  cueToTraceId: Map<string, string>;
  teachingEmission: EmissionReading;
  freeRunEmission: EmissionReading;
  margin: MarginReading;
  sketch: SketchReading;
  competency: number;
  wordRecognition: number;
  wallMs: number;
}

async function runArm(criterion: MomentCriterion): Promise<Arm> {
  const started = Date.now();
  const session = new ObserverSession({ ...OBSERVER_OPTIONS, momentCriterion: criterion }, 100);
  await session.initialize();

  const captured: SemanticMoment[] = [];
  const subscription = session.observer.moments.subscribe(m => captured.push(m));

  const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 500);
  const words = ACTIVE_DECK.slice(0, WORDS);
  for (const entry of words) teacher.teach(entry.word);
  teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS.slice(0, PAIRS));
  for (const pair of ALL_CONVERSATION_PAIRS.slice(0, PAIRS)) teacher.respond(pair.cue);

  const teachingTicks = session.observer.getState().tickCount;
  const teachingEmission = summarizeMoments(captured, teachingTicks);
  const competency = teacher.conversationReport().competency;

  // Cue -> the trace its lesson actually created.
  const cueToTraceId = new Map<string, string>();
  for (const trace of session.observer.getMemoryBank().all()) {
    const meta = trace.metadata;
    if (meta?.kind === 'conversation' && typeof meta.cue === 'string') {
      cueToTraceId.set(meta.cue, trace.id);
    }
  }

  const cues = ALL_CONVERSATION_PAIRS.slice(0, PAIRS)
    .map(p => p.cue.toLowerCase())
    .filter(c => cueToTraceId.has(c))
    .slice(0, MARGIN_CUES);
  const margin = measureMargin(session, cueToTraceId, cues);

  // Word recognition: cueing a taught word must rank ITS OWN lesson trace
  // first. `teach()` stores the lesson text, not the word, so the trace id
  // comes from the teacher's own word state rather than from trace content.
  let recognized = 0;
  let attempted = 0;
  const traceIdByWord = new Map<string, string>();
  for (const state of teacher.listWords()) {
    if (state.traceId !== null) traceIdByWord.set(state.word.word, state.traceId);
  }
  for (const entry of words) {
    const expected = traceIdByWord.get(entry.word);
    if (expected === undefined) continue;
    attempted += 1;
    session.settleField();
    session.observeText(entry.word);
    session.observer.tick(0.02);
    const top = session.recall(entry.word, 5)[0];
    if (top !== undefined && top.trace.id === expected) recognized += 1;
  }

  const sketch = measureSketch(session);

  // FREE-RUN PROBE: the same criterion, but the field is allowed to evolve
  // far past the single tick the teacher gives it. This is where partial
  // synchronization can actually appear.
  captured.length = 0;
  const beforeFreeRun = session.observer.getState().tickCount;
  for (const pair of ALL_CONVERSATION_PAIRS.slice(0, FREE_RUN_CUES)) {
    session.settleField();
    session.observeText(pair.cue);
    for (let i = 0; i < FREE_RUN_TICKS; i++) session.observer.tick(0.02);
  }
  const freeRunEmission = summarizeMoments(
    captured,
    session.observer.getState().tickCount - beforeFreeRun
  );

  subscription.unsubscribe();
  return {
    criterion,
    session,
    teacher,
    cueToTraceId,
    teachingEmission,
    freeRunEmission,
    margin,
    sketch,
    competency,
    wordRecognition: attempted > 0 ? recognized / attempted : 0,
    wallMs: Date.now() - started
  };
}

function report(label: string, value: string): void {
  // eslint-disable-next-line no-console
  console.log(`[clusterMomentBench] ${label.padEnd(38)} ${value}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// THE BENCHMARK
// ═══════════════════════════════════════════════════════════════════════════

describe('cluster-gated vs global-R-gated moment emission', () => {
  it('measures both arms on emission, retrieval margin, sketch DC and the controls', async () => {
    const control = await runArm('global-R');
    const cluster = await runArm('phase-clusters');

    // eslint-disable-next-line no-console
    console.log(
      `\n[clusterMomentBench] words=${WORDS} pairs=${PAIRS} marginCues=${control.margin.cues} ` +
        `freeRun=${FREE_RUN_CUES}x${FREE_RUN_TICKS} ticks\n`
    );

    for (const arm of [control, cluster]) {
      const t = arm.teachingEmission;
      const f = arm.freeRunEmission;
      // eslint-disable-next-line no-console
      console.log(`--- arm: ${arm.criterion} (${(arm.wallMs / 1000).toFixed(1)}s) ---`);
      report('moments emitted while teaching', `${t.moments} over ${t.ticks} ticks (${t.perThousandTicks.toFixed(2)}/1k)`);
      report('  cluster count at emission', JSON.stringify(t.clusterCountHistogram));
      report('  mean withinR / betweenR', `${t.meanWithinR.toFixed(3)} / ${t.meanBetweenR.toFixed(3)}`);
      report('  mean coherence at emission', t.meanCoherence.toFixed(4));
      report('moments emitted free-running', `${f.moments} over ${f.ticks} ticks (${f.perThousandTicks.toFixed(2)}/1k)`);
      report('  cluster count at emission', JSON.stringify(f.clusterCountHistogram));
      report('  mean withinR / betweenR', `${f.meanWithinR.toFixed(3)} / ${f.meanBetweenR.toFixed(3)}`);
      report('top-1 rank rate', `${(arm.margin.top1Rate * 100).toFixed(1)}% (${arm.margin.rankedFirst}/${arm.margin.cues})`);
      report('true trace in top-5', `${arm.margin.inTop5}/${arm.margin.cues}`);
      report('mean true score', arm.margin.meanTrueScore.toFixed(4));
      report('mean best-distractor score', arm.margin.meanDistractorScore.toFixed(4));
      report('MEAN MARGIN', arm.margin.meanMargin.toFixed(4));
      report('sketch DC ratio', arm.sketch.dcRatio.toFixed(4));
      report('mean unrelated-pair cosine', arm.sketch.meanUnrelatedCosine.toFixed(4));
      report('conversation competency', `${(arm.competency * 100).toFixed(1)}%`);
      report('word recognition', `${(arm.wordRecognition * 100).toFixed(1)}%`);
      report('traces', String(arm.sketch.traces));
    }

    const delta = cluster.margin.meanMargin - control.margin.meanMargin;
    // eslint-disable-next-line no-console
    console.log(
      `\n[clusterMomentBench] VERDICT margin ${control.margin.meanMargin.toFixed(4)} -> ` +
        `${cluster.margin.meanMargin.toFixed(4)} (${delta >= 0 ? '+' : ''}${delta.toFixed(4)}), ` +
        `top-1 ${(control.margin.top1Rate * 100).toFixed(1)}% -> ${(cluster.margin.top1Rate * 100).toFixed(1)}%\n`
    );

    // ── Honest gates ───────────────────────────────────────────────────
    // The control must still be the control.
    expect(control.margin.top1Rate).toBeGreaterThanOrEqual(0.9);
    expect(control.competency).toBeGreaterThanOrEqual(0.9);
    // The opt-in criterion must not regress anything.
    expect(cluster.margin.top1Rate).toBeGreaterThanOrEqual(control.margin.top1Rate - 0.02);
    expect(cluster.competency).toBeGreaterThanOrEqual(control.competency - 0.02);
    expect(cluster.wordRecognition).toBeGreaterThanOrEqual(control.wordRecognition - 0.02);
    // Emission is decoupled from storage, so both arms must hold the same
    // corpus. If this ever fails, the criterion has become causal and the
    // interpretation of the retrieval numbers changes.
    expect(cluster.sketch.traces).toBe(control.sketch.traces);

    control.session.dispose();
    cluster.session.dispose();
  }, 1800000);

  it('checks the cluster criterion against the UNCOUPLED (K=0) baseline', async () => {
    // A coupled field that clusters is organized. An UNCOUPLED field also
    // drifts through phase partitions — accidental bunching of independent
    // frequencies. A criterion that cannot tell them apart is measuring
    // nothing, exactly as an auto-shard split that cannot beat a random
    // split of the same sizes is measuring nothing (SCALING.md section 14).
    const probe = async (coupling: number): Promise<EmissionReading> => {
      const session = new ObserverSession(
        { ...OBSERVER_OPTIONS, coupling, momentCriterion: 'phase-clusters' },
        100
      );
      await session.initialize();
      const captured: SemanticMoment[] = [];
      const subscription = session.observer.moments.subscribe(m => captured.push(m));
      let ticks = 0;
      for (const pair of ALL_CONVERSATION_PAIRS.slice(0, FREE_RUN_CUES)) {
        session.settleField();
        session.observeText(pair.cue);
        for (let i = 0; i < FREE_RUN_TICKS; i++) {
          session.observer.tick(0.02);
          ticks += 1;
        }
      }
      subscription.unsubscribe();
      session.dispose();
      return summarizeMoments(captured, ticks);
    };

    // OBSERVER_OPTIONS does not set `coupling`, so the field runs at the
    // engine default K = 0.45. Named here so the baseline is explicit.
    const coupled = await probe(0.45);
    const uncoupled = await probe(0);

    // eslint-disable-next-line no-console
    console.log('\n[clusterMomentBench] --- cluster criterion vs the uncoupled baseline ---');
    report('coupled K=0.45 moments', `${coupled.moments} over ${coupled.ticks} ticks (${coupled.perThousandTicks.toFixed(2)}/1k)`);
    report('  cluster counts', JSON.stringify(coupled.clusterCountHistogram));
    report('uncoupled K=0 moments', `${uncoupled.moments} over ${uncoupled.ticks} ticks (${uncoupled.perThousandTicks.toFixed(2)}/1k)`);
    report('  cluster counts', JSON.stringify(uncoupled.clusterCountHistogram));

    // Recorded, not asserted as a pass/fail on the physics: this reading is
    // the honest interpretation gate for every emission number above.
    expect(coupled.ticks).toBe(uncoupled.ticks);
  }, 1800000);

  it('settle depth: does a stored PARTITION retrieve better than a stored POINT?', async () => {
    // The causal test. Emission does not gate storage, but the stored PHASE
    // CONFIGURATION does reach retrieval (the compact bank scores a cue by
    // the order parameter of the stored-vs-cue phase differences). At the
    // teacher's depth of one tick after a settle, every trace is stored with
    // an essentially identical, fully synchronized phase configuration. This
    // arm stores and recalls at a depth where the field has actually entered
    // the partial-synchronization regime.
    const pairs = ALL_CONVERSATION_PAIRS.slice(0, DEPTH_PAIRS);

    const run = async (
      depth: number,
      coupling?: number
    ): Promise<{
      margin: MarginReading;
      clusterCountAtStore: Record<number, number>;
      meanR: number;
      meanWithinR: number;
      meanBetweenR: number;
    }> => {
      const session = new ObserverSession(
        coupling === undefined ? OBSERVER_OPTIONS : { ...OBSERVER_OPTIONS, coupling },
        100
      );
      await session.initialize();
      const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 500);
      for (const entry of ACTIVE_DECK.slice(0, DEPTH_WORDS)) teacher.teach(entry.word);

      const field = session.observer.getOscillatorField();
      const histogram: Record<number, number> = {};
      let rSum = 0;
      let withinSum = 0;
      let betweenSum = 0;
      let stored = 0;
      const cueToTraceId = new Map<string, string>();

      for (const pair of pairs) {
        const cue = pair.cue.toLowerCase();
        if (cueToTraceId.has(cue)) continue;
        session.settleField();
        session.observeText(pair.cue);
        for (let i = 0; i < depth; i++) session.observer.tick(i === 0 ? 0.02 : SETTLE_DT);
        const clusters = phaseClusterMetrics(field.getPhases(), field.getAmplitudes());
        const trace = session.storeMemory(pair.response, {
          metadata: { kind: 'conversation', cue }
        });
        if (trace === null) continue;
        cueToTraceId.set(cue, trace.id);
        histogram[clusters.clusterCount] = (histogram[clusters.clusterCount] ?? 0) + 1;
        rSum += field.getMetrics().coherence;
        withinSum += clusters.withinR;
        betweenSum += clusters.betweenR;
        stored += 1;
      }

      // Recall at the SAME depth: the cue's phase configuration must be
      // evolved as far as the stored one or the comparison is unfair.
      const cues = [...cueToTraceId.keys()];
      let inTop5 = 0;
      let rankedFirst = 0;
      let trueSum = 0;
      let distractorSum = 0;
      let marginSum = 0;
      for (const cue of cues) {
        const trueId = cueToTraceId.get(cue)!;
        session.settleField();
        session.observeText(cue);
        for (let i = 0; i < depth; i++) session.observer.tick(i === 0 ? 0.02 : SETTLE_DT);
        const results = session.recall(cue, 5);
        const index = results.findIndex(r => r.trace.id === trueId);
        if (index >= 0) inTop5 += 1;
        if (index === 0) rankedFirst += 1;
        const trueScore = index >= 0 ? results[index].score : 0;
        let best = 0;
        for (const r of results) {
          if (r.trace.id === trueId) continue;
          if (r.score > best) best = r.score;
        }
        trueSum += trueScore;
        distractorSum += best;
        marginSum += trueScore - best;
      }
      session.dispose();

      const n = Math.max(1, cues.length);
      const s = Math.max(1, stored);
      return {
        margin: {
          cues: cues.length,
          inTop5,
          rankedFirst,
          top1Rate: rankedFirst / n,
          meanTrueScore: trueSum / n,
          meanDistractorScore: distractorSum / n,
          meanMargin: marginSum / n
        },
        clusterCountAtStore: histogram,
        meanR: rSum / s,
        meanWithinR: withinSum / s,
        meanBetweenR: betweenSum / s
      };
    };

    const shallow = await run(1);
    const deep = await run(DEEP_TICKS);
    // THE CONTROL THAT DECIDES THE INTERPRETATION. Deep settling does two
    // things at once: it lets COUPLING organize the phases into clusters,
    // and it simply lets independent frequencies DEPHASE. An uncoupled field
    // run to the same depth gets the dephasing without the organization. If
    // it captures the same margin, the gain is dephasing — the clusters are
    // decoration.
    const deepUncoupled = await run(DEEP_TICKS, 0);

    // eslint-disable-next-line no-console
    console.log(
      `\n[clusterMomentBench] --- settle depth (${DEPTH_PAIRS} pairs, ${DEPTH_WORDS} words) ---`
    );
    for (const [label, arm] of [
      ['depth=1 (the teacher\'s depth)', shallow],
      [`depth=${DEEP_TICKS} K=0.45 (coupled)`, deep],
      [`depth=${DEEP_TICKS} K=0 (uncoupled control)`, deepUncoupled]
    ] as const) {
      report(`${label}: mean R at store`, arm.meanR.toFixed(4));
      report('  cluster count at store', JSON.stringify(arm.clusterCountAtStore));
      report('  mean withinR / betweenR', `${arm.meanWithinR.toFixed(3)} / ${arm.meanBetweenR.toFixed(3)}`);
      report('  top-1 rank rate', `${(arm.margin.top1Rate * 100).toFixed(1)}% (${arm.margin.rankedFirst}/${arm.margin.cues})`);
      report('  mean true score', arm.margin.meanTrueScore.toFixed(4));
      report('  mean best-distractor score', arm.margin.meanDistractorScore.toFixed(4));
      report('  MEAN MARGIN', arm.margin.meanMargin.toFixed(4));
    }
    const delta = deep.margin.meanMargin - shallow.margin.meanMargin;
    const deltaUncoupled = deepUncoupled.margin.meanMargin - shallow.margin.meanMargin;
    // eslint-disable-next-line no-console
    console.log(
      `[clusterMomentBench] DEPTH VERDICT margin ${shallow.margin.meanMargin.toFixed(4)} -> ` +
        `${deep.margin.meanMargin.toFixed(4)} coupled (${delta >= 0 ? '+' : ''}${delta.toFixed(4)}), ` +
        `${deepUncoupled.margin.meanMargin.toFixed(4)} UNCOUPLED (${deltaUncoupled >= 0 ? '+' : ''}${deltaUncoupled.toFixed(4)})\n`
    );

    // The shallow arm is the shipped behaviour; it must still be sane.
    expect(shallow.margin.cues).toBeGreaterThan(0);
    expect(deep.margin.cues).toBe(shallow.margin.cues);
    expect(deepUncoupled.margin.cues).toBe(shallow.margin.cues);
  }, 1800000);
});
