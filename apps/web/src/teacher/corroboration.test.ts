/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import {
  corroborationConfidence,
  distinctClasses,
  isCorroborated,
  hedgeFor,
  hedgeForClaim,
  evidenceInText,
  stripClaimHedges,
  backingEdge,
  classesOf
} from './corroboration';
import { hedgeComposition, criticize, composeGrounded } from './groundedFrames';
import { mulberry32 } from '@sschepis/sentient-core';
import type { Relation } from './relations';

const REGEX = (subject: string, predicate: Relation['predicate'], object: string): Relation => ({
  subject,
  predicate,
  object,
  source: 'def',
  origin: 'regex',
  sourceClasses: ['curriculum']
});

describe('P14 corroboration policy (single-source weak, multi-source strong)', () => {
  it('corroborationConfidence: 1 curriculum class = 1.0, 1 definition class = 0.6, 2+ classes promote', () => {
    // A single stated curriculum source is the P8 baseline...
    expect(corroborationConfidence(['curriculum'])).toBe(1);
    // ...a single LLM-chaperoned source is weak...
    expect(corroborationConfidence(['definition'])).toBe(0.6);
    // ...and agreement across independent classes promotes with headroom.
    expect(corroborationConfidence(['curriculum', 'definition'])).toBe(1);
    expect(corroborationConfidence(['curriculum', 'conversation', 'definition'])).toBe(1.2);
    expect(corroborationConfidence(['curriculum', 'conversation', 'world-feedback', 'definition'])).toBe(1.4);
  });

  it('isCorroborated requires >= 2 distinct classes; distinctClasses dedupes', () => {
    expect(isCorroborated(['curriculum'])).toBe(false);
    // The same class twice is NOT corroboration — agreeing with yourself.
    expect(isCorroborated(['curriculum', 'curriculum'])).toBe(false);
    expect(isCorroborated(['curriculum', 'conversation'])).toBe(true);
    expect(distinctClasses(['curriculum', 'curriculum', 'conversation'])).toEqual(['curriculum', 'conversation']);
  });

  it('hedgeFor: weakened -> "Probably", single-source -> "I think", corroborated -> flat', () => {
    expect(hedgeFor(['curriculum'], 1)).toBe('I think');
    expect(hedgeFor(['definition'], 1)).toBe('I think');
    expect(hedgeFor(['curriculum'], 0.8)).toBe('Probably');
    expect(hedgeFor(['curriculum', 'conversation'], 1)).toBe('');
    expect(hedgeFor(['curriculum', 'conversation', 'definition'], 1)).toBe('');
    // Corroboration removes hedging, but a weakened edge still hedges.
    expect(hedgeFor(['curriculum', 'conversation'], 0.5)).toBe('Probably');
  });
});

describe('P14 evidence mining (declarative statements only)', () => {
  it('mines a user statement that expresses the relation', () => {
    expect(evidenceInText('my dog can bark', 'dog', 'capable-of', 'bark')).toBe(true);
    expect(evidenceInText('a robin is a bird I saw in the garden', 'robin', 'is-a', 'bird')).toBe(true);
    expect(evidenceInText('the dog has a tail', 'dog', 'has-part', 'tail')).toBe(true);
    expect(evidenceInText('snow is cold today', 'snow', 'has-property', 'cold')).toBe(true);
    expect(evidenceInText('the table is made of wood', 'table', 'made-of', 'wood')).toBe(true);
    expect(evidenceInText('the bird is in the sky', 'bird', 'located-in', 'sky')).toBe(true);
  });

  it('accepts plural forms ("robins are birds")', () => {
    expect(evidenceInText('robins are birds', 'robin', 'is-a', 'bird')).toBe(true);
    expect(evidenceInText('dogs can bark loudly', 'dog', 'capable-of', 'bark')).toBe(true);
  });

  it('never mines questions, negations, or bare co-mention', () => {
    // Questions ask — they do not assert.
    expect(evidenceInText('is a robin a bird', 'robin', 'is-a', 'bird')).toBe(false);
    expect(evidenceInText('can a dog bark?', 'dog', 'capable-of', 'bark')).toBe(false);
    // Negations assert the absence.
    expect(evidenceInText('a robin is not a bird', 'robin', 'is-a', 'bird')).toBe(false);
    expect(evidenceInText('dogs never bark', 'dog', 'capable-of', 'bark')).toBe(false);
    // Co-mention without the predicate is NOT corroboration: "the dog chased
    // the cat" must never support dog is-a cat.
    expect(evidenceInText('the dog chased the cat', 'dog', 'is-a', 'cat')).toBe(false);
    expect(evidenceInText('robins and birds are nice', 'robin', 'is-a', 'bird')).toBe(false);
    // Uncommon predicates have no safe surface pattern — never mined.
    expect(evidenceInText('the fire causes smoke', 'fire', 'causes', 'smoke')).toBe(false);
  });
});

describe('P14 hedgeForClaim over a relation graph', () => {
  const RELATIONS: Relation[] = [
    REGEX('robin', 'is-a', 'bird'),
    REGEX('bird', 'has-part', 'wings'),
    { subject: 'bird', predicate: 'capable-of', object: 'fly', source: 'llm', origin: 'chaperone', sourceClasses: ['definition'] },
    { subject: 'snow', predicate: 'has-property', object: 'cold', source: 'def', origin: 'regex', sourceClasses: ['curriculum', 'conversation'] },
    { subject: 'robin', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex', sourceClasses: ['curriculum'], strength: 0.7 }
  ];

  it('a single-source claim hedges "I think"; corroborated claims assert flatly', () => {
    expect(hedgeForClaim(RELATIONS, 'robin', 'is-a', 'bird')).toBe('I think');
    expect(hedgeForClaim(RELATIONS, 'bird', 'capable-of', 'fly')).toBe('I think');
    expect(hedgeForClaim(RELATIONS, 'snow', 'has-property', 'cold')).toBe('');
  });

  it('a weakened edge hedges "Probably" even when corroborated', () => {
    expect(hedgeForClaim(RELATIONS, 'robin', 'has-part', 'wings')).toBe('Probably');
    expect(hedgeFor(['curriculum', 'conversation'], 0.7)).toBe('Probably');
  });

  it('inherited backing hedges with the ancestor edge (robin has wings via bird)', () => {
    const inheritedOnly = RELATIONS.filter((r) => !(r.subject === 'robin' && r.predicate === 'has-part'));
    // bird has-part wings is single-source — the inherited claim hedges too.
    expect(hedgeForClaim(inheritedOnly, 'robin', 'has-part', 'wings')).toBe('I think');
  });

  it('backingEdge resolves direct and inherited backing; classesOf defaults to origin class', () => {
    expect(backingEdge(RELATIONS, 'robin', 'is-a', 'bird')?.origin).toBe('regex');
    // Direct backing wins over inherited (the fixture holds robin has-part wings).
    expect(backingEdge(RELATIONS, 'robin', 'has-part', 'wings')?.subject).toBe('robin');
    expect(backingEdge(RELATIONS, 'robin', 'made-of', 'wood')).toBeNull();
    const bare: Relation = { subject: 'x', predicate: 'is-a', object: 'y', source: 's', origin: 'chaperone' };
    expect(classesOf(bare)).toEqual(['definition']);
  });

  it('stripClaimHedges removes the presentation markers, leaving the composition', () => {
    expect(stripClaimHedges('I think a robin is a bird. I think it has wings.')).toBe('a robin is a bird. it has wings.');
    expect(stripClaimHedges('Probably, a robin is a bird.')).toBe('a robin is a bird.');
    expect(stripClaimHedges('A robin is a bird.')).toBe('A robin is a bird.');
  });
});

describe('P14 generated-output hedging (the grounded composition path)', () => {
  const SINGLE: Relation[] = [
    REGEX('robin', 'is-a', 'bird'),
    REGEX('bird', 'has-part', 'wings'),
    REGEX('bird', 'has-part', 'feathers')
  ];
  const CORROBORATED: Relation[] = SINGLE.map((r) => ({
    ...r,
    sourceClasses: r.predicate === 'is-a' ? ['curriculum', 'conversation'] : ['curriculum', 'definition']
  }));

  it('hedgeComposition hedges every single-source part and asserts corroborated parts flatly', () => {
    const hedged = hedgeComposition('A robin is a bird. It has wings and feathers.', SINGLE);
    expect(hedged.hedged).toBe(true);
    expect(hedged.sentence).toBe('I think a robin is a bird. I think it has wings and feathers.');

    const flat = hedgeComposition('A robin is a bird. It has wings and feathers.', CORROBORATED);
    expect(flat.hedged).toBe(false);
    expect(flat.sentence).toBe('A robin is a bird. It has wings and feathers.');
  });

  it('a weakened edge hedges "Probably" in generated output', () => {
    const weakened = SINGLE.map((r) => ({ ...r, strength: 0.6 }));
    const hedged = hedgeComposition('A robin is a bird.', weakened);
    expect(hedged.sentence).toBe('Probably, a robin is a bird.');
  });

  it('the critic reports corroboration state per claim (hedged/hedges)', () => {
    const verdict = criticize('A robin is a bird. It has wings.', SINGLE, []);
    expect(verdict.grounded).toBe(true);
    expect(verdict.hedged).toBe(true);
    expect(verdict.hedges).toEqual(['I think', 'I think']);

    const confirmed = criticize('A robin is a bird. It has wings.', CORROBORATED, []);
    expect(confirmed.grounded).toBe(true);
    expect(confirmed.hedged).toBe(false);
  });

  it('composeGrounded reports the composition hedge state deterministically', () => {
    const a = composeGrounded(['robin'], SINGLE, mulberry32(7));
    expect(a).not.toBeNull();
    expect(a!.hedged).toBe(true);
    // Hedging is presentation — the raw composition is unchanged and the
    // critic still accepts it.
    expect(criticize(a!.sentence, SINGLE, []).grounded).toBe(true);
  });
});

describe('P14 TeacherAgent integration (the edge store)', () => {
  const DECK = [
    { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
    { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' },
    { word: 'wings', definition: 'a part of a bird used for flying', example: 'Wings flap.' },
    { word: 'feathers', definition: 'a soft covering of a bird', example: 'Feathers are soft.' },
    { word: 'fly', definition: 'to move through the air using wings', example: 'Birds fly.' }
  ];

  async function setup(compositionSeed?: number): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
    const session = new ObserverSession({}, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK, null, 1, 4, compositionSeed);
    for (const entry of DECK) teacher.teach(entry.word);
    // Unlock creative mode.
    for (const cue of ['hello', 'hi', 'how are you', 'what is up', 'good morning']) {
      teacher.teachResponse({ cue, response: `reply to ${cue}` });
      teacher.respond(cue);
    }
    return { session, teacher };
  }

  it('single-source grounded answers are hedged; agreeing chaperone edges remove the hedge', async () => {
    const { session, teacher } = await setup(42);
    const first = teacher.chatAnswer('tell me about robin');
    expect(first.mode).toBe('creative');
    if (first.mode === 'creative') {
      expect(first.grounded).toBe(true);
      expect(first.hedged).toBe(true);
      expect(first.response).toMatch(/I think/);
      expect(first.response).not.toMatch(/Probably/);
    }

    // An INDEPENDENT class agrees with EVERY edge the graph holds (the LLM
    // chaperone) — any composition the observer now builds is corroborated.
    for (const relation of teacher.relations()) {
      teacher.applyRelations([
        { subject: relation.subject, predicate: relation.predicate, object: relation.object, source: 'llm', origin: 'chaperone' }
      ]);
    }
    expect(teacher.edgeSourcesOf('robin', 'is-a', 'bird')).toContain('definition');

    const second = teacher.chatAnswer('tell me about robin');
    expect(second.mode).toBe('creative');
    if (second.mode === 'creative') {
      expect(second.hedged).toBe(false);
      expect(second.response).not.toMatch(/I think|Probably/);
    }
    session.dispose();
  }, 30000);

  it('a user statement corroborates an edge across source classes (conversation evidence)', async () => {
    const { session, teacher } = await setup();
    // Before the user speaks: single curriculum class.
    expect(teacher.edgeSourcesOf('robin', 'is-a', 'bird')).toEqual(['curriculum']);
    // The user USES the words in a sentence — that is evidence.
    teacher.chatAnswer('a robin is a bird I saw in the garden');
    expect(teacher.edgeSourcesOf('robin', 'is-a', 'bird')).toEqual(['curriculum', 'conversation']);
    expect(isCorroborated(teacher.edgeSourcesOf('robin', 'is-a', 'bird'))).toBe(true);
    // A QUESTION about the same relation is not evidence.
    teacher.chatAnswer('is a robin a bird');
    expect(teacher.edgeSourcesOf('robin', 'is-a', 'bird')).toEqual(['curriculum', 'conversation']);
    session.dispose();
  }, 30000);

  it('an accepted graded answer adds world-feedback corroboration; a rejected one withdraws it', async () => {
    const { session, teacher } = await setup();
    const edges = [{ subject: 'robin', predicate: 'is-a' as const, object: 'bird' }];
    teacher.creativeGradeFeedback({ traceIds: [], edges }, 0.9, 'is robin a bird', 'yes');
    expect(teacher.edgeSourcesOf('robin', 'is-a', 'bird')).toEqual(['curriculum', 'world-feedback']);
    teacher.creativeGradeFeedback({ traceIds: [], edges }, 0.2, 'is robin a bird', 'maybe not');
    expect(teacher.edgeSourcesOf('robin', 'is-a', 'bird')).toEqual(['curriculum']);
    session.dispose();
  });

  it('a single-source LLM-chaperoned edge answers hedged in the operator path', async () => {
    const { session, teacher } = await setup();
    // apple is not in this deck — use the deck's own subjects: a chaperone
    // edge with NO deck-example corroboration stays weak (single class).
    teacher.applyRelations([
      { subject: 'robin', predicate: 'has-property', object: 'red', source: 'llm', origin: 'chaperone' }
    ]);
    // The deck example "I saw a robin." does not express the property, and
    // no other class agrees — the single LLM source is hedged.
    expect(teacher.edgeStrengthOf('robin', 'has-property', 'red')).toBe(0.6);
    const answer = teacher.chatAnswer('is a robin red');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') {
      expect(answer.response).toContain('Probably');
      expect(answer.response).toContain('red');
    }
    session.dispose();
  }, 30000);

  it('corroboration survives export -> import (edgeSources ride the bootstrap)', async () => {
    const { session, teacher } = await setup();
    teacher.chatAnswer('a robin is a bird I saw in the garden');
    teacher.creativeGradeFeedback({ traceIds: [], edges: [{ subject: 'robin', predicate: 'is-a', object: 'bird' }] }, 0.9, 'is robin a bird', 'yes');
    const record = teacher.exportBootstrap('test');
    expect(record.edgeSources).toBeDefined();
    session.dispose();

    const fresh = new ObserverSession({}, 100);
    await fresh.initialize();
    const freshTeacher = new TeacherAgent(fresh, DECK);
    freshTeacher.importBootstrap(record);
    const classes = freshTeacher.edgeSourcesOf('robin', 'is-a', 'bird');
    expect(classes).toContain('conversation');
    expect(classes).toContain('world-feedback');
    expect(isCorroborated(classes)).toBe(true);
    fresh.dispose();
  }, 30000);
});
