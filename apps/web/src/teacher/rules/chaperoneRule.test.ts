import { describe, expect, test, jest } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { PRIME_SPACE, deckVocabulary } from '../primeSignature';
import { ACTIVE_DECK } from '../decks';
import { TeacherAgent } from '../TeacherAgent';
import { Chaperone, type ChaperoneProvider } from '../chaperone';
import { taughtRuleSpecFor } from './instruction';
import { generateExercises } from '../technical/verify';
import type { DeckWord } from '../deck';

/** Deterministic fake provider — the scripted chaperone. */
class FakeProvider implements ChaperoneProvider {
  readonly name = 'fake';
  private readonly responses: Array<string | Error>;
  private index = 0;

  constructor(responses: Array<string | Error>) {
    this.responses = responses;
  }

  async complete(prompt: string): Promise<string> {
    const next = this.responses[Math.min(this.index++, this.responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }
}

const CORRECT =
  'to find the gcd of a and b: if b is zero the answer is a; otherwise it is the gcd of b and the remainder of a divided by b';
const WRONG =
  'to find the gcd of a and b: if b is zero the answer is a; otherwise it is the gcd of b and the remainder of b divided by a';
const CHEATING = 'to find the gcd of a and b: if b is zero the answer is a; otherwise the answer is a';

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

/** The full R14 pipeline: proposal → parse → validate → adopt-or-reject. */
async function runPipeline(teacher: TeacherAgent, proposal: string): Promise<ReturnType<TeacherAgent['teachRewriteRule']>> {
  const chaperone = new Chaperone(new FakeProvider([proposal]));
  const spec = taughtRuleSpecFor('gcf')!;
  const exercises = generateExercises('gcf', 'greatest common factor', { count: 12, seed: 11 });
  const instances = exercises.map((exercise) => ({
    input: exercise.prompt.replace(/^What is the greatest common factor of (\d+) and (\d+)\??$/i, '$1, $2'),
    output: exercise.answer
  }));
  const text = await chaperone.proposeRule({ spec, instances });
  return teacher.teachRewriteRule(text, 'gcf', { origin: 'chaperone' });
}

describe('R14 — chaperone rule supply', () => {
  test('the proposal prompt demands the grammar and carries the instances', async () => {
    let seenPrompt = '';
    const recording = new Chaperone({
      name: 'recording',
      async complete(prompt: string): Promise<string> {
        seenPrompt = prompt;
        return CORRECT;
      }
    });
    const spec = taughtRuleSpecFor('gcf')!;
    await recording.proposeRule({
      spec,
      instances: [
        { input: '12, 8', output: '4' },
        { input: '8, 12', output: '4' }
      ]
    });
    expect(seenPrompt).toContain('12, 8  ->  4');
    expect(seenPrompt).toContain('in exactly this grammar');
    expect(seenPrompt).toContain('if <arg> is zero the answer is <expr>');
    expect(seenPrompt).toContain('gcd of <expr> and <expr>');
  });

  test('a correct proposal is adopted HEDGED with origin chaperone and derives', async () => {
    const teacher = await freshTeacher();
    const outcome = await runPipeline(teacher, CORRECT);
    expect(outcome.adopted).toBe(true);
    const rule = teacher.rewriteRuleStore().get(outcome.ruleId!)!;
    expect(rule.origin).toBe('chaperone');
    expect(rule.sourceClasses).toEqual([]);
    const answer = teacher.chatAnswer('What is the greatest common factor of 48 and 36?');
    const operator = answer.mode === 'operator' ? answer.operator : null;
    if (operator !== null && operator.kind === 'rewrite') {
      expect(operator.answer).toBe('I think the answer is 12.');
    } else {
      throw new Error(`expected the chaperone-supplied rule to derive, got ${answer.mode}`);
    }
  });

  test('a wrong proposal is rejected at validation with a counterexample — never registered', async () => {
    const teacher = await freshTeacher();
    const outcome = await runPipeline(teacher, WRONG);
    expect(outcome.adopted).toBe(false);
    expect(outcome.counterexample).toContain('the rule gives');
    expect(teacher.rewriteRuleStore().all().filter((rule) => rule.origin !== 'authored')).toHaveLength(0);
  });

  test('a cheating constant proposal is rejected — held-out catches it, validation is never bypassed', async () => {
    const teacher = await freshTeacher();
    const outcome = await runPipeline(teacher, CHEATING);
    expect(outcome.adopted).toBe(false);
    expect(teacher.rewriteRuleStore().all().filter((rule) => rule.origin !== 'authored')).toHaveLength(0);
  });

  test('a proposal that parses nowhere (garbage) is declined, not adopted', async () => {
    const teacher = await freshTeacher();
    const outcome = await runPipeline(teacher, 'seven is the answer to everything');
    expect(outcome.adopted).toBe(false);
    expect(teacher.rewriteRuleStore().all().filter((rule) => rule.origin !== 'authored')).toHaveLength(0);
  });

  test('chaperone rules persist through export → import with their origin', async () => {
    const teacher = await freshTeacher();
    await runPipeline(teacher, CORRECT);
    const record = teacher.exportBootstrap('en-20000');
    expect(record.rewriteRules?.some((rule) => rule.origin === 'chaperone')).toBe(true);
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const restored = new TeacherAgent(session, DECK, null, 1, 0, 7);
    restored.importBootstrap(record);
    const rule = restored.rewriteRuleStore().all().find((entry) => entry.origin === 'chaperone');
    expect(rule).toBeDefined();
    session.dispose();
  });
});
