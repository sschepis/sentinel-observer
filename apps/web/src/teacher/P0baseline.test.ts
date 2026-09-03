/**
 * Phase 17 gates — L1a surprise-scaled FSRS (replaces the P0 baseline suite,
 * which pinned the W1 inverted collapse that Phase 17.3 deleted).
 *
 * Lapse: keep = clamp(1 − R, 0.05, 0.5), difficulty-independent —
 *   · crammed (R ≈ 1): floor 0.05, the harshest collapse in the system;
 *   · on-time (R = 0.9): 0.1 — exactly the pre-L1a mid-difficulty behavior;
 *   · overdue (R ≤ 0.5): cap 0.5 — the forgetting already happened.
 * Success: gain = e^(−D/8) · (1 + (1 − min(R/target, 1))) —
 *   · at/before the due date: the classic growth (no cram bonus);
 *   · overdue: up to double — the surprising rescue stretches most.
 *
 * @jest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import type { DeckWord } from './deck';
import {
  TeacherAgent,
  retentionProbability,
  FSRS_TARGET_RETENTION,
  type QuizAnswer
} from './TeacherAgent';

const DAY = 24 * 60 * 60 * 1000;

/** A tiny deck: teach-state is set directly, so only distinct word TEXT
 *  matters. The first three words serve the lapse tests, the last three the
 *  success tests (the shared teacher mutates state per word). */
const DIRECTION_DECK: DeckWord[] = [
  { word: 'aardvark', definition: 'a night animal that eats ants', example: 'An aardvark digs.' },
  { word: 'zygote', definition: 'a single cell at the start of life', example: 'A zygote divides.' },
  { word: 'badger', definition: 'a striped animal that digs', example: 'A badger digs.' },
  { word: 'cormorant', definition: 'a large sea bird', example: 'A cormorant dives.' },
  { word: 'dolphin', definition: 'a smart sea animal', example: 'A dolphin swims.' },
  { word: 'echidna', definition: 'a spiny animal that lays eggs', example: 'An echidna digs.' }
];

describe('L1a: the lapse is difficulty-independent and surprise-scaled (Phase 17.3)', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeAll(async () => {
    session = new ObserverSession({}, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DIRECTION_DECK);
  });

  afterAll(() => {
    session.dispose();
  });

  function stabilityAfterWrongGrade(word: string, difficulty: number, elapsedMs = 0): number {
    const live = teacher.tryState(word);
    expect(live).not.toBeNull();
    if (live === null || live === undefined) return -1;
    live.stability = 100;
    live.difficulty = difficulty;
    live.lastAskedAt = Date.now() - elapsedMs;
    live.dueAt = Date.now();
    const blank = { word: live.word, cue: live.word.word, answer: '', recall: null };
    const grade = teacher.grade(word, blank);
    expect(grade.verdict).toBe('wrong');
    return teacher.tryState(word)!.stability;
  }

  it('the lapse keeps the same fraction for an easy word and a hard word (difficulty independence)', () => {
    const easyAfter = stabilityAfterWrongGrade('aardvark', 1);
    const hardAfter = stabilityAfterWrongGrade('zygote', 10);
    expect(easyAfter).toBeCloseTo(hardAfter, 10);
    expect(easyAfter).toBeCloseTo(5, 5); // keep = clamp(1 − R≈1) = 0.05 floor
  });

  it('an ON-TIME lapse (R = 0.9, one stability elapsed) keeps 0.1 — the pre-L1a calibration anchor', () => {
    const onTime = stabilityAfterWrongGrade('badger', 5, 100 * DAY);
    expect(onTime).toBeCloseTo(10, 1);
  });

  it('a CRAMMED lapse (R ≈ 1) collapses 2× harder than an on-time lapse', () => {
    const crammed = stabilityAfterWrongGrade('aardvark', 5, 0);
    const onTime = stabilityAfterWrongGrade('badger', 5, 100 * DAY);
    expect(crammed).toBeLessThan(onTime);
    expect(onTime / crammed).toBeCloseTo(2, 1);
  });

  it('an OVERDUE lapse (R ≤ 0.5) keeps the 0.5 cap — the forgetting already happened', () => {
    const overdue = stabilityAfterWrongGrade('zygote', 5, 1300 * DAY);
    expect(overdue).toBeCloseTo(50, 1);
  });
});

describe('L1a: the success gain is surprise-scaled (Phase 17.2)', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeAll(async () => {
    session = new ObserverSession({}, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DIRECTION_DECK);
  });

  afterAll(() => {
    session.dispose();
  });

  /** Grade a CORRECT recall with a controlled elapsed interval; returns the
   *  stability multiplier the update applied. */
  function multiplierAfterCorrectGrade(word: string, elapsedMs: number): number {
    teacher.teach(word);
    const live = teacher.tryState(word);
    expect(live).not.toBeNull();
    if (live === null || live === undefined) return -1;
    live.stability = 100;
    live.difficulty = 5;
    live.lastAskedAt = Date.now() - elapsedMs;
    live.dueAt = Date.now();
    const trace = session.observer.getMemoryBank().get(live.traceId!)!;
    const answer: QuizAnswer = {
      word: live.word,
      cue: live.word.word,
      answer: trace.content,
      recall: {
        trace,
        score: 0.9,
        smfScore: 0,
        overlapScore: 0.9,
        holographicScore: 0,
        consolidated: false
      }
    };
    const grade = teacher.grade(word, answer);
    expect(grade.verdict).toBe('correct');
    return teacher.tryState(word)!.stability / 100;
  }

  it('at/before the due date the gain is the classic e^(−D/8) — no cram bonus', () => {
    const classic = 1 + Math.exp(-5 / 8);
    const crammed = multiplierAfterCorrectGrade('cormorant', 0);
    const onTime = multiplierAfterCorrectGrade('dolphin', 100 * DAY);
    expect(crammed).toBeCloseTo(classic, 2);
    expect(onTime).toBeCloseTo(classic, 2);
  });

  it('an OVERDUE correct recall earns the surprise bonus', () => {
    const elapsedDays = 1300;
    const r = retentionProbability(100, elapsedDays);
    const expected = 1 + (1 + (1 - Math.min(r / FSRS_TARGET_RETENTION, 1))) * Math.exp(-5 / 8);
    const overdue = multiplierAfterCorrectGrade('echidna', elapsedDays * DAY);
    expect(overdue).toBeCloseTo(expected, 2);
    expect(overdue).toBeGreaterThan(1 + Math.exp(-5 / 8) * 1.4); // ≥ 40% over classic
  });
});
