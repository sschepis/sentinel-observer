/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  GENERATORS,
  generateExercises,
  splitExercises,
  verify,
  scoreExercises,
  statedNumber,
  chanceLevel,
  knownDrills,
  CHECKABLE_CONCEPTS
} from './index';

describe('exercise generation', () => {
  it('is deterministic for a given seed', () => {
    const a = generateExercises('multiplication', 'multiplication', { count: 20, seed: 7 });
    const b = generateExercises('multiplication', 'multiplication', { count: 20, seed: 7 });
    expect(a).toEqual(b);
  });

  it('produces different exercises for different seeds', () => {
    const a = generateExercises('addition', 'addition', { count: 20, seed: 1 });
    const b = generateExercises('addition', 'addition', { count: 20, seed: 2 });
    expect(a.map((e) => e.prompt)).not.toEqual(b.map((e) => e.prompt));
  });

  it('never repeats a prompt within a run', () => {
    for (const drill of knownDrills()) {
      const exercises = generateExercises(drill, drill, { count: 40, seed: 3 });
      const prompts = new Set(exercises.map((e) => e.prompt));
      expect(prompts.size).toBe(exercises.length);
    }
  });

  it('returns nothing for an unknown drill instead of inventing one', () => {
    expect(generateExercises('no-such-drill', 'x', { count: 5 })).toEqual([]);
  });
});

describe('every generator states a correct answer', () => {
  // The generators ARE the answer key, so this checks them against
  // independently computed arithmetic rather than against themselves.
  const check: Record<string, (prompt: string, answer: string) => boolean> = {
    addition: (p, a) => {
      const [x, y] = p.match(/\d+/g)!.map(Number);
      return Number(a) === x + y;
    },
    subtraction: (p, a) => {
      const [x, y] = p.match(/\d+/g)!.map(Number);
      return Number(a) === x - y;
    },
    multiplication: (p, a) => {
      const [x, y] = p.match(/\d+/g)!.map(Number);
      return Number(a) === x * y;
    },
    division: (p, a) => {
      const [x, y] = p.match(/\d+/g)!.map(Number);
      return Number(a) === x / y;
    },
    remainder: (p, a) => {
      const [x, y] = p.match(/\d+/g)!.map(Number);
      return Number(a) === x % y;
    },
    'order-of-operations': (p, a) => {
      const [x, y, z] = p.match(/\d+/g)!.map(Number);
      return Number(a) === x + y * z;
    },
    square: (p, a) => {
      const [x] = p.match(/\d+/g)!.map(Number);
      return Number(a) === x * x;
    },
    'square-root': (p, a) => {
      const [x] = p.match(/\d+/g)!.map(Number);
      return Number(a) ** 2 === x;
    },
    exponent: (p, a) => {
      const [b, e] = p.match(/\d+/g)!.map(Number);
      return Number(a) === b ** e;
    },
    percent: (p, a) => {
      const [pct, base] = p.match(/\d+/g)!.map(Number);
      return Number(a) === (base * pct) / 100;
    },
    'absolute-value': (p, a) => {
      const x = Number(p.match(/-?\d+/)![0]);
      return Number(a) === Math.abs(x);
    },
    area: (p, a) => {
      const [w, h] = p.match(/\d+/g)!.map(Number);
      return Number(a) === w * h;
    },
    force: (p, a) => {
      const [m, acc] = p.match(/\d+/g)!.map(Number);
      return Number(a) === m * acc;
    },
    temperature: (p, a) => {
      const c = Number(p.match(/-?\d+/)![0]);
      return Number(a) === c + 273;
    },
    distributive: (p, a) => {
      const [x, y, z] = p.match(/\d+/g)!.map(Number);
      return Number(a) === x * (y + z);
    }
  };

  for (const [drill, verifyAnswer] of Object.entries(check)) {
    it(`${drill} answers agree with independent arithmetic`, () => {
      const exercises = generateExercises(drill, drill, { count: 60, seed: 11 });
      expect(exercises.length).toBeGreaterThan(0);
      for (const exercise of exercises) {
        expect({ prompt: exercise.prompt, ok: verifyAnswer(exercise.prompt, exercise.answer) }).toEqual({
          prompt: exercise.prompt,
          ok: true
        });
      }
    });
  }

  it('generates a usable exercise for every declared drill', () => {
    for (const drill of knownDrills()) {
      const exercises = generateExercises(drill, drill, { count: 5, seed: 5 });
      expect(exercises.length).toBeGreaterThan(0);
      for (const exercise of exercises) {
        expect(exercise.prompt.length).toBeGreaterThan(5);
        expect(exercise.answer.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('marking', () => {
  const [addition] = generateExercises('addition', 'addition', { count: 1, seed: 42 });
  const expected = Number(addition.answer);

  it('accepts the answer stated in a sentence', () => {
    expect(verify(addition, `I think it is ${expected}`).correct).toBe(true);
  });

  it('rejects a wrong answer', () => {
    expect(verify(addition, `it is ${expected + 1}`).correct).toBe(false);
  });

  it('rejects an answer that states nothing', () => {
    const verdict = verify(addition, 'I have not learned that yet.');
    expect(verdict.correct).toBe(false);
    expect(verdict.got).toBeNull();
  });

  it('does not credit an echo of the question', () => {
    // The prompt's own numbers must not be read as the answer.
    expect(verify(addition, addition.prompt).correct).toBe(false);
  });

  it('reads the last number as the stated answer', () => {
    expect(statedNumber('first 3, then 4, so 7')).toBe('7');
    expect(statedNumber('no numbers here')).toBeNull();
    expect(statedNumber('the answer is -12')).toBe('-12');
  });

  it('matches text answers on whole words', () => {
    const parity = { concept: 'even number', drill: 'parity', prompt: 'Is 8 even or odd?', answer: 'even', kind: 'text' as const };
    expect(verify(parity, 'it is even').correct).toBe(true);
    expect(verify(parity, 'it is odd').correct).toBe(false);
  });

  it('does not credit an answer that hedges both ways', () => {
    const parity = { concept: 'even number', drill: 'parity', prompt: 'Is 8 even or odd?', answer: 'even', kind: 'text' as const };
    expect(verify(parity, 'it could be even or odd').correct).toBe(false);
  });

  it('does not credit an answer that negates the expected word', () => {
    const parity = { concept: 'even number', drill: 'parity', prompt: 'Is 8 even or odd?', answer: 'even', kind: 'text' as const };
    expect(verify(parity, 'it is not even').correct).toBe(false);
    expect(verify(parity, 'it is even not').correct).toBe(false);
    // Denying the alternative is not an affirmation either — it never states
    // the expected word, so it cannot be credited.
    expect(verify(parity, 'it is not odd').correct).toBe(false);

    const prime = { concept: 'prime', drill: 'prime', prompt: 'Is 7 a prime number?', answer: 'yes', kind: 'text' as const };
    expect(verify(prime, 'not yes').correct).toBe(false);

    const factor = { concept: 'factor', drill: 'factor', prompt: 'Is 5 a factor of 7?', answer: 'no', kind: 'text' as const };
    expect(verify(factor, 'not no').correct).toBe(false);
  });

  it('matches fraction answers literally', () => {
    const fraction = {
      concept: 'simplest form',
      drill: 'simplify-fraction',
      prompt: 'Write 6/8 in simplest form.',
      answer: '3/4',
      kind: 'text' as const
    };
    expect(verify(fraction, 'that is 3/4').correct).toBe(true);
    expect(verify(fraction, 'that is 6/8').correct).toBe(false);
  });
});

describe('the held-out split', () => {
  const exercises = generateExercises('multiplication', 'multiplication', { count: 100, seed: 9 });
  const { train, test } = splitExercises(exercises);

  it('partitions without leaking a question into both sides', () => {
    const trainPrompts = new Set(train.map((e) => e.prompt));
    for (const exercise of test) expect(trainPrompts.has(exercise.prompt)).toBe(false);
    expect(train.length + test.length).toBe(exercises.length);
    expect(test.length).toBeGreaterThan(0);
  });

  it('is reproducible', () => {
    const again = splitExercises(exercises);
    expect(again.test.map((e) => e.prompt)).toEqual(test.map((e) => e.prompt));
  });
});

describe('scoring separates induction from memorization', () => {
  const exercises = generateExercises('multiplication', 'multiplication', { count: 40, seed: 13 });

  it('scores a perfect learner above chance', () => {
    const score = scoreExercises(exercises, (e) => e.answer);
    expect(score.accuracy).toBe(1);
    expect(score.aboveChance).toBe(true);
  });

  it('scores a learner that memorized nothing at chance', () => {
    const score = scoreExercises(exercises, () => 'I do not know');
    expect(score.accuracy).toBe(0);
    expect(score.aboveChance).toBe(false);
  });

  it('does not call a coin flip induction on a binary drill', () => {
    const parity = generateExercises('parity', 'even number', { count: 40, seed: 4 });
    let i = 0;
    const score = scoreExercises(parity, () => (i++ % 2 === 0 ? 'even' : 'odd'));
    expect(score.chance).toBe(0.5);
    expect(score.aboveChance).toBe(false);
  });

  it('reports a chance baseline for every drill', () => {
    for (const drill of knownDrills()) {
      expect(chanceLevel(drill)).toBeGreaterThan(0);
      expect(chanceLevel(drill)).toBeLessThanOrEqual(0.5);
    }
  });

  it('scores answer-clustered families by their real answer space', () => {
    // A blind guess on these families hits ~1/60..1/121 of the space, not
    // the flat 1% — crediting them at 1% would call noise induction.
    expect(chanceLevel('gcf')).toBeCloseTo(1 / 60, 3);
    expect(chanceLevel('lcm')).toBeCloseTo(1 / 112, 3);
    expect(chanceLevel('square-root')).toBeCloseTo(1 / 19, 3);
    expect(chanceLevel('temperature')).toBeCloseTo(1 / 121, 3);
    expect(chanceLevel('rounding')).toBeCloseTo(1 / 101, 3);
    // Unclustered families keep the 1% flat baseline.
    expect(chanceLevel('addition')).toBe(0.01);
    expect(chanceLevel('multiplication')).toBe(0.01);
  });
});

describe('the checkable curriculum', () => {
  it('can drill every concept that claims to be checkable', () => {
    for (const concept of CHECKABLE_CONCEPTS) {
      const exercises = generateExercises(concept.drill as string, concept.word, { count: 3, seed: 2 });
      expect(exercises.length).toBeGreaterThan(0);
      for (const exercise of exercises) {
        expect(exercise.concept).toBe(concept.word);
        expect(verify(exercise, `the answer is ${exercise.answer}`).correct).toBe(true);
      }
    }
  });

  it('has a generator for every drill and a drill for every generator', () => {
    const declared = new Set(CHECKABLE_CONCEPTS.map((c) => c.drill as string));
    for (const drill of declared) expect(GENERATORS[drill]).toBeDefined();
    for (const drill of knownDrills()) expect(declared.has(drill)).toBe(true);
  });
});
