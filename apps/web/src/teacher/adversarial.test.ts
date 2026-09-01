/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  claimsRelationalYes,
  outOfVocabulary,
  assertsDefinitionOf,
  negativeTargetsFor,
  responseContentWords,
  isRelationalKind,
  type ProbeAnswer
} from './adversarial';
import type { Relation } from './relations';

const RELATIONS: Relation[] = [
  { subject: 'golf', predicate: 'is-a', object: 'game', source: 'a game played with a ball', origin: 'regex' },
  { subject: 'game', predicate: 'is-a', object: 'activity', source: 'an activity with rules', origin: 'regex' },
  { subject: 'game', predicate: 'has-part', object: 'rules', source: 'a contest with rules', origin: 'regex' },
  { subject: 'golf', predicate: 'has-part', object: 'ball', source: 'a game with a ball', origin: 'regex' }
];

const VOCAB = new Set(['i', 'am', 'well', 'hello', 'learn', 'english', 'yes', 'no', 'know', 'want', 'game', 'golf', 'rules']);

const operator = (kind: string, response: string): ProbeAnswer => ({ mode: 'operator', response, operator: { kind } });

describe('adversarial honesty predicates', () => {
  it('claimsRelationalYes flags confident yes on relational operator kinds only', () => {
    expect(claimsRelationalYes(operator('is-a', 'Yes, golf is a game.'))).toBe(true);
    expect(claimsRelationalYes(operator('has-part', 'Yes, golf has rules.'))).toBe(true);
    expect(claimsRelationalYes(operator('made-of', 'Yes, golf is made of wood.'))).toBe(true);
    // Definition / yesno / learned operators are NOT relational claims.
    expect(claimsRelationalYes(operator('definition', 'Yes, ...'))).toBe(false);
    expect(claimsRelationalYes(operator('yesno', 'Yes, I know golf.'))).toBe(false);
    expect(claimsRelationalYes(operator('learned', 'Yes, I want tea.'))).toBe(false);
    // Creative / ask / decline never claim.
    expect(claimsRelationalYes({ mode: 'creative', response: 'Yes, I am well.' })).toBe(false);
    expect(claimsRelationalYes({ mode: 'ask', response: 'Yes, what is that?' })).toBe(false);
    expect(claimsRelationalYes({ mode: 'decline' })).toBe(false);
  });

  it('isRelationalKind names exactly the chained operators', () => {
    expect(isRelationalKind('is-a')).toBe(true);
    expect(isRelationalKind('has-part')).toBe(true);
    expect(isRelationalKind('made-of')).toBe(true);
    expect(isRelationalKind('definition')).toBe(false);
    expect(isRelationalKind(undefined)).toBe(false);
  });

  it('outOfVocabulary flags content words outside the known vocabulary', () => {
    expect(outOfVocabulary('Yes, I want quinoa.', VOCAB)).toEqual(['quinoa']);
    expect(outOfVocabulary('Yes, I want quinoa.', VOCAB, 'quinoa')).toEqual([]); // echoed slot is honest
    // A relation-hole object (P6) is allowed only when named as backed.
    expect(outOfVocabulary('a robin is a bird.', VOCAB)).toEqual(['robin', 'bird']);
    expect(outOfVocabulary('a robin is a bird.', VOCAB, 'robin', ['bird'])).toEqual([]);
    expect(outOfVocabulary('I am well, thank you.', VOCAB)).toEqual(['thank']);
    expect(outOfVocabulary('Yes, I know golf.', VOCAB)).toEqual([]);
  });

  it('responseContentWords ignores function words', () => {
    // "want" and "know" are deliberately function words in the observer's
    // lexicon; the content words are tea and rain.
    expect(responseContentWords('Yes, I want tea and rain.')).toEqual(['tea', 'rain']);
  });

  it('assertsDefinitionOf catches "X is ..." claims about a subject', () => {
    expect(assertsDefinitionOf('Zzz is a word I know.', 'zzz')).toBe(true);
    expect(assertsDefinitionOf('I am well, thank you.', 'zzz')).toBe(false);
    // "My name is Observer." defines "name" — not "golf".
    expect(assertsDefinitionOf('My name is Observer.', 'golf')).toBe(false);
    expect(assertsDefinitionOf('What is zzz?', 'zzz')).toBe(false); // question, not claim
  });

  it('negativeTargetsFor excludes the TRANSITIVE closure, known parts, and materials', () => {
    const deck = ['golf', 'game', 'activity', 'rules', 'ball', 'bird', 'water', 'sky', 'tree', 'stone'];
    // golf's transitive closure: golf is-a game is-a activity — ALL of them
    // would truthfully answer "is golf a X" and must be excluded.
    const targets = negativeTargetsFor('golf', RELATIONS, deck, 4);
    expect(targets).not.toContain('golf');
    expect(targets).not.toContain('game');
    expect(targets).not.toContain('activity');
    expect(targets).not.toContain('rules');
    expect(targets).not.toContain('ball');
    expect(targets).toHaveLength(4);
    expect(targets.every((t) => ['bird', 'water', 'sky', 'tree', 'stone'].includes(t))).toBe(true);
  });
});