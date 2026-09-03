/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  evaluate,
  exprSize,
  programBits,
  matchArgs,
  enumerateConsistent,
  induceRule,
  type DSLExpr,
  type TrainInstance
} from './dsl';
import { generateExercises, splitExercises } from './verify';

// The exercises are the honest source: real prompts + known answers.
function instancesFor(drill: string, count: number): TrainInstance[] {
  const pool = generateExercises(drill, drill, { count: count * 2, seed: 42 });
  const { train, test } = splitExercises(pool);
  const toInstances = (set: typeof train): TrainInstance[] =>
    set.slice(0, count).map((exercise) => ({
      args: matchArgs(drill, exercise.prompt) ?? [],
      answer: exercise.kind === 'number' ? Number(exercise.answer) : exercise.answer
    }));
  return toInstances(train);
}

describe('DSL evaluation', () => {
  it('evaluates arithmetic, comparison, and conditionals', () => {
    expect(evaluate({ op: 'add', a: { op: 'arg', index: 0 }, b: { op: 'arg', index: 1 } }, [3, 4])).toBe(7);
    expect(evaluate({ op: 'mul', a: { op: 'arg', index: 0 }, b: { op: 'const', value: 1000 } }, [5])).toBe(5000);
    expect(evaluate({ op: 'mod', a: { op: 'arg', index: 0 }, b: { op: 'const', value: 2 } }, [7])).toBe(1);
    expect(evaluate({ op: 'gt', a: { op: 'arg', index: 0 }, b: { op: 'arg', index: 1 } }, [9, 4])).toBe(true);
    expect(evaluate(
      { op: 'ite', cond: { op: 'eq', a: { op: 'mod', a: { op: 'arg', index: 0 }, b: { op: 'const', value: 2 } }, b: { op: 'const', value: 0 } }, then: { op: 'text', value: 'even' }, else: { op: 'text', value: 'odd' } },
      [8]
    )).toBe('even');
  });

  it('is total: divide/mod by zero and type errors return undefined, never throw', () => {
    expect(evaluate({ op: 'div', a: { op: 'arg', index: 0 }, b: { op: 'const', value: 0 } }, [5])).toBeUndefined();
    expect(evaluate({ op: 'mod', a: { op: 'arg', index: 0 }, b: { op: 'const', value: 0 } }, [5])).toBeUndefined();
    expect(evaluate({ op: 'add', a: { op: 'arg', index: 0 }, b: { op: 'arg', index: 1 } }, ['even', 4])).toBeUndefined();
    expect(evaluate({ op: 'ite', cond: { op: 'arg', index: 0 }, then: { op: 'text', value: 'a' }, else: { op: 'text', value: 'b' } }, [5])).toBeUndefined();
  });

  it('sizes and bills programs consistently', () => {
    const parity: DSLExpr = {
      op: 'ite',
      cond: { op: 'eq', a: { op: 'mod', a: { op: 'arg', index: 0 }, b: { op: 'const', value: 2 } }, b: { op: 'const', value: 0 } },
      then: { op: 'text', value: 'even' },
      else: { op: 'text', value: 'odd' }
    };
    expect(exprSize(parity)).toBe(8);
    expect(programBits(parity)).toBeGreaterThan(0);
    expect(exprSize({ op: 'add', a: { op: 'arg', index: 0 }, b: { op: 'arg', index: 1 } })).toBe(3);
  });

  it('matchArgs parses the drill families', () => {
    expect(matchArgs('addition', 'What is 7 + 5?')).toEqual([7, 5]);
    expect(matchArgs('comparison', 'Which is greater, 7 or 5?')).toEqual([7, 5]);
    expect(matchArgs('parity', 'Is 7 even or odd?')).toEqual([7]);
    expect(matchArgs('temperature', 'What is -3 degrees celsius in kelvin?')).toEqual([-3]);
    expect(matchArgs('force', 'What force accelerates 5 kilograms at 3 meters per second squared?')).toEqual([5, 3]);
    expect(matchArgs('convert-time', 'How many seconds are in 5 minutes?')).toEqual([5]);
    expect(matchArgs('addition', 'not a prompt')).toBeNull();
    // R4: the gcf/lcm families gained parsers (the rewrite engine's first
    // and only computing path) — a deliberate, named contract change from
    // the pre-R parseability they had.
    expect(matchArgs('gcf', 'What is the greatest common factor of 8 and 12?')).toEqual([8, 12]);
    expect(matchArgs('lcm', 'What is the least common multiple of 4 and 6?')).toEqual([4, 6]);
    // R9: word-problem stories lift both quantities from the generated
    // shapes.
    expect(matchArgs('word-problem-add', 'Sam has 7 apples and gets 5 more. How many apples does Sam have?')).toEqual([7, 5]);
    expect(matchArgs('word-problem-mul', 'There are 6 boxes with 9 pencils in each box. How many pencils are there in all?')).toEqual([6, 9]);
    expect(matchArgs('word-problem-add', 'Sam has 5 apples and 3 bananas. How many apples does Sam have?')).toBeNull();
  });
});

describe('DSL enumeration', () => {
  it('discovers parity (even/odd) from 12 taught instances', () => {
    const train = instancesFor('parity', 12);
    const candidates = enumerateConsistent(train, { maxNodes: 9, maxCandidates: 50000 });
    expect(candidates.length).toBeGreaterThan(0);
    // The first candidate must generalize: run it on fresh inputs.
    const program = candidates[0];
    const fresh = instancesFor('parity', 20);
    const correct = fresh.filter((t) => evaluate(program.expr, t.args) === t.answer).length;
    expect(correct).toBe(fresh.length);
  });

  it('discovers addition and multiplication', () => {
    for (const drill of ['addition', 'multiplication']) {
      const train = instancesFor(drill, 12);
      const candidates = enumerateConsistent(train, { maxNodes: 7, maxCandidates: 50000 });
      expect(candidates.length).toBeGreaterThan(0);
      const fresh = instancesFor(drill, 20);
      const correct = fresh.filter((t) => evaluate(candidates[0].expr, t.args) === t.answer).length;
      expect(correct).toBe(fresh.length);
    }
  });

  it('discovers comparison (returns the greater number)', () => {
    const train = instancesFor('comparison', 12);
    const candidates = enumerateConsistent(train, { maxNodes: 9, maxCandidates: 50000 });
    expect(candidates.length).toBeGreaterThan(0);
    const fresh = instancesFor('comparison', 20);
    const correct = fresh.filter((t) => evaluate(candidates[0].expr, t.args) === t.answer).length;
    expect(correct).toBe(fresh.length);
  });

  it('does not fabricate a rule for an arbitrary mapping', () => {
    // A random constant mapping has no small program: the search must find
    // nothing consistent beyond the degenerate memorizer programs, and the
    // held-out validation must reject those.
    const train = Array.from({ length: 10 }, (_, i) => ({ args: [i], answer: (i * 37) % 13 }));
    const test = Array.from({ length: 10 }, (_, i) => ({ args: [i + 100], answer: ((i + 100) * 37) % 13 }));
    const candidates = enumerateConsistent(train, { maxNodes: 7, maxCandidates: 50000 });
    // A degenerate single-constant program may be "consistent" with a
    // constant train, but with 10 distinct answers nothing can be consistent.
    expect(candidates.length).toBe(0);
    const induced = induceRule(train, test, { instanceBits: 200, baseline: 0.1 });
    expect(induced).toBeNull();
  });

  it('the MDL gate rejects a program that does not compress', () => {
    const train = instancesFor('addition', 12);
    const test = instancesFor('addition', 10);
    const candidates = enumerateConsistent(train, { maxNodes: 7, maxCandidates: 50000 });
    expect(candidates.length).toBeGreaterThan(0);
    // instanceBits of 1 bit: no program compresses — induction must refuse.
    const induced = induceRule(train, test, { instanceBits: 1, baseline: 0.01 });
    expect(induced).toBeNull();
  });
});
