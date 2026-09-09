import { describe, expect, test } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { PRIME_SPACE, deckVocabulary } from '../primeSignature';
import { ACTIVE_DECK } from '../decks';
import { TeacherAgent } from '../TeacherAgent';
import { generateExercises, verify, type Exercise } from '../technical/verify';
import { matchArgs } from '../technical/dsl';
import { parseGeneralStory, GENERAL_STORY_PARSER_ENABLED, parseRewritePrompt, decodeNormalForm } from './parse';
import { RuleStore } from './types';
import { reduce } from './engine';
import { PEANO_RULES } from './peano';
import { DIGITS_RULES } from './digits';
import { runDrill } from '../technical/drill';
import { CHECKABLE_CONCEPTS } from '../technical/index';
import type { DeckWord } from '../deck';

const DECK: readonly DeckWord[] = ACTIVE_DECK.slice(0, 300).map((entry) => ({ ...entry }));
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK], PRIME_SPACE)
};

/**
 * THE DISPATCH'S ANSWER, if it has one. The two-number parser below must
 * still decline every shape it cannot defend, but since TASKS #64 the
 * story-state engine sits in the same dispatch and DOES read subtraction,
 * division and comparison stories. So these tests no longer assert "no
 * answer" at the dispatch level — they assert the stronger property: an
 * answer, if there is one, is the right one.
 */
function dispatchValue(prompt: string): number | null {
  const parsed = parseRewritePrompt(prompt);
  if (parsed === null) return null;
  const reduction = reduce(RULE_TEST_STORE, parsed.term, { fuel: parsed.fuel });
  if (reduction.outcome.status !== 'normal') return null;
  const spoken = decodeNormalForm(reduction.outcome.term);
  return spoken === null ? null : Number(spoken);
}

const RULE_TEST_STORE = new RuleStore([...PEANO_RULES, ...DIGITS_RULES]);

async function freshTeacher(): Promise<TeacherAgent> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  return new TeacherAgent(session, DECK, null, 1, 0, 7);
}

describe('R9 — word problems: anchored parsers', () => {
  test('matchArgs lifts both numbers from every generated story shape', () => {
    for (const drill of ['word-problem-add', 'word-problem-mul'] as const) {
      const exercises = generateExercises(drill, 'concept', { count: 40, seed: 99 });
      expect(exercises.length).toBeGreaterThan(0);
      for (const exercise of exercises) {
        const args = matchArgs(drill, exercise.prompt);
        expect(args).not.toBeNull();
        const sum = args![0] as number;
        const other = args![1] as number;
        // Addition is order-insensitive but the PRODUCT must match: the
        // lift must be the story's two quantities, not arbitrary digits.
        expect(drill === 'word-problem-add' ? sum + other : sum * other).toBe(Number(exercise.answer));
      }
    }
  });

  test('a story that matches no template declines — never guesses', () => {
    expect(matchArgs('word-problem-add', 'Sam has 5 apples and 3 bananas. How many apples does Sam have?')).toBeNull();
    expect(matchArgs('word-problem-mul', 'How many pencils are there in all?')).toBeNull();
  });

  test('every generated story derives through the engine', async () => {
    const teacher = await freshTeacher();
    for (const drill of ['word-problem-add', 'word-problem-mul'] as const) {
      const exercises = generateExercises(drill, 'concept', { count: 20, seed: 4242 });
      for (const exercise of exercises) {
        const answer = teacher.chatAnswer(exercise.prompt);
        expect(answer.mode).toBe('operator');
        if (answer.mode === 'operator' && answer.operator !== null) {
          expect(answer.operator.kind).toBe('rewrite');
          expect(verify(exercise, answer.response).correct).toBe(true);
        }
      }
    }
  });

  test('the drill loop reports generalization for stories on a fresh teacher', async () => {
    // Build a deck holding the story concepts and their prerequisites
    // (the story concepts are curriculum words, not in the frequency deck).
    const concepts = ['word problem', 'product word problem', 'addition', 'subtraction', 'multiplication'];
    const deck = concepts.map((word) => {
      const entry = CHECKABLE_CONCEPTS.find((concept) => concept.word === word);
      return { word, definition: entry?.definition ?? `the concept ${word}`, example: entry?.example ?? `About ${word}.` };
    });
    const session = new ObserverSession(
      { primeCount: 64, gridSize: 128, memoryMode: 'compact' as const, vocabulary: deckVocabulary([...deck], PRIME_SPACE) },
      100
    );
    await session.initialize();
    const teacher = new TeacherAgent(session, deck, null, 1, 0, 7, undefined, undefined, undefined, true);
    for (const word of ['word problem', 'product word problem']) {
      teacher.teach(word);
      const concept = CHECKABLE_CONCEPTS.find((entry) => entry.word === word)!;
      for (const prerequisite of concept.dependsOn) teacher.teach(prerequisite);
      const result = runDrill(teacher, concept, 0);
      // The engine owns the arithmetic behind the story — unseen stories
      // generalize without a compile step.
      expect(['induced', 'rule-induced']).toContain(result.verdict);
    }
    session.dispose();
  });
});

describe('R9 — the general story parser (stretch, held-out gated)', () => {
  /** Sentences NONE of the eight anchored templates match — authored
   *  independently of the generator shapes. */
  const HELD_OUT_ADD: Exercise[] = [
    { concept: 'concept', prompt: 'Emma has 7 books and borrows 2 more. How many books does Emma have?', kind: 'number', answer: '9', drill: 'word-problem-add' },
    { concept: 'concept', prompt: 'Lena baked 12 muffins and then 5 more. How many muffins does Lena have?', kind: 'number', answer: '17', drill: 'word-problem-add' },
    { concept: 'concept', prompt: 'On Monday Liam ran 5 kilometers and on Tuesday 3 kilometers. How far did he run in all?', kind: 'number', answer: '8', drill: 'word-problem-add' }
  ];
  const HELD_OUT_MUL: Exercise[] = [
    { concept: 'concept', prompt: 'There are 6 bags with 9 candies in each bag. How many candies are there in all?', kind: 'number', answer: '54', drill: 'word-problem-mul' },
    { concept: 'concept', prompt: 'Every classroom has 8 windows and there are 5 classrooms. How many windows are there?', kind: 'number', answer: '40', drill: 'word-problem-mul' },
    { concept: 'concept', prompt: 'A garden has 4 rows with 6 tulips per row. How many tulips are there?', kind: 'number', answer: '24', drill: 'word-problem-mul' },
    { concept: 'concept', prompt: 'Each shelf holds 7 jars and the pantry has 3 shelves. How many jars are there?', kind: 'number', answer: '21', drill: 'word-problem-mul' }
  ];

  test('held-out stories classify and reduce to the oracle answers', async () => {
    const teacher = await freshTeacher();
    const heldOut = [...HELD_OUT_ADD, ...HELD_OUT_MUL];
    const parsed = heldOut.filter((exercise) => parseRewritePrompt(exercise.prompt) !== null);
    if (parsed.length !== heldOut.length) {
      // The ship gate: the general parser stays OFF unless every held-out
      // story parses. The finding is recorded, not papered over.
      console.warn(
        `general story parser missed ${heldOut.length - parsed.length}/${heldOut.length} held-out stories — keeping it ${GENERAL_STORY_PARSER_ENABLED ? 'ON' : 'OFF'} is a judgment call; the miss list follows.`
      );
    }
    for (const exercise of heldOut) {
      const story = parseGeneralStory(exercise.prompt);
      expect(story).not.toBeNull();
      expect(story!.kind === 'add' ? story!.a + story!.b : story!.a * story!.b).toBe(Number(exercise.answer));
      const answer = teacher.chatAnswer(exercise.prompt);
      expect(answer.mode).toBe('operator');
      if (answer.mode === 'operator' && answer.operator !== null) {
        expect(answer.operator.kind).toBe('rewrite');
        expect(verify(exercise, answer.response).correct).toBe(true);
      }
    }
  });

  test('garbage and non-story text return null', () => {
    expect(parseGeneralStory('zzz qqq 42')).toBeNull();
    expect(parseGeneralStory('How many words do you know?')).toBeNull();
    expect(parseGeneralStory('I have 2 cats and 3 dogs. Do you like cats?')).toBeNull();
    expect(parseRewritePrompt('What is your favorite thing to learn?')).toBeNull();
  });

  test('a three-quantity story (with subtraction) is DECLINED, not guessed', () => {
    // 10 cookies, ate 4, baked 6 → 12: a different problem shape. The
    // parser must refuse it rather than confidently add the first two
    // quantities (10 + 4 = 14 — a fabrication).
    const story = 'The jar had 10 cookies and Noor ate 4 of them and then baked 6 more. How many cookies are there now?';
    expect(parseGeneralStory(story)).toBeNull();
    expect(parseRewritePrompt(story)).toBeNull();
  });

  test('C1 review fix: take-away stories are never SUMMED — the two-number parser declines them and the story engine subtracts', () => {
    // The review finding: two-quantity change stories classified as add
    // ("Sam has 10 apples and gives away 3" → confidently "13"). The
    // decrease lexicon and the residual-question net still refuse every
    // shape here. What changed with TASKS #64 is that the dispatch no
    // longer has to stay silent: the story-state engine reads the same
    // stories as subtractions, so the assertion is the stronger one —
    // whatever comes out must be right.
    const takeAways: Array<[string, number]> = [
      ['Sam has 10 apples and gives away 3. How many apples does Sam have?', 7],
      ['There are 8 cookies and Tom eats 5 of them. How many cookies does Tom have left?', 3],
      ['Leo has 12 candies and loses 4. How many candies does Leo have?', 8],
      ['The jar had 10 cookies and Noor ate 4 of them. How many cookies are left?', 6],
      ['Rosa bought 9 stickers and sold 3 of them. How many stickers does Rosa have?', 6],
      ['A tank held 6 liters and 2 leaked out. How many liters are still in the tank?', 4]
    ];
    for (const [story, answer] of takeAways) {
      expect(parseGeneralStory(story)).toBeNull();
      const value = dispatchValue(story);
      if (value !== null) expect({ story, value }).toEqual({ story, value: answer });
    }
  });

  test('2026-09-09 bench fix: comparisons, shares, periods, three quantities and one-of-two-kinds sums are DECLINED', () => {
    // Every one of these was answered — wrongly — by the 300-problem
    // SVAMP/ASDiv sample (bench/curriculum/word-problems-2026-09-09-n300.json):
    // the parser summed or multiplied the first two numbers it saw.
    const guesses = [
      'Zachary did 51 push-ups and David did 44 push-ups in gym class today. How many more push-ups did Zachary do than David?',
      "Jesse's room is 19 feet wide and 20 feet long. How much longer is her room than it is wide?",
      'A grocery store had 19 bottles of diet soda and 60 bottles of regular soda. How many more bottles of regular soda than diet soda did they have?',
      'Melissa played 3 games and scored a total of 81 points scoring the same for each game. How many points did she score in each game?',
      'Matthew goes hiking every 12 days and swimming every 6 days. He did both kinds of exercise today. How many days from now will he go both hiking and swimming again?',
      "Chef Pillsbury's secret recipe requires 7 eggs for every 2 cups of flour. How many eggs will he need if he uses 8 cups of flour?",
      'He also had 56 aquariums for saltwater animals and 10 aquariums for freshwater animals. Each aquarium has 39 animals in it. How many saltwater animals does Tyler have?',
      'A mailman has to give 38 pieces of junk mail to each of the 78 blocks. If there are 19 houses on a block How many pieces of junk mail should he give each house?',
      "Jesse's room is 11 feet long and 15 feet wide. If she already has 16 square feet of carpet How much more carpet does she need to cover the whole floor?",
      '4 birds and 46 storks were sitting on the fence. How many birds are sitting on the fence?',
      'A jug holds 2.5 liters and a cup holds 3 liters. How many liters is that in all?',
      // Second round (the whole body now counted): divisions asked as the
      // number of GROUPS, a stated whole, a part of a whole, a difference
      // stated in the body, and a residual after equal groups.
      'Mrs. Walker will have 56 apples for bobbing for apples. Each bucket will hold 9 apples. How many buckets will she need?',
      'There are 396 students going to a trivia competition. If each school van can hold 9 students, how many vans will they need?',
      'For Halloween Adam received 201 pieces of candy. If he put them into piles with 43 in each pile, approximately how many piles could he make?',
      'Melissa scored 12 points in each game. If she scored a total of 36 points How many games did she play?',
      "Marco and his dad went strawberry picking. Marco's strawberries weighed 15 pounds. If together their strawberries weighed 37 pounds. How much did his dad's strawberries weigh?",
      'Allan and Jake brought 3 balloons to the park. If Allan brought 2 balloons How many balloons did Jake bring to the park?',
      'Megan and her sister, Tara, wanted to buy a scooter for $26. Tara had $4 more than Megan. Together they had enough money to buy the scooter. How much money did Tara have?',
      'While heating the wings, Charlie decided to make metal supports for the wings. If he needs 635 lbs of metal and he has 276 lbs in storage, how much additional metal does he need to buy?',
      '9 boys went to water trees. There were 29 trees. If each of them watered the equal amount of trees, how many trees are left?',
      // Third round: an unknown start or an unknown change.
      'Tommy had some balloons. His mom gave him 34 more balloons for his birthday. Then, Tommy had 60 balloons. How many balloons did Tommy have to start with?',
      'A waiter had 3 customers. After some more arrived he had 8 customers. How many new customers arrived?',
      // Out-of-sample slice (PROBLEMS_SKIP=300): a remainder, and sums that
      // need the world (legs per elephant, wheels per bicycle).
      '172 students are forming teams for a mountaineering competition. Each team should have 18 students. How many students will not be on a team?',
      'At the zoo, I see 35 elephants and 48 tigers. How many legs do I see?',
      "There are 22 bicycles and 3 cars in the garage at Gordon's apartment building. How many wheels are there in the garage?"
    ];
    // The two-number parser must decline every one of these. The dispatch
    // as a whole may now answer some of them through the story-state engine
    // (TASKS #64) — a comparison, a division, a stated whole — and where it
    // does, the answer must be the corpus's.
    const CORRECT: Record<string, number> = {
      'Zachary did 51 push-ups and David did 44 push-ups in gym class today. How many more push-ups did Zachary do than David?': 7,
      'A grocery store had 19 bottles of diet soda and 60 bottles of regular soda. How many more bottles of regular soda than diet soda did they have?': 41,
      'There are 396 students going to a trivia competition. If each school van can hold 9 students, how many vans will they need?': 44,
      "Jesse's room is 19 feet wide and 20 feet long. How much longer is her room than it is wide?": 1,
      'Melissa scored 12 points in each game. If she scored a total of 36 points How many games did she play?': 3,
      'While heating the wings, Charlie decided to make metal supports for the wings. If he needs 635 lbs of metal and he has 276 lbs in storage, how much additional metal does he need to buy?': 359,
      'A waiter had 3 customers. After some more arrived he had 8 customers. How many new customers arrived?': 5,
      'Tommy had some balloons. His mom gave him 34 more balloons for his birthday. Then, Tommy had 60 balloons. How many balloons did Tommy have to start with?': 26
    };
    for (const story of guesses) {
      expect(parseGeneralStory(story)).toBeNull();
      const value = dispatchValue(story);
      if (value !== null) {
        const expected = CORRECT[story];
        // An answer to a story with no recorded answer here would be a new
        // reading nobody has checked: fail loudly rather than trust it.
        expect({ story, value }).toEqual({ story, value: expected });
      }
    }
    // And the shapes it DOES understand still answer — a sum asked as a
    // third kind, a sum with a total cue, equal groups.
    // "pupils" is a third kind: the sum is right here, but the parser cannot
    // tell it from "legs" without the relation store — so it declines until
    // it can ask (a recorded loss, not a guess).
    expect(parseGeneralStory('In a school, there are 542 girls and 387 boys. How many pupils are there in that school?')).toBeNull();
    expect(parseGeneralStory('In a school, there are 542 girls and 387 boys. How many pupils are there in total?')).toEqual({ kind: 'add', a: 542, b: 387 });
    expect(parseGeneralStory('There were 58 geese and 37 ducks in the marsh. How many birds were there in all?')).toEqual({ kind: 'add', a: 58, b: 37 });
    expect(parseGeneralStory('The first act included 5 clown mobiles, each stuffed with 28 clowns. How many clowns are inside all the clown mobiles combined?')).toEqual({ kind: 'mul', a: 5, b: 28 });
    expect(parseGeneralStory('There are 37 baskets. There are 17 apples in each basket. How many apples are there in all?')).toEqual({ kind: 'mul', a: 37, b: 17 });
    expect(parseGeneralStory('There were 39 students that got on the bus during the first stop. If 29 more students got on the bus at the second stop, how many students are riding the bus?')).toEqual({ kind: 'add', a: 39, b: 29 });
  });

  test('C1 review fix: the residual question alone is enough to decline', async () => {
    const teacher = await freshTeacher();
    const answer = teacher.chatAnswer('There are 8 cookies and Tom takes 5 of them. How many cookies are left?');
    expect(answer.mode).not.toBe('operator');
  });
});
