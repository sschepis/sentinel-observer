import type { TeacherAgent } from '../TeacherAgent';
import type { AutonomousEvent } from '../autonomous';
import { TokenCostModel } from '../mdl';
import { SLOT_COST } from '../operators/learning';
import { ACTIVE_DECK } from '../decks';
import { CHECKABLE_CONCEPTS } from './index';
import { generateExercises, splitExercises, verify, chanceLevel, type Exercise } from './verify';
import { induceRule, matchArgs, evaluate, conversionPairOf, type DSLExpr, type TrainInstance } from './dsl';
import type { TechnicalConcept } from './types';

/**
 * THE DRILL LOOP — teaching something whose answers can be checked.
 *
 * Every other loop in this app grades with an LLM. This one does not need
 * to: `verify()` knows the answer. That buys the measurement that recall
 * competency cannot give, because the exercises are split into a taught set
 * and a HELD-OUT set the observer has never seen:
 *
 *   high on taught, chance on held-out  -> it MEMORIZED the instances
 *   high on both                        -> it INDUCED the rule
 *   low on both                         -> it learned nothing yet
 *
 * That distinction is the whole point. Memorizing the times table is not
 * knowing how to multiply, and only a held-out set can tell them apart.
 *
 * When a round returns `memorized`, a symbolic DSL search runs over the
 * taught instances (P2). A program consistent with them, cheaper than the
 * instances themselves (MDL), and accurate on the held-out set becomes a
 * COMPILED RULE — a first-class operator — so "asked for the rule" becomes
 * "acquired the rule". If the search finds nothing, the rule question is
 * still raised (an arbitrary mapping is not a rule).
 */

/** Exercises taught per round. */
const TRAIN_SIZE = 12;
/** Held-out exercises used to test generalization. */
const TEST_SIZE = 10;
/** Held-out accuracy must clear the null model by this much. */
const INDUCTION_MARGIN = 0.2;
/**
 * Held-out answers required before induction may be claimed at all. A
 * couple of lucky hits on a small set is not evidence of a rule, however
 * favourably it divides.
 */
const MIN_INDUCTION_HITS = 3;
/** Accuracy on taught instances that counts as having stored them. */
const MEMORIZED_FLOOR = 0.5;

export type DrillVerdict = 'unlearned' | 'memorized' | 'induced' | 'rule-induced';

export interface DrillMdl {
  /** Bits to store the taught instances as separate memories. */
  instanceBits: number;
  /** Bits to encode the rule that would explain them all. */
  ruleBits: number;
  /** True when the rule is the cheaper description. */
  compresses: boolean;
}

export interface DrillResult {
  concept: string;
  drill: string;
  taught: number;
  /** Accuracy on the exercises it was taught. */
  trainAccuracy: number;
  /** Accuracy on exercises it has never seen. */
  testAccuracy: number;
  /** The bar unseen accuracy must clear: the memorizer null model. */
  chance: number;
  verdict: DrillVerdict;
  mdl: DrillMdl;
  /** The prompts taught this round. */
  trainPrompts: string[];
  /** The prompts held back — must never appear in trainPrompts. */
  testPrompts: string[];
  /**
   * The rule-level question raised when the observer only memorized AND the
   * symbolic search found no executable rule. Null when it generalized, when
   * a rule was induced, or when the question was already asked.
   */
  ruleQuestion: string | null;
  /** Held-out accuracy of the INDUCED program (rule-induced rounds only). */
  ruleTestAccuracy?: number;
  /** Node count of the induced program (its MDL size). */
  ruleNodes?: number;
  events: AutonomousEvent[];
}

/**
 * What the observer should ask when it discovers it memorized.
 *
 * The useless response to "I stored 12 products and can compute none" is
 * another 12 products. The useful one is the rule, so the gap is raised at
 * the rule level and phase 1 asks the teacher about THAT.
 */
export function ruleQuestionFor(concept: TechnicalConcept): string {
  return `what is the rule for ${concept.word}?`;
}

/**
 * The null model: how well a learner does on unseen exercises by replaying
 * a stored answer at random.
 *
 * A hand-picked "chance level" is a guess, and a wrong guess manufactures
 * false induction — place-value answers cluster in a small space, so
 * replaying a stored answer beats 1% easily. This computes the baseline
 * from the actual sets instead: for each held-out item, the share of taught
 * answers that happen to be correct for it.
 */
export function memorizerBaseline(
  train: readonly Exercise[],
  test: readonly Exercise[]
): number {
  if (train.length === 0 || test.length === 0) return 0;
  let total = 0;
  for (const exercise of test) {
    const hits = train.filter((taught) => taught.answer === exercise.answer).length;
    total += hits / train.length;
  }
  return total / test.length;
}

let costModel: TokenCostModel | null = null;
/** The Zipf prior over the deck, built once — it is 20k words wide. */
function tokenCost(): TokenCostModel {
  costModel ??= new TokenCostModel(ACTIVE_DECK.map((entry) => entry.word));
  return costModel;
}

/** Stable seed so a concept's round N is reproducible across runs. */
function seedFor(concept: string, round: number): number {
  let hash = 2166136261;
  for (let i = 0; i < concept.length; i += 1) {
    hash ^= concept.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) + round * 7919) >>> 0;
}

/** Has the observer actually been taught this concept? */
function isLearned(teacher: TeacherAgent, word: string): boolean {
  return teacher.tryState(word)?.traceId != null;
}

/**
 * The next concept worth drilling: checkable, and with every prerequisite
 * already learned. P-curriculum: concepts that keep FAILING their drills
 * come first (their failure streak is the strongest evidence they need
 * another round), then concepts drilled least recently, so the loop still
 * spreads across the curriculum instead of grinding one skill.
 */
export function nextDrillConcept(
  teacher: TeacherAgent,
  drilledCounts: ReadonlyMap<string, number> = new Map(),
  drillFailures?: ReadonlyMap<string, number>
): TechnicalConcept | null {
  const ready = CHECKABLE_CONCEPTS.filter(
    (concept) => isLearned(teacher, concept.word) && concept.dependsOn.every((p) => isLearned(teacher, p))
  );
  if (ready.length === 0) return null;
  return ready.reduce((best, concept) => {
    const failures = (drillFailures?.get(concept.word) ?? 0) - (drillFailures?.get(best.word) ?? 0);
    if (failures > 0) return concept;
    if (failures < 0) return best;
    return (drilledCounts.get(concept.word) ?? 0) < (drilledCounts.get(best.word) ?? 0) ? concept : best;
  });
}

/** Ask the observer one exercise and mark it exactly. */
function askAndMark(teacher: TeacherAgent, exercise: Exercise): boolean {
  const answer = teacher.chatAnswer(exercise.prompt);
  const spoken = answer.mode === 'decline' ? '' : answer.response;
  return verify(exercise, spoken).correct;
}

/**
 * The minimum-description-length comparison.
 *
 * Storing the taught instances costs the bits of every answer under the
 * deck's Zipf prior. The rule costs its own tokens plus one slot annotation
 * per operand. When the rule is cheaper, a learner that stored instances is
 * carrying a description it did not need — which is exactly the claim
 * "it memorized the times table instead of learning to multiply".
 */
export function drillMdl(exercises: readonly Exercise[], ruleDescription: string, slots = 2): DrillMdl {
  const cost = tokenCost();
  const instanceBits = exercises.reduce((sum, exercise) => sum + cost.costOfText(exercise.answer), 0);
  const ruleBits = cost.costOfText(ruleDescription) + slots * SLOT_COST;
  return { instanceBits, ruleBits, compresses: ruleBits < instanceBits };
}

/**
 * Run one drill round on a concept.
 *
 * The order matters: the held-out set is generated with the taught set (one
 * seeded pool, split by prompt hash) so the two are disjoint by
 * construction, and the observer is tested on it only AFTER being taught —
 * never taught from it.
 */
export function runDrill(teacher: TeacherAgent, concept: TechnicalConcept, round = 0): DrillResult {
  const events: AutonomousEvent[] = [];
  const drill = concept.drill as string;
  const pool = generateExercises(drill, concept.word, {
    count: (TRAIN_SIZE + TEST_SIZE) * 2,
    seed: seedFor(concept.word, round)
  });
  const { train, test } = splitExercises(pool);
  const trainSet = train.slice(0, TRAIN_SIZE);
  const testSet = test.slice(0, TEST_SIZE);

  if (trainSet.length === 0 || testSet.length === 0) {
    events.push({ role: 'system', text: `no exercises available for ${concept.word}`, meta: 'error' });
    return {
      concept: concept.word,
      drill,
      taught: 0,
      trainAccuracy: 0,
      testAccuracy: 0,
      chance: chanceLevel(drill),
      verdict: 'unlearned',
      mdl: { instanceBits: 0, ruleBits: 0, compresses: false },
      trainPrompts: [],
      testPrompts: [],
      ruleQuestion: null,
      events
    };
  }
  events.push({
    role: 'system',
    text: `drilling ${concept.word}: ${trainSet.length} taught, ${testSet.length} held out`,
    meta: 'drill'
  });

  // Teach the training instances as exchanges the observer memorizes.
  let taught = 0;
  for (const exercise of trainSet) {
    if (teacher.teachResponse({ cue: exercise.prompt, response: exercise.answer }) !== null) {
      taught += 1;
      teacher.respond(exercise.prompt);
    }
  }

  const trainCorrect = trainSet.filter((exercise) => askAndMark(teacher, exercise)).length;
  const generalized = testSet.filter((exercise) => askAndMark(teacher, exercise));
  const testCorrect = generalized.length;
  const trainAccuracy = trainCorrect / trainSet.length;
  const testAccuracy = testCorrect / testSet.length;
  // The bar is whichever null model is stronger: blind guessing, or
  // replaying a stored answer.
  const chance = Math.max(chanceLevel(drill), memorizerBaseline(trainSet, testSet));

  let verdict: DrillVerdict =
    testCorrect >= MIN_INDUCTION_HITS && testAccuracy > chance + INDUCTION_MARGIN
      ? 'induced'
      : trainAccuracy >= MEMORIZED_FLOOR
        ? 'memorized'
        : 'unlearned';

  const mdl = drillMdl(trainSet, concept.definition);

  // An unseen exercise answered right is real generalization — reinforce
  // whatever produced it. `respond` is a recall drill, so nothing is stored
  // and the held-out set stays held out.
  for (const exercise of generalized) teacher.respond(exercise.prompt);

  // Exam items are not questions to the teacher — a failed instance must
  // never persist as a gap (the RULE below is the gap worth taking).
  for (const exercise of [...trainSet, ...testSet]) teacher.forgetGap(exercise.prompt);

  // Memorizing means more instances will not help. Try to INDUCE an
  // executable rule from the taught instances first; only when the search
  // finds nothing is the English rule question the gap worth taking.
  let ruleQuestion: string | null = null;
  let ruleTestAccuracy: number | undefined;
  let ruleNodes: number | undefined;
  if (verdict === 'memorized') {
    const induced = induceCompiledRule(teacher, concept, drill, trainSet, testSet, chance);
    if (induced !== null) {
      verdict = 'rule-induced';
      ruleTestAccuracy = induced.testAccuracy;
      ruleNodes = induced.nodes;
      events.push({
        role: 'system',
        text: `induced an executable rule for ${concept.word} (${induced.nodes} nodes, held-out ${Math.round(induced.testAccuracy * 100)}%)`,
        meta: 'drill-induced'
      });
    } else {
      ruleQuestion = ruleQuestionFor(concept);
      teacher.recordGap(ruleQuestion);
      events.push({ role: 'observer', text: ruleQuestion, meta: 'curious' });
    }
  }

  events.push({
    role: 'observer',
    text: `${concept.word}: ${Math.round(trainAccuracy * 100)}% on what it was taught, ${Math.round(testAccuracy * 100)}% on unseen (replaying a stored answer would score ${Math.round(chance * 100)}%)`,
    meta: 'drill'
  });
  events.push({
    role: 'system',
    text:
      verdict === 'induced'
        ? `${concept.word} generalized — it answers exercises it was never shown`
        : verdict === 'rule-induced'
          ? `${concept.word} rule acquired — an executable program now answers the family`
          : verdict === 'memorized'
            ? `${concept.word} was memorized, not generalized — ${mdl.instanceBits.toFixed(0)} bits of stored instances against ${mdl.ruleBits.toFixed(0)} bits for the rule`
            : `${concept.word} has not been learned yet`,
    meta: verdict === 'induced' || verdict === 'rule-induced' ? 'drill-induced' : 'drill-memorized'
  });

  return {
    concept: concept.word,
    drill,
    taught,
    trainAccuracy,
    testAccuracy,
    chance,
    verdict,
    mdl,
    trainPrompts: trainSet.map((exercise) => exercise.prompt),
    testPrompts: testSet.map((exercise) => exercise.prompt),
    ruleQuestion,
    ruleTestAccuracy,
    ruleNodes,
    events
  };
}

/**
 * The symbolic induction pass (P2): lift structured args from the taught
 * prompts, enumerate programs consistent with them, gate by MDL (the program
 * must compress the instances) and by the HELD-OUT validation (predictions
 * must clear the memorizer baseline by the induction margin). Returns the
 * cheapest program that clears both gates, and registers it on the teacher as
 * a compiled operator.
 */
function induceCompiledRule(
  teacher: TeacherAgent,
  concept: TechnicalConcept,
  drill: string,
  trainSet: readonly Exercise[],
  testSet: readonly Exercise[],
  chance: number
): { nodes: number; testAccuracy: number } | null {
  const train = instancesFor(trainSet);
  const test = instancesFor(testSet);
  if (train === null || test === null || train.length === 0 || test.length === 0) return null;

  const mdl = drillMdl(trainSet, '');
  const program = induceRule(train, test, {
    instanceBits: mdl.instanceBits,
    baseline: chance,
    margin: INDUCTION_MARGIN,
    minHits: MIN_INDUCTION_HITS
  });
  if (program === null) return null;

  let correct = 0;
  for (const instance of test) {
    const value = evaluate(program.expr, instance.args);
    if (value !== undefined && dslValueEquals(value, instance.answer)) correct += 1;
  }

  // H2: a convert-length rule is bound to the exact unit pair it was induced
  // on (length factors vary per pair; the time/mass/volume families share one
  // factor across both generator directions, so their matchers are enough).
  const conversionPair =
    drill === 'convert-length' && trainSet.length > 0 ? conversionPairOf(trainSet[0].prompt) : null;

  teacher.registerCompiledRule({
    concept: concept.word,
    drill,
    program: program.expr,
    nodes: program.nodes,
    bits: program.bits,
    trainCount: trainSet.length,
    instanceBits: mdl.instanceBits,
    ...(conversionPair !== null ? { conversionFrom: conversionPair.from, conversionTo: conversionPair.to } : {})
  });
  return { nodes: program.nodes, testAccuracy: correct / Math.max(1, test.length) };
}

/** Structured train instances, or null when a prompt does not parse (a family
 *  without a parser is not inducible — that is the honesty gate). */
function instancesFor(exercises: readonly Exercise[]): TrainInstance[] | null {
  const instances: TrainInstance[] = [];
  for (const exercise of exercises) {
    const args = matchArgs(exercise.drill, exercise.prompt);
    if (args === null) return null;
    instances.push({
      args,
      answer: exercise.kind === 'number' ? Number(exercise.answer) : exercise.answer
    });
  }
  return instances;
}

/** Canonical value equality (numbers trimmed to the verifier's precision). */
function dslValueEquals(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.round(a * 1e6) / 1e6 === Math.round(b * 1e6) / 1e6;
  return a === b;
}
