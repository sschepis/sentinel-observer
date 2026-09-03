import { describe, expect, test } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { PRIME_SPACE, deckVocabulary } from '../primeSignature';
import { ACTIVE_DECK } from '../decks';
import { TeacherAgent } from '../TeacherAgent';
import { generateExercises, verify, type Exercise } from '../technical/verify';
import { matchArgs } from '../technical/dsl';
import { parseGeneralStory, GENERAL_STORY_PARSER_ENABLED, parseRewritePrompt } from './parse';
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

  test('C1 review fix: take-away stories are DECLINED — never answered as sums', () => {
    // The review finding: two-quantity change stories classified as add
    // ("Sam has 10 apples and gives away 3" → confidently "13"). The
    // decrease lexicon and the residual-question net must refuse every
    // shape, and chatAnswer must NOT derive.
    const takeAways = [
      'Sam has 10 apples and gives away 3. How many apples does Sam have?',
      'There are 8 cookies and Tom eats 5 of them. How many cookies does Tom have left?',
      'Leo has 12 candies and loses 4. How many candies does Leo have?',
      'The jar had 10 cookies and Noor ate 4 of them. How many cookies are left?',
      'Rosa bought 9 stickers and sold 3 of them. How many stickers does Rosa have?',
      'A tank held 6 liters and 2 leaked out. How many liters are still in the tank?'
    ];
    for (const story of takeAways) {
      expect(parseGeneralStory(story)).toBeNull();
      expect(parseRewritePrompt(story)).toBeNull();
    }
  });

  test('C1 review fix: the residual question alone is enough to decline', async () => {
    const teacher = await freshTeacher();
    const answer = teacher.chatAnswer('There are 8 cookies and Tom takes 5 of them. How many cookies are left?');
    expect(answer.mode).not.toBe('operator');
  });
});
