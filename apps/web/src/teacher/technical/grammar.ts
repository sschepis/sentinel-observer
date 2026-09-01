import type { TechnicalConcept } from './types';

/**
 * GRAMMAR — the structure of English itself.
 *
 * Mostly self-rooted: parts of speech are the roots the rest hangs from,
 * and the logic strand's "statement" is defined on top of "sentence" here.
 * Two naming decisions avoid collisions with other strands: the part of
 * speech is "grammatical conjunction" because the logic strand owns bare
 * "conjunction", and the word part is "word prefix" because the measurement
 * strand owns bare "prefix" (the kilo/milli sense, with its own drill).
 *
 * The drilled concepts (plural, past tense, vowel) are checkable because
 * English inflection over a fixed word list is a fact, not an opinion.
 */
export const GRAMMAR_CONCEPTS: readonly TechnicalConcept[] = [
  // ── Letters and sounds ──────────────────────────────────────────────────
  {
    word: 'letter',
    definition: 'a written symbol that stands for a speech sound',
    example: 'The word cat is written with three letters.',
    strand: 'grammar',
    dependsOn: []
  },
  {
    word: 'vowel',
    definition: 'one of the letters a, e, i, o, and u, which stand for open speech sounds',
    example: 'The word apple contains the vowels a and e.',
    strand: 'grammar',
    dependsOn: ['letter'],
    relations: [{ predicate: 'special-case-of', object: 'letter' }],
    drill: 'vowel-count'
  },
  {
    word: 'consonant',
    definition: 'a letter that is not a vowel',
    example: 'The letters b, c and d are consonants.',
    strand: 'grammar',
    dependsOn: ['letter', 'vowel'],
    relations: [{ predicate: 'special-case-of', object: 'letter' }]
  },
  {
    word: 'syllable',
    definition: 'a part of a word spoken as one beat, built around a vowel sound',
    example: 'The word water has two syllables.',
    strand: 'grammar',
    dependsOn: ['vowel'],
    relations: [{ predicate: 'has-part', object: 'vowel' }]
  },

  // ── Parts of speech ─────────────────────────────────────────────────────
  {
    word: 'noun',
    definition: 'a word that names a person, place, thing, or idea',
    example: 'In the sentence the dog barked, the noun is dog.',
    strand: 'grammar',
    dependsOn: []
  },
  {
    word: 'verb',
    definition: 'a word that names an action or a state of being',
    example: 'In the sentence the dog barked, the verb is barked.',
    strand: 'grammar',
    dependsOn: []
  },
  {
    word: 'adjective',
    definition: 'a word that describes a noun',
    example: 'In the phrase the red ball, the adjective is red.',
    strand: 'grammar',
    dependsOn: ['noun'],
    relations: [{ predicate: 'used-for', object: 'noun' }]
  },
  {
    word: 'adverb',
    definition: 'a word that describes a verb, an adjective, or another adverb',
    example: 'In the sentence she ran quickly, the adverb is quickly.',
    strand: 'grammar',
    dependsOn: ['verb', 'adjective'],
    relations: [{ predicate: 'used-for', object: 'verb' }]
  },
  {
    word: 'pronoun',
    definition: 'a word that stands in place of a noun',
    example: 'In the sentence she smiled, the pronoun she stands for a name.',
    strand: 'grammar',
    dependsOn: ['noun'],
    relations: [{ predicate: 'symbol-for', object: 'noun' }]
  },
  {
    word: 'preposition',
    definition: 'a word that shows how a noun relates to another word, such as in, on, or under',
    example: 'In the phrase the cat under the table, the preposition is under.',
    strand: 'grammar',
    dependsOn: ['noun'],
    relations: [{ predicate: 'used-for', object: 'noun' }]
  },
  {
    word: 'article',
    definition: 'one of the words a, an, and the, used before a noun',
    example: 'In the phrase an apple, the article is an.',
    strand: 'grammar',
    dependsOn: ['noun'],
    relations: [{ predicate: 'used-for', object: 'noun' }]
  },

  // ── Sentence structure ──────────────────────────────────────────────────
  {
    word: 'sentence',
    definition: 'a group of words that expresses a complete thought',
    example: 'The dog barked at the mail carrier is a sentence.',
    strand: 'grammar',
    dependsOn: []
  },
  {
    word: 'subject',
    definition: 'the part of a sentence that names who or what the sentence is about',
    example: 'In the dog barked, the subject is the dog.',
    strand: 'grammar',
    dependsOn: ['sentence', 'noun'],
    relations: [{ predicate: 'has-part', object: 'noun' }]
  },
  {
    word: 'predicate',
    definition: 'the part of a sentence that tells what the subject does or is',
    example: 'In the dog barked loudly, the predicate is barked loudly.',
    strand: 'grammar',
    dependsOn: ['sentence', 'verb', 'subject'],
    relations: [{ predicate: 'has-part', object: 'verb' }]
  },
  {
    word: 'object word',
    definition: 'the noun that receives the action of the verb in a sentence',
    example: 'In the dog chased the ball, the object word is the ball.',
    strand: 'grammar',
    dependsOn: ['predicate', 'noun'],
    relations: [{ predicate: 'is-a', object: 'noun' }]
  },
  {
    word: 'phrase',
    definition: 'a group of words that works as one unit but is not a complete sentence',
    example: 'Under the old bridge is a phrase, not a sentence.',
    strand: 'grammar',
    dependsOn: ['sentence']
  },
  {
    word: 'clause',
    definition: 'a group of words containing a subject and a predicate',
    example: 'When the rain stopped is a clause inside a longer sentence.',
    strand: 'grammar',
    dependsOn: ['subject', 'predicate'],
    relations: [
      { predicate: 'has-part', object: 'subject' },
      { predicate: 'has-part', object: 'predicate' }
    ]
  },
  {
    word: 'grammatical conjunction',
    definition: 'a word that joins words, phrases, or clauses, such as and, but, or or',
    example: 'In bread and butter, the grammatical conjunction is and.',
    strand: 'grammar',
    dependsOn: ['phrase', 'clause'],
    relations: [{ predicate: 'used-for', object: 'clause' }]
  },

  // ── Number and tense ────────────────────────────────────────────────────
  {
    word: 'singular',
    definition: 'the form of a noun that names exactly one thing',
    example: 'The word mouse is the singular of mice.',
    strand: 'grammar',
    dependsOn: ['noun'],
    relations: [{ predicate: 'has-property', object: 'noun' }]
  },
  {
    word: 'plural',
    definition: 'the form of a noun that names more than one thing',
    example: 'The plural of child is children.',
    strand: 'grammar',
    dependsOn: ['singular'],
    relations: [{ predicate: 'has-property', object: 'noun' }],
    drill: 'pluralize'
  },
  {
    word: 'tense',
    definition: 'the form of a verb that shows when its action happens',
    example: 'The verbs walk and walked differ only in tense.',
    strand: 'grammar',
    dependsOn: ['verb'],
    relations: [{ predicate: 'has-property', object: 'verb' }]
  },
  {
    word: 'past tense',
    definition: 'the verb form for an action that already happened',
    example: 'The past tense of go is went.',
    strand: 'grammar',
    dependsOn: ['tense'],
    relations: [{ predicate: 'special-case-of', object: 'tense' }],
    drill: 'past-tense'
  },
  {
    word: 'present tense',
    definition: 'the verb form for an action happening now or regularly',
    example: 'The sentence she walks to school uses the present tense.',
    strand: 'grammar',
    dependsOn: ['tense'],
    relations: [{ predicate: 'special-case-of', object: 'tense' }]
  },
  {
    word: 'future tense',
    definition: 'the verb form for an action that has not happened yet',
    example: 'The sentence she will walk to school uses the future tense.',
    strand: 'grammar',
    dependsOn: ['tense'],
    relations: [{ predicate: 'special-case-of', object: 'tense' }]
  },

  // ── Writing conventions ─────────────────────────────────────────────────
  {
    word: 'punctuation',
    definition: 'the marks used in writing to separate sentences and clarify meaning',
    example: 'Without punctuation the two sentences run together.',
    strand: 'grammar',
    dependsOn: ['sentence']
  },
  {
    word: 'period',
    definition: 'the punctuation mark that ends an ordinary sentence',
    example: 'Every sentence in the report ends with a period.',
    strand: 'grammar',
    dependsOn: ['punctuation', 'sentence'],
    relations: [{ predicate: 'is-a', object: 'punctuation' }]
  },
  {
    word: 'question mark',
    definition: 'the punctuation mark that ends a question',
    example: 'The sentence what time is it ends with a question mark.',
    strand: 'grammar',
    dependsOn: ['punctuation'],
    relations: [{ predicate: 'is-a', object: 'punctuation' }]
  },
  {
    word: 'comma',
    definition: 'the punctuation mark that separates parts inside a sentence',
    example: 'A comma separates the items in red, green, and blue.',
    strand: 'grammar',
    dependsOn: ['punctuation'],
    relations: [{ predicate: 'is-a', object: 'punctuation' }]
  },
  {
    word: 'capital letter',
    definition: 'the large form of a letter used to begin a sentence or a name',
    example: 'The first word of every sentence starts with a capital letter.',
    strand: 'grammar',
    dependsOn: ['letter', 'sentence'],
    relations: [{ predicate: 'special-case-of', object: 'letter' }]
  },

  // ── Word building ───────────────────────────────────────────────────────
  {
    word: 'root word',
    definition: 'the basic part of a word that carries its main meaning',
    example: 'The root word of unhappiness is happy.',
    strand: 'grammar',
    dependsOn: ['syllable']
  },
  {
    word: 'word prefix',
    definition: 'a word part added before a root word to change its meaning',
    example: 'The word prefix un turns happy into unhappy.',
    strand: 'grammar',
    dependsOn: ['root word'],
    relations: [{ predicate: 'used-for', object: 'root word' }]
  },
  {
    word: 'suffix',
    definition: 'a word part added after a root word to change its meaning or use',
    example: 'The suffix ness turns happy into happiness.',
    strand: 'grammar',
    dependsOn: ['root word'],
    relations: [{ predicate: 'used-for', object: 'root word' }]
  }
];
