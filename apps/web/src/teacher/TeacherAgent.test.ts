/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { STARTER_DECK } from './deck';

/**
 * The word loop end to end: the teacher teaches, the observer learns, is
 * quizzed, answers from memory, and is graded — with the grade feeding real
 * events back into its field.
 *
 * Each test gets a FRESH observer so accumulated learning state from one
 * test cannot tilt the recall ranking of another.
 */
describe('TeacherAgent word loop', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession({}, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, STARTER_DECK);
  });

  afterEach(() => {
    session.dispose();
  });

  it('teaches a word and binds its memory trace', () => {
    const result = teacher.teach('apple');
    expect(result.traceId).not.toBeNull();
    expect(result.word.word).toBe('apple');

    const entry = teacher.listWords().find((w) => w.word.word === 'apple');
    expect(entry?.status).toBe('learning');
    expect(entry?.strength).not.toBeNull();
  });

  it('the observer answers recognition cues from its memory', () => {
    teacher.teach('apple');
    const answer = teacher.ask('apple', 'recognition');
    expect(answer.cue).toBe('apple');
    // The observer should recall SOMETHING it was taught (its trace content).
    expect(answer.answer.length).toBeGreaterThan(0);
    expect(answer.answer.toLowerCase()).toContain('apple');
  });

  it('grades a correct recall as success and reinforces the observer', () => {
    teacher.teach('apple');
    const answer = teacher.ask('apple', 'recognition');
    const grade = teacher.grade('apple', answer);

    expect(grade.verdict).toBe('correct');
    expect(grade.confidence).not.toBeNull();
    expect(grade.expected.toLowerCase()).toContain('fruit');

    const entry = teacher.listWords().find((w) => w.word.word === 'apple');
    expect(entry?.successes).toBe(1);
    expect(entry?.failures).toBe(0);
  });

  it('a right trace is CORRECT even when the raw recall score is low (confidence is separate)', () => {
    // Regression: the observer recalled exactly the right trace — the answer
    // content begins with the word itself. The score magnitude must never
    // demote a right answer to a lesser verdict; it is reported as confidence.
    teacher.teach('apple');
    const answer = teacher.ask('apple', 'recognition');
    expect(answer.answer.toLowerCase()).toContain('apple');

    // Simulate a low raw score while keeping the right trace ranked first.
    if (answer.recall !== null) {
      (answer.recall as { score: number }).score = 0.32;
    }
    const grade = teacher.grade('apple', answer);

    expect(grade.verdict).toBe('correct');
    expect(grade.confidence).toBeCloseTo(0.32, 5);
    const entry = teacher.listWords().find((w) => w.word.word === 'apple');
    expect(entry?.successes).toBe(1);
  });

  it('grades a blank answer as wrong and feeds a failure event', () => {
    teacher.teach('house');
    const blank = teacher.ask('house', 'recognition');
    blank.recall = null;
    (blank as { answer: string }).answer = '';

    const grade = teacher.grade('house', blank);
    expect(grade.verdict).toBe('wrong');
    const entry = teacher.listWords().find((w) => w.word.word === 'house');
    expect(entry?.failures).toBe(1);
  });

  it('production cue asks the observer to produce the word from the meaning', () => {
    teacher.teach('water');
    const answer = teacher.ask('water', 'production');
    expect(answer.cue).toBe(STARTER_DECK.find((w) => w.word === 'water')?.definition);
    // With only ONE learned word, the observer must recall it for any cue.
    expect(answer.answer.toLowerCase()).toContain('water');
  });

  it('a wrong recall for a production cue is graded honestly as wrong', () => {
    // Teach both words; the production cue for 'water' is asked BEFORE the
    // observer has had repeated reinforcement, so the ranking is genuinely
    // its answer — correct OR confused. The point: whatever it said is what
    // gets graded, with no human override.
    teacher.teach('water');
    teacher.teach('apple');
    const answer = teacher.ask('water', 'production');
    const grade = teacher.grade('water', answer);

    if (answer.answer.toLowerCase().includes('water')) {
      expect(grade.verdict).toBe('correct');
    } else {
      expect(grade.verdict).toBe('wrong');
      expect(grade.answer).not.toBe('');
    }
  });

  it("the observer's curiosity asks for the weakest learned word first", () => {
    for (const word of ['friend', 'book', 'music']) {
      teacher.teach(word);
    }
    const musicEntry = teacher.listWords().find((w) => w.word.word === 'music');
    expect(musicEntry?.traceId).toBeDefined();
    if (musicEntry?.traceId) {
      const trace = session.observer.getMemoryBank().get(musicEntry.traceId);
      if (trace) trace.strength = 0.3;
    }

    const next = teacher.nextReview();
    // 'music' is decayed -> highest priority.
    expect(next).toBe('music');
  });

  it('lists new words before they are taught and never fabricates states', () => {
    const fresh = teacher.listWords().find((w) => w.word.word === 'sleep');
    expect(fresh?.status).toBe('new');
    expect(fresh?.strength).toBeNull();
    expect(fresh?.successes).toBe(0);
    expect(fresh?.failures).toBe(0);
  });
});
