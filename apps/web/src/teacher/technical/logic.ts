import type { TechnicalConcept } from './types';

/**
 * LOGIC — statements, connectives, and argument forms.
 *
 * Two naming decisions matter here. "conjunction" is claimed by THIS strand
 * (the truth-functional AND, which carries the logic-and drill); the grammar
 * strand names its part of speech "grammatical conjunction" so the two never
 * collide. And "hypothesis" already belongs to the science strand — the
 * conditional DEPENDS on it rather than redeclaring it, because the if-part
 * of a conditional is exactly a proposed claim to be tested.
 *
 * Drilled concepts are checkable because their answers are truth-functional:
 * a two-line syllogism either forces its conclusion or it does not.
 */
export const LOGIC_CONCEPTS: readonly TechnicalConcept[] = [
  // ── Statements and truth ────────────────────────────────────────────────
  {
    word: 'statement',
    definition: 'a sentence that is either true or false',
    example: 'The sentence two plus two is four is a statement.',
    strand: 'logic',
    dependsOn: ['sentence'],
    relations: [{ predicate: 'special-case-of', object: 'sentence' }]
  },
  {
    word: 'truth value',
    definition: 'whether a statement is true or false',
    example: 'The truth value of the statement snow is cold is true.',
    strand: 'logic',
    dependsOn: ['statement'],
    relations: [{ predicate: 'has-property', object: 'statement' }]
  },
  {
    word: 'true statement',
    definition: 'a statement whose truth value is true',
    example: 'Seven is greater than five is a true statement.',
    strand: 'logic',
    dependsOn: ['statement', 'truth value'],
    relations: [{ predicate: 'special-case-of', object: 'statement' }]
  },
  {
    word: 'false statement',
    definition: 'a statement whose truth value is false',
    example: 'Three plus three is seven is a false statement.',
    strand: 'logic',
    dependsOn: ['statement', 'truth value'],
    relations: [{ predicate: 'special-case-of', object: 'statement' }]
  },
  {
    word: 'negation',
    definition: 'the statement that says the opposite, true exactly when the original is false',
    example: 'The negation of the door is open is the door is not open.',
    strand: 'logic',
    dependsOn: ['statement', 'truth value'],
    relations: [{ predicate: 'is-a', object: 'statement' }]
  },

  // ── Connectives ─────────────────────────────────────────────────────────
  {
    word: 'compound statement',
    definition: 'a statement built by joining simpler statements together',
    example: 'It is cold and it is raining is a compound statement.',
    strand: 'logic',
    dependsOn: ['statement'],
    relations: [
      { predicate: 'special-case-of', object: 'statement' },
      { predicate: 'made-of', object: 'statement' }
    ]
  },
  {
    word: 'conjunction',
    definition: 'a compound statement joined by and, true only when both parts are true',
    example: 'The conjunction five is odd and four is even is true.',
    strand: 'logic',
    dependsOn: ['compound statement', 'truth value'],
    relations: [{ predicate: 'special-case-of', object: 'compound statement' }],
    drill: 'logic-and'
  },
  {
    word: 'disjunction',
    definition: 'a compound statement joined by or, true when at least one part is true',
    example: 'The disjunction five is even or four is even is true.',
    strand: 'logic',
    dependsOn: ['compound statement', 'truth value'],
    relations: [{ predicate: 'special-case-of', object: 'compound statement' }],
    drill: 'logic-or'
  },
  {
    word: 'conditional',
    definition: 'an if-then statement whose if part is a hypothesis and whose then part follows from it',
    example: 'If it rains then the ground gets wet is a conditional.',
    strand: 'logic',
    dependsOn: ['compound statement', 'hypothesis'],
    relations: [{ predicate: 'special-case-of', object: 'compound statement' }],
    drill: 'logic-if'
  },
  {
    word: 'conclusion',
    definition: 'the statement an argument or conditional claims to establish',
    example: 'In if it rains then the ground gets wet, the conclusion is the ground gets wet.',
    strand: 'logic',
    dependsOn: ['conditional', 'statement'],
    relations: [{ predicate: 'is-a', object: 'statement' }]
  },
  {
    word: 'converse',
    definition: 'the conditional made by swapping the if part and the then part',
    example: 'The converse of if it rains then it is wet is if it is wet then it rains.',
    strand: 'logic',
    dependsOn: ['conditional', 'conclusion'],
    relations: [{ predicate: 'is-a', object: 'conditional' }]
  },
  {
    word: 'contrapositive',
    definition: 'the conditional made by swapping and negating both parts, always as true as the original',
    example: 'The contrapositive of if it rains then it is wet is if it is not wet then it did not rain.',
    strand: 'logic',
    dependsOn: ['converse', 'negation'],
    relations: [{ predicate: 'is-a', object: 'conditional' }]
  },

  // ── Quantified statements ───────────────────────────────────────────────
  {
    word: 'all statement',
    definition: 'a statement claiming something about every member of a group',
    example: 'All squares have four sides is an all statement.',
    strand: 'logic',
    dependsOn: ['statement'],
    relations: [{ predicate: 'special-case-of', object: 'statement' }]
  },
  {
    word: 'some statement',
    definition: 'a statement claiming something about at least one member of a group',
    example: 'Some birds cannot fly is a some statement.',
    strand: 'logic',
    dependsOn: ['statement'],
    relations: [{ predicate: 'special-case-of', object: 'statement' }]
  },
  {
    word: 'none statement',
    definition: 'a statement claiming something about no member of a group',
    example: 'No triangles have four sides is a none statement.',
    strand: 'logic',
    dependsOn: ['statement', 'negation'],
    relations: [{ predicate: 'special-case-of', object: 'statement' }]
  },
  {
    word: 'counterexample',
    definition: 'a single case that shows an all statement to be false',
    example: 'A penguin is a counterexample to all birds can fly.',
    strand: 'logic',
    dependsOn: ['all statement', 'false statement'],
    relations: [{ predicate: 'used-for', object: 'false statement' }],
    drill: 'logic-not'
  },

  // ── Arguments ───────────────────────────────────────────────────────────
  {
    word: 'premise',
    definition: 'a statement an argument accepts as a starting point',
    example: 'All cats are animals is a premise of the argument.',
    strand: 'logic',
    dependsOn: ['statement'],
    relations: [{ predicate: 'is-a', object: 'statement' }]
  },
  {
    word: 'argument',
    definition: 'a set of premises offered as reasons for a conclusion',
    example: 'The argument gave two premises and drew one conclusion.',
    strand: 'logic',
    dependsOn: ['premise', 'conclusion'],
    relations: [
      { predicate: 'has-part', object: 'premise' },
      { predicate: 'has-part', object: 'conclusion' }
    ]
  },
  {
    word: 'syllogism',
    definition: 'a two-premise argument, such as all cats are animals and Tom is a cat, so Tom is an animal',
    example: 'The syllogism about Tom the cat forces its conclusion.',
    strand: 'logic',
    dependsOn: ['argument', 'all statement'],
    relations: [{ predicate: 'special-case-of', object: 'argument' }],
    drill: 'syllogism'
  },
  {
    word: 'valid argument',
    definition: 'an argument whose conclusion must be true whenever all its premises are true',
    example: 'The syllogism about Tom is a valid argument.',
    strand: 'logic',
    dependsOn: ['argument', 'truth value'],
    relations: [{ predicate: 'special-case-of', object: 'argument' }]
  },
  {
    word: 'sound argument',
    definition: 'a valid argument whose premises are all actually true',
    example: 'A valid argument from false premises is not a sound argument.',
    strand: 'logic',
    dependsOn: ['valid argument', 'true statement'],
    relations: [{ predicate: 'special-case-of', object: 'valid argument' }]
  },
  {
    word: 'deduction',
    definition: 'reasoning from general statements to a conclusion that must follow',
    example: 'Concluding that Tom is an animal from all cats are animals is deduction.',
    strand: 'logic',
    dependsOn: ['valid argument', 'syllogism']
  },
  {
    word: 'induction',
    definition: 'reasoning from observed cases to a general statement that they suggest',
    example: 'Concluding that all swans are white from seeing many white swans is induction.',
    strand: 'logic',
    dependsOn: ['deduction', 'evidence'],
    relations: [{ predicate: 'requires', object: 'evidence' }]
  }
];
