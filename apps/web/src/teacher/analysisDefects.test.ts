/**
 * @jest-environment node
 *
 * Regression gates for the day-one defects recorded in docs/ANALYSIS.md §6.
 * Each test names the defect number it pins. They are deliberately small and
 * deterministic: a defect that changed a paper claim gets a test that fails
 * loudly if the behavior regresses.
 */
import { describe, it, expect } from '@jest/globals';
import { compositeScore } from './composite';
import { criticize, parseClaims, parseClaimsWithResidue } from './groundedFrames';
import { LOGIC_RULES, parseLogicDrill } from './rules/logic';
import { PEANO_RULES } from './rules/peano';
import { reduce } from './rules/engine';
import { RuleStore } from './rules/types';
import { termToString } from './rules/terms';
import type { Relation } from './relations';

const RELATIONS: Relation[] = [
  { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
  { subject: 'bird', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
  { subject: 'bird', predicate: 'capable-of', object: 'fly', source: 'def', origin: 'regex' },
  { subject: 'rain', predicate: 'causes', object: 'floods', source: 'def', origin: 'chaperone' },
  { subject: 'hot', predicate: 'opposite-of', object: 'cold', source: 'def', origin: 'chaperone' },
  { subject: 'fire', predicate: 'requires', object: 'oxygen', source: 'def', origin: 'chaperone' }
];

describe('§6 #1 — the composite is a partial judge, never a fabricated 0.5', () => {
  const weights = new Map<string, number>([['i|like', 4], ['like|rain', 4], ['i|like|rain', 4]]);

  it('reports partial and leaves resonance out when no seed amplitudes are supplied', () => {
    const score = compositeScore('I like rain', 'do you like rain', weights, ['the sky is grey']);
    expect(score.partial).toBe(true);
    expect(Number.isNaN(score.parts.resonance)).toBe(true);
    // Geometric mean of the three measured parts — on the per-part scale.
    const { fluency, novelty, relevance } = score.parts;
    expect(score.composite).toBeCloseTo(Math.pow(fluency * novelty * relevance, 1 / 3), 10);
    // The old ceiling (product × 0.5 ≤ 0.5) is gone: a fluent, novel,
    // relevant answer can reach the strong band.
    expect(score.composite).toBeGreaterThan(0.5);
  });

  it('a zero part still collapses the composite to 0 (the abstention guard)', () => {
    const echo = compositeScore('the sky is grey', 'do you like rain', weights, ['the sky is grey']);
    expect(echo.composite).toBe(0);
  });

  it('with seed amplitudes the judgment is complete and resonance is measured', () => {
    const score = compositeScore('I like rain', 'do you like rain', weights, ['the sky is grey'], [
      [1, 0, 0],
      [0.8, 0.6, 0]
    ]);
    expect(score.partial).toBe(false);
    expect(score.parts.resonance).toBeCloseTo(0.8, 6);
  });
});

describe('§6 #4 — the critic refuses clauses the claim grammar cannot read', () => {
  it('returns the unparsed clause as residue', () => {
    const parsed = parseClaimsWithResidue('A robin is a bird. Robins eat worms.', 'robin');
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.residue).toEqual(['Robins eat worms']);
  });

  it('a backed claim beside an unreadable clause is NOT grounded', () => {
    const verdict = criticize('A robin is a bird. Robins eat worms.', RELATIONS, []);
    expect(verdict.grounded).toBe(false);
    expect(verdict.unbacked).toContain('unparsed: Robins eat worms');
  });

  it('the fully readable sentence still passes', () => {
    const verdict = criticize('A robin is a bird. It has wings. It can fly.', RELATIONS, []);
    expect(verdict.grounded).toBe(true);
  });

  it('reads the predicate verbs the frame renderers produce (causes, opposite-of, requires)', () => {
    expect(parseClaims('A rain causes floods.', 'rain')).toEqual([
      { subject: 'rain', predicate: 'causes', object: 'floods', negated: false }
    ]);
    expect(parseClaims('A hot is the opposite of cold.', 'hot')).toEqual([
      { subject: 'hot', predicate: 'opposite-of', object: 'cold', negated: false }
    ]);
    expect(parseClaims('A fire requires oxygen. It causes smoke.', 'fire')).toEqual([
      { subject: 'fire', predicate: 'requires', object: 'oxygen', negated: false },
      { subject: 'fire', predicate: 'causes', object: 'smoke', negated: false }
    ]);
    expect(criticize('A rain causes floods.', RELATIONS, []).grounded).toBe(true);
    // An unbacked verb claim is refused like any other.
    expect(criticize('A fire causes smoke.', RELATIONS, []).grounded).toBe(false);
  });
});

describe('§6 #6 — the logic parser reads WHAT the premise denies', () => {
  const store = new RuleStore([...PEANO_RULES, ...LOGIC_RULES]);
  const head = (term: ReturnType<typeof parseLogicDrill>): string => {
    if (term === null || term.t !== 'sym') throw new Error(`unparseable: ${term === null ? 'null' : termToString(term)}`);
    return term.head;
  };
  const derive = (prompt: string): string => {
    const term = parseLogicDrill('logic-if', prompt);
    if (term === null) throw new Error(`unparseable: ${prompt}`);
    const outcome = reduce(store, term, { fuel: 1000 }).outcome;
    if (outcome.status !== 'normal' || outcome.term.t !== 'lit') throw new Error(`no normal form for ${prompt}`);
    return String(outcome.term.value);
  };

  it('modus ponens and modus tollens still derive yes / no', () => {
    expect(derive('If it rains, then the ground gets wet. It rains. Does the ground get wet?')).toBe('yes');
    expect(derive('If it rains, then the ground gets wet. The ground does not get wet. Did it rain?')).toBe('no');
    expect(head(parseLogicDrill('logic-if', 'If the seed is planted, then a sprout grows. No sprout grows. Was the seed planted?'))).toBe('logic.mt');
  });

  it('denying the antecedent derives UNDETERMINED, never "no"', () => {
    expect(head(parseLogicDrill('logic-if', 'If it rains, then the ground gets wet. It does not rain. Does the ground get wet?'))).toBe('logic.undetermined');
    expect(derive('If it rains, then the ground gets wet. It does not rain. Does the ground get wet?')).toBe('undetermined');
  });

  it('affirming the consequent derives UNDETERMINED, never "yes"', () => {
    expect(derive('If it rains, then the ground gets wet. The ground gets wet. Did it rain?')).toBe('undetermined');
  });

  it('a premise about neither half declines (null), never guesses', () => {
    expect(parseLogicDrill('logic-if', 'If it rains, then the ground gets wet. The cat sleeps. Does the ground get wet?')).toBeNull();
  });
});
