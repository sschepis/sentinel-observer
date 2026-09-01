/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { applyOperator, CLOCK_ANSWER_RE, clusterGaps, type OperatorContext } from './operators';
import type { Relation } from './relations';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { DECK_100 } from './decks/en-100';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';

const DECK = DECK_100.slice(0, 5);

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

describe('operators (deterministic answers from memory)', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DECK);
    teacher.teach('apple');
    teacher.teach('water');
  });

  afterEach(() => {
    session.dispose();
  });

  it('answers "what is X" from the taught definition (operator route)', () => {
    const answer = teacher.chatAnswer('what is apple');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') {
      expect(answer.operator!.kind).toBe('definition');
      expect(answer.response.toLowerCase()).toContain('apple');
      expect(answer.response.toLowerCase()).toContain('fruit');
    }
  });

  it('answers definitions for multiword curriculum concepts', () => {
    const ctx: OperatorContext = {
      isTaught: (word) => word === 'natural selection',
      definitionOf: (word) => word === 'natural selection' ? 'change driven by differences in reproductive success' : '',
      wordCount: () => 1,
      phraseCount: () => 0
    };
    const answer = applyOperator('what is natural selection', ctx);
    expect(answer?.kind).toBe('definition');
    if (answer?.kind === 'definition') expect(answer.word).toBe('natural selection');
  });

  it('honestly declines "what is X" for an untaught word', () => {
    const answer = teacher.chatAnswer('what is a chair');
    // 'chair' is NOT taught and not in the DECK — no operator claims it;
    // with no conversation cues heard and creative locked, it ASKS.
    expect(answer.mode === 'ask' || answer.mode === 'creative').toBe(true);
  });

  it('answers "do you know X" yes/no honestly', () => {
    const yes = teacher.chatAnswer('do you know apple');
    expect(yes.mode).toBe('operator');
    if (yes.mode === 'operator') {
      expect(yes.response.toLowerCase()).toMatch(/^yes/);
    }
    const no = teacher.chatAnswer('do you know chair');
    expect(no.mode).toBe('operator');
    if (no.mode === 'operator') {
      expect(no.response.toLowerCase()).toMatch(/^no/);
    }
  });

  it('counts words and phrases', () => {
    teacher.teachResponse({ cue: 'hello', response: 'Hello there!' });
    const words = teacher.chatAnswer('how many words do you know');
    expect(words.mode).toBe('operator');
    if (words.mode === 'operator') {
      expect(words.response).toBe('I know 2 words.');
    }
    const phrases = teacher.chatAnswer('how many phrases do you know');
    expect(phrases.mode).toBe('operator');
    if (phrases.mode === 'operator') {
      expect(phrases.response).toBe('I have learned 1 phrase.');
    }
  });

  it('echoes a taught word for "say X" and declines unknown ones honestly', () => {
    const echo = teacher.chatAnswer('say apple');
    expect(echo.mode).toBe('operator');
    if (echo.mode === 'operator') {
      expect(echo.response).toBe('apple');
    }
    const unknown = teacher.chatAnswer('say chair');
    expect(unknown.mode).toBe('operator');
    if (unknown.mode === 'operator') {
      expect(unknown.response).toMatch(/do not know/);
    }
  });

  it('non-questions fall through (no operator claimed)', () => {
    const ctx: OperatorContext = {
      isTaught: () => true,
      definitionOf: () => 'x',
      wordCount: () => 1,
      phraseCount: () => 0
    };
    expect(applyOperator('the sky is blue', ctx)).toBeNull();
    expect(applyOperator('hello', ctx)).toBeNull();
  });

  it('walks authored relations for multiword science concepts', () => {
    const ctx: OperatorContext = {
      isTaught: () => true,
      definitionOf: () => '',
      wordCount: () => 3,
      phraseCount: () => 0,
      relations: () => [
        { subject: 'red giant', predicate: 'is-a', object: 'star', source: 'test', origin: 'authored' },
        { subject: 'galaxy', predicate: 'has-part', object: 'star', source: 'test', origin: 'authored' },
        { subject: 'chromosome', predicate: 'made-of', object: 'dna', source: 'test', origin: 'authored' }
      ]
    };
    expect(applyOperator('is a red giant a star', ctx)?.kind).toBe('is-a');
    expect(applyOperator('does a galaxy have a star', ctx)?.kind).toBe('has-part');
    expect(applyOperator('is chromosome made of dna', ctx)?.kind).toBe('made-of');
  });

  it('answers the clock and the date deterministically', () => {
    const ctx: OperatorContext = {
      isTaught: () => true,
      definitionOf: () => 'the time',
      wordCount: () => 1,
      phraseCount: () => 0
    };
    const time = applyOperator('what time is it', ctx);
    expect(time?.kind).toBe('clock');
    if (time?.kind === 'clock') {
      expect(time.answer).toMatch(CLOCK_ANSWER_RE);
      expect(time.what).toBe('time');
    }
    const date = applyOperator('what day is it', ctx);
    expect(date?.kind).toBe('clock');
    if (date?.kind === 'clock') {
      expect(date.what).toBe('date');
      expect(date.answer).toMatch(/^Today is /);
    }
    // Even when "time" is a taught word, the clock wins.
    expect(applyOperator('what is the time', ctx)?.kind).toBe('clock');
  });

  it('negation inverts the yes/no answer', () => {
    const ctx: OperatorContext = {
      isTaught: (word) => word === 'apple',
      definitionOf: () => '',
      wordCount: () => 1,
      phraseCount: () => 0
    };
    const known = applyOperator('do you not know apple', ctx);
    expect(known?.kind).toBe('yesno');
    if (known?.kind === 'yesno') expect(known.answer).toMatch(/^Yes/);
    const unknown = applyOperator('do you not know chair', ctx);
    expect(unknown?.kind).toBe('yesno');
    if (unknown?.kind === 'yesno') expect(unknown.answer).toMatch(/^No/);
  });

  it('answers capabilities honestly — known ones yes, others a clear not-yet', () => {
    const ctx: OperatorContext = {
      isTaught: () => true,
      definitionOf: () => '',
      wordCount: () => 1,
      phraseCount: () => 0
    };
    const can = applyOperator('can you count', ctx);
    expect(can?.kind).toBe('capability');
    if (can?.kind === 'capability') expect(can.answer).toMatch(/^Yes/);
    const cannot = applyOperator('can you fly', ctx);
    expect(cannot?.kind).toBe('capability');
    if (cannot?.kind === 'capability') expect(cannot.answer).toMatch(/^No, I cannot fly yet\./);
  });

  it('answers a property ONLY when the taught definition literally names it', () => {
    const ctx: OperatorContext = {
      isTaught: (word) => word === 'apple' || word === 'sky',
      definitionOf: (word) => (word === 'apple' ? 'a round red or green fruit' : 'the upper atmosphere'),
      wordCount: () => 2,
      phraseCount: () => 0
    };
    const color = applyOperator('what color is the apple', ctx);
    expect(color?.kind).toBe('property');
    if (color?.kind === 'property') {
      expect(color.value).toBe('red');
      expect(color.answer).toBe('The color of apple is red.');
    }
    // No color word in the definition → honest fall-through.
    expect(applyOperator('what color is the sky', ctx)).toBeNull();
  });

  it('answers "where is X" only from a location clause in the taught definition', () => {
    const ctx: OperatorContext = {
      isTaught: (word) => word === 'moon' || word === 'water',
      definitionOf: (word) => (word === 'moon' ? 'the natural satellite of the earth visible in the sky' : 'a clear liquid'),
      wordCount: () => 2,
      phraseCount: () => 0
    };
    const where = applyOperator('where is the moon', ctx);
    expect(where?.kind).toBe('where');
    if (where?.kind === 'where') {
      expect(where.place).toBe('sky');
      expect(where.answer).toBe('Moon is in the sky.');
    }
    expect(applyOperator('where is water', ctx)).toBeNull();
  });

  it('memorized exchanges still win over operators', () => {
    teacher.teachResponse({ cue: 'how are you', response: 'I am well, thank you.' });
    const answer = teacher.chatAnswer('how are you');
    expect(answer.mode).toBe('memorized');
  });
});

describe('introspective operators (the observer\'s reportable self)', () => {
  it('answers preference questions from exposure, never a fabricated preference', () => {
    const ctx: OperatorContext = {
      isTaught: () => false,
      definitionOf: () => '',
      wordCount: () => 0,
      phraseCount: () => 0,
      exposureOf: (word) => (word === 'tea' ? 3 : 0),
      recallStrengthOf: () => null,
      consolidatedWords: () => [],
      gapList: () => []
    };
    const unknown = applyOperator('do you like tea', ctx);
    expect(unknown?.kind).toBe('introspection');
    if (unknown?.kind === 'introspection') {
      expect(unknown.answer).toContain('3 times');
      expect(unknown.answer).not.toContain('Yes, I like');
    }
    const neverHeard = applyOperator('do you like arsenic', ctx);
    expect(neverHeard?.kind).toBe('introspection');
    if (neverHeard?.kind === 'introspection') {
      expect(neverHeard.answer).toContain('have not learned');
    }
  });

  it('answers "what are you curious about" from the gap list', () => {
    const ctx: OperatorContext = {
      isTaught: () => false,
      definitionOf: () => '',
      wordCount: () => 0,
      phraseCount: () => 0,
      exposureOf: () => 0,
      recallStrengthOf: () => null,
      consolidatedWords: () => [],
      gapList: () => ['what is the capital of mars', 'where is the library']
    };
    const result = applyOperator('what are you curious about', ctx);
    expect(result?.kind).toBe('introspection');
    if (result?.kind === 'introspection') {
      expect(result.answer).toContain('capital of mars');
    }
  });

  it('answers "what do you know well" from consolidation', () => {
    const ctx: OperatorContext = {
      isTaught: () => false,
      definitionOf: () => '',
      wordCount: () => 0,
      phraseCount: () => 0,
      exposureOf: () => 0,
      recallStrengthOf: () => null,
      consolidatedWords: () => ['apple', 'water'],
      gapList: () => []
    };
    const result = applyOperator('what do you know well', ctx);
    expect(result?.kind).toBe('introspection');
    if (result?.kind === 'introspection') {
      expect(result.answer).toContain('apple');
    }
  });

  it('clusterGaps groups gaps into domains by shared content words', () => {
    const clusters = clusterGaps([
      'cook rice with water',
      'cook pasta with water',
      'what is the capital of mars',
      'who is the president of france'
    ]);
    const cooking = clusters.find((c) => c.members.some((m) => m.includes('rice')));
    expect(cooking).toBeDefined();
    if (cooking !== undefined) {
      expect(cooking.members.length).toBeGreaterThanOrEqual(2);
      expect(cooking.words).toContain('cook');
      expect(cooking.words).toContain('water');
    }
  });
});

describe('expanded relational operators (P4 predicates)', () => {
  const relations = (): readonly Relation[] => [
    { subject: 'snow', predicate: 'has-property', object: 'cold', source: 'def', origin: 'chaperone' },
    { subject: 'snow', predicate: 'has-property', object: 'wet', source: 'def', origin: 'chaperone' },
    { subject: 'bird', predicate: 'capable-of', object: 'fly', source: 'def', origin: 'chaperone' },
    { subject: 'bird', predicate: 'capable-of', object: 'sing', source: 'def', origin: 'chaperone' },
    { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
    { subject: 'hammer', predicate: 'used-for', object: 'nails', source: 'def', origin: 'chaperone' },
    { subject: 'rain', predicate: 'causes', object: 'floods', source: 'def', origin: 'chaperone' },
    { subject: 'hot', predicate: 'opposite-of', object: 'cold', source: 'def', origin: 'chaperone' },
    { subject: 'fire', predicate: 'requires', object: 'oxygen', source: 'def', origin: 'chaperone' }
  ];
  const ctx: OperatorContext = {
    isTaught: () => true,
    definitionOf: () => '',
    wordCount: () => 9,
    phraseCount: () => 0,
    relations
  };

  it('answers closed and open has-property questions', () => {
    const closed = applyOperator('is snow cold', ctx);
    expect(closed?.kind).toBe('has-property');
    if (closed?.kind === 'has-property') expect(closed.answer).toBe('Yes, snow is cold.');

    const open = applyOperator('what is snow like', ctx);
    expect(open?.kind).toBe('has-property');
    if (open?.kind === 'has-property') expect(open.answer).toBe('snow is cold and wet.');
  });

  it('answers closed and open capable-of questions, including inheritance', () => {
    const closed = applyOperator('can a bird fly', ctx);
    expect(closed?.kind).toBe('capable-of');
    if (closed?.kind === 'capable-of') expect(closed.answer).toBe('Yes, a bird can fly.');

    const open = applyOperator('what does a bird do', ctx);
    expect(open?.kind).toBe('capable-of');
    if (open?.kind === 'capable-of') expect(open.answer).toBe('a bird can fly and sing.');

    // robin is-a bird, bird can fly -> inherited capability.
    const inherited = applyOperator('can a robin fly', ctx);
    expect(inherited?.kind).toBe('capable-of');
    if (inherited?.kind === 'capable-of') expect(inherited.via).toBe('bird');
  });

  it('answers used-for, causes, opposite-of, and requires', () => {
    const usedFor = applyOperator('what is a hammer for', ctx);
    expect(usedFor?.kind).toBe('used-for');
    if (usedFor?.kind === 'used-for') expect(usedFor.answer).toBe('a hammer is used for nails.');

    const causes = applyOperator('what does rain cause', ctx);
    expect(causes?.kind).toBe('causes');
    if (causes?.kind === 'causes') expect(causes.answer).toBe('rain causes floods.');

    const opposite = applyOperator('what is the opposite of hot', ctx);
    expect(opposite?.kind).toBe('opposite-of');
    if (opposite?.kind === 'opposite-of') expect(opposite.answer).toBe('The opposite of hot is cold.');

    const requires = applyOperator('what does a fire need', ctx);
    expect(requires?.kind).toBe('requires');
    if (requires?.kind === 'requires') expect(requires.answer).toBe('a fire requires oxygen.');
  });

  it('falls through honestly when no edge exists (null, not a fabricated answer)', () => {
    const honestCtx: OperatorContext = {
      isTaught: () => false,
      definitionOf: () => '',
      wordCount: () => 0,
      phraseCount: () => 0,
      relations
    };
    const closed = applyOperator('can a fish fly', honestCtx);
    expect(closed).toBeNull();
    const property = applyOperator('is snow green', honestCtx);
    expect(property).toBeNull();
    const usedFor = applyOperator('is a fish used for soup', honestCtx);
    expect(usedFor).toBeNull();
    const causes = applyOperator('does snow cause floods', honestCtx);
    expect(causes).toBeNull();
    const opposite = applyOperator('what is the opposite of snow', honestCtx);
    expect(opposite).toBeNull();
    const requires = applyOperator('does snow require oxygen', honestCtx);
    expect(requires).toBeNull();
  });

  it('article-prefixed subjects parse: "is the robin a bird", "is the table made of wood"', () => {
    const articleCtx: OperatorContext = {
      isTaught: () => true,
      definitionOf: () => '',
      wordCount: () => 4,
      phraseCount: () => 0,
      relations: () => [
        { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
        { subject: 'table', predicate: 'made-of', object: 'wood', source: 'def', origin: 'regex' }
      ]
    };
    const isA = applyOperator('is the robin a bird', articleCtx);
    expect(isA?.kind).toBe('is-a');
    if (isA?.kind === 'is-a') expect(isA.answer).toContain('robin is a bird');

    const madeOf = applyOperator('is the table made of wood', articleCtx);
    expect(madeOf?.kind).toBe('made-of');
    if (madeOf?.kind === 'made-of') expect(madeOf.answer).toContain('table is made of wood');

    const isA2 = applyOperator('is a robin a bird', articleCtx);
    expect(isA2?.kind).toBe('is-a');
  });

  it('H4: weakened edges hedge the OPEN forms ("Probably — ") exactly like the closed forms', () => {
    const weakCtx: OperatorContext = {
      isTaught: () => true,
      definitionOf: () => '',
      wordCount: () => 4,
      phraseCount: () => 0,
      relations,
      // P8: the cited edges were driven below 1 by wrong grades.
      edgeStrength: (subject, predicate) =>
        (subject === 'rain' && predicate === 'causes') || (subject === 'fire' && predicate === 'requires') ? 0.4 : 1
    };
    const causes = applyOperator('what does rain cause', weakCtx);
    expect(causes?.kind).toBe('causes');
    if (causes?.kind === 'causes') expect(causes.answer).toBe('Probably — rain causes floods.');

    const requires = applyOperator('what does a fire need', weakCtx);
    expect(requires?.kind).toBe('requires');
    if (requires?.kind === 'requires') expect(requires.answer).toBe('Probably — a fire requires oxygen.');

    // Full-confidence edges answer flat — no hedge.
    const strong = applyOperator('what is a hammer for', weakCtx);
    expect(strong?.kind).toBe('used-for');
    if (strong?.kind === 'used-for') expect(strong.answer).toBe('a hammer is used for nails.');
  });
});

describe('P1 graded holographic fallback (below the symbolic graph)', () => {
  // The graph is silent (relations = []) but the distributed-vector layer has
  // bindings — the exact "regex graph silent" case the graded layer answers.
  const gradedCtx: OperatorContext = {
    isTaught: () => true,
    definitionOf: () => '',
    wordCount: () => 2,
    phraseCount: () => 0,
    relations: () => [],
    relationalScore: (subject, predicate, object) => {
      if (subject === 'snow' && predicate === 'has-property' && object === 'cold') return 0.61;
      if (subject === 'bird' && predicate === 'is-a' && object === 'creature') return 0.58;
      if (subject === 'bird' && predicate === 'has-part' && object === 'feathers') return 0.42;
      if (subject === 'bird' && predicate === 'capable-of' && object === 'fly') return 0.33;
      return 0.05;
    },
    relationalRecall: (subject, predicate) => {
      const map: Record<string, Array<{ object: string; score: number }>> = {
        'snow\u0000has-property': [{ object: 'cold', score: 0.61 }],
        'bird\u0000is-a': [{ object: 'creature', score: 0.58 }],
        'bird\u0000has-part': [{ object: 'feathers', score: 0.42 }],
        'bird\u0000capable-of': [{ object: 'fly', score: 0.33 }]
      };
      return map[`${subject}\u0000${predicate}`] ?? [];
    }
  };

  it('answers a graph-silent closed form with a strong hedge', () => {
    const answer = applyOperator('is snow cold', gradedCtx);
    expect(answer?.kind).toBe('has-property');
    if (answer?.kind === 'has-property') {
      expect(answer.score).toBeGreaterThanOrEqual(0.5);
      expect(answer.answer).toBe('I believe so — snow is cold.');
    }
  });

  it('answers a graph-silent is-a form when the object is not a deck word', () => {
    const answer = applyOperator('is a bird a creature', gradedCtx);
    expect(answer?.kind).toBe('is-a');
    if (answer?.kind === 'is-a') expect(answer.answer).toBe('I believe so — bird is a creature.');
  });

  it('hedges a weak-score recovery as "Probably", and stays silent below the floor', () => {
    const weak = applyOperator('does a bird have feathers', gradedCtx);
    expect(weak?.kind).toBe('has-part');
    if (weak?.kind === 'has-part') expect(weak.answer).toBe('Probably — bird has feathers.');

    const borderline = applyOperator('can a bird fly', gradedCtx);
    expect(borderline?.kind).toBe('capable-of');
    if (borderline?.kind === 'capable-of') expect(borderline.answer).toBe('Probably — a bird can fly.');

    // 0.05 is below HOLO_YES_WEAK — the observer falls through (no answer).
    const absent = applyOperator('is snow green', gradedCtx);
    expect(absent).toBeNull();
  });

  it('answers an open form from the graded candidates', () => {
    const whatLike = applyOperator('what is snow like', gradedCtx);
    expect(whatLike?.kind).toBe('has-property');
    if (whatLike?.kind === 'has-property') expect(whatLike.answer).toBe('I believe snow is cold.');
  });
});

describe('exception-aware inheritance (P8 negations propagate into operators)', () => {
  const relations = (): readonly Relation[] => [
    { subject: 'penguin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
    { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex' },
    { subject: 'bird', predicate: 'capable-of', object: 'fly', source: 'def', origin: 'chaperone' },
    { subject: 'bird', predicate: 'capable-of', object: 'sing', source: 'def', origin: 'chaperone' },
    { subject: 'bird', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' }
  ];
  const ctx: OperatorContext = {
    isTaught: () => true,
    definitionOf: () => '',
    wordCount: () => 5,
    phraseCount: () => 0,
    relations,
    negationOf: (subject, predicate, object) =>
      subject === 'penguin' && predicate === 'capable-of' && object === 'fly'
        ? { evidence: 'a penguin cannot fly' }
        : null
  };

  it('the closed form answers the evidence-backed No before inheritance', () => {
    const closed = applyOperator('can a penguin fly', ctx);
    expect(closed?.kind).toBe('capable-of');
    if (closed?.kind === 'capable-of') expect(closed.answer).toBe('No, penguin cannot fly — I was taught that.');
  });

  it('the open form never lists the negated inherited object', () => {
    const open = applyOperator('what does a penguin do', ctx);
    expect(open?.kind).toBe('capable-of');
    if (open?.kind === 'capable-of') expect(open.answer).toBe('a penguin can sing.');
  });

  it('unaffected inheritance still answers (the exception is surgical)', () => {
    const wings = applyOperator('does a penguin have wings', ctx);
    expect(wings?.kind).toBe('has-part');
    if (wings?.kind === 'has-part') expect(wings.via).toBe('bird');

    const isA = applyOperator('is a penguin an animal', ctx);
    expect(isA?.kind).toBe('is-a');
    if (isA?.kind === 'is-a') expect(isA.answer).toBe('Yes, penguin is an animal.');
  });

  it('a negated is-a edge blocks the transitive walk end to end', () => {
    const notABird: OperatorContext = {
      ...ctx,
      negationOf: (subject, predicate, object) =>
        subject === 'penguin' && predicate === 'is-a' && object === 'bird'
          ? { evidence: 'a penguin is not a bird' }
          : null
    };
    const isA = applyOperator('is a penguin an animal', notABird);
    expect(isA).toBeNull(); // the only path ran through the negated edge
    const wings = applyOperator('does a penguin have wings', notABird);
    expect(wings).toBeNull();
  });
});
