/**
 * @jest-environment node
 */
/**
 * P12 THE FALSIFIER — does competition rescue sketch CENTERING?
 *
 * docs/SCALING.md §15 records a negative result: `centerSketches` (subtract
 * the corpus mean from both sides of the SMF cosine) collapses top-1 recall
 * from 98.5% to 33.3% and drives the mean margin negative. The stated reason
 * was that the shared component is not noise — it carries signal.
 *
 * THE COMPETITION HYPOTHESIS makes a falsifiable prediction about that: if
 * the shared component exists because purely positive coupling locks the
 * whole field into one global mode, then a field that COMPETES should not
 * have a dominant shared mode, and removing the mean should stop being
 * catastrophic. If centering still destroys ranking under competition, the
 * collapse is NOT caused by the coupling and the §15 conclusion stands on
 * its own.
 *
 * This runs the 2x2: {no competition, competition} x {centering off, on},
 * on one curriculum, with everything else identical.
 */
import { describe, it, expect } from '@jest/globals';
import type { SemanticObserverOptions, TraceLike } from '@sschepis/sentient-core';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from './TeacherAgent';
import { ACTIVE_DECK } from './decks';
import { ALL_CONVERSATION_PAIRS } from './conversation';
import { MemoryPersistenceStore } from '../persistence/store';
import {
  retrievalMargin,
  sketchDcRatio,
  unrelatedPairwiseCosine,
  type MarginProbe,
  type RetrievalMarginReading
} from './competitionMetrics';

const WORDS = Number(process.env.FALSIFIER_WORDS ?? 200);
const PAIRS = Number(process.env.FALSIFIER_PAIRS ?? ALL_CONVERSATION_PAIRS.length);
const CUES = Number(process.env.FALSIFIER_CUES ?? 200);

/**
 * The competition arm under test. Defaults to the variant the sweep in
 * competitionBenchmark.test.ts adopted; override to falsify against another.
 */
const COMPETITION: Partial<SemanticObserverOptions> = {
  activationBudget: Number(process.env.FALSIFIER_BUDGET ?? 0),
  inhibition: Number(process.env.FALSIFIER_INHIBITION ?? 0),
  winnerTakeAll: Number(process.env.FALSIFIER_WTA ?? 4)
};

const SETTLE_DT = 0.05;
const SETTLE_STEPS = 4;

interface Cell {
  name: string;
  dcRatio: number;
  cosineRaw: number;
  cosineCentered: number;
  margin: RetrievalMarginReading;
  competency: number;
}

async function run(
  name: string,
  competition: Partial<SemanticObserverOptions>,
  centerSketches: boolean
): Promise<Cell> {
  const session = new ObserverSession(
    {
      ...OBSERVER_OPTIONS,
      ...competition,
      memoryBankOptions: { centerSketches }
    },
    100
  );
  await session.initialize();
  const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 500);

  for (const entry of ACTIVE_DECK.slice(0, WORDS)) teacher.teach(entry.word);
  const probes: MarginProbe[] = [];
  for (const pair of ALL_CONVERSATION_PAIRS.slice(0, PAIRS)) {
    const traceId = teacher.teachResponse(pair);
    if (traceId !== null) probes.push({ cue: pair.cue, traceId });
  }
  for (const pair of ALL_CONVERSATION_PAIRS.slice(0, PAIRS)) teacher.respond(pair.cue);

  const excite = (cue: string): void => {
    session.settleField();
    session.observeText(cue);
    session.observer.tick(0.02);
    for (let step = 0; step < SETTLE_STEPS; step += 1) session.observer.tick(SETTLE_DT);
  };
  const stride = Math.max(1, Math.floor(probes.length / CUES));
  const sample = probes.filter((_, i) => i % stride === 0).slice(0, CUES);

  const traces = session.observer.getMemoryBank().all() as TraceLike[];
  const cosine = unrelatedPairwiseCosine(traces);
  const cell: Cell = {
    name,
    dcRatio: sketchDcRatio(traces),
    cosineRaw: cosine.raw,
    cosineCentered: cosine.centered,
    margin: retrievalMargin(sample, excite, (cue, topK) => session.recall(cue, topK), 5),
    competency: teacher.conversationReport().competency
  };
  session.dispose();
  return cell;
}

describe('P12 falsifier: does competition rescue centerSketches?', () => {
  it('runs the 2x2 of competition x sketch centering', async () => {
    const cells: Cell[] = [];
    cells.push(await run('control              ', {}, false));
    cells.push(await run('control + center     ', {}, true));
    cells.push(await run('competition          ', COMPETITION, false));
    cells.push(await run('competition + center ', COMPETITION, true));

    const rows = cells
      .map(
        (c) =>
          `  ${c.name} DC ${c.dcRatio.toFixed(3)} · cos ${c.cosineRaw.toFixed(3)}/${c.cosineCentered.toFixed(3)} · ` +
          `top1 ${(c.margin.top1Rate * 100).toFixed(1)}% · true ${c.margin.meanTrueScore.toFixed(3)} · ` +
          `distr ${c.margin.meanDistractorScore.toFixed(3)} · ` +
          `margin ${c.margin.meanMargin >= 0 ? '+' : ''}${c.margin.meanMargin.toFixed(3)} · ` +
          `comp ${(c.competency * 100).toFixed(1)}%`
      )
      .join('\n');
    // eslint-disable-next-line no-console
    console.log(
      `\n[centerSketchesFalsifier] words=${WORDS} pairs=${PAIRS} cues<=${CUES}\n` +
        `  competition arm: ${JSON.stringify(COMPETITION)}\n${rows}\n`
    );

    for (const cell of cells) {
      expect(Number.isFinite(cell.margin.meanMargin)).toBe(true);
      expect(cell.margin.cues).toBeGreaterThan(0);
    }
  }, 3600000);
});
