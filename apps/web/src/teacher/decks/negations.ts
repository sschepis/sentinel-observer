/**
 * NEGATION DECK — true negative facts taught as declarative statements.
 *
 * The confirmed-false store (P8) is the only source of an evidence-backed
 * "No": absence of an edge is honest ignorance, never a denial. These
 * statements seed that store with the classic category corrections a school
 * curriculum drills ("a whale is not a fish") plus absent-part and
 * wrong-material facts. Every statement is phrased EXACTLY in a form
 * parseNegationStatement accepts, and — because the LEAD_IS_NOT_A subject
 * group would swallow a leading article ("a whale is not a fish" parses the
 * subject as "a whale") — every subject is written as the bare word, so the
 * parsed subject equals the deck word the negation is about. Objects may
 * carry an article only in the does-not-have form, whose regex strips it.
 * Everything asserted false here is uncontroversially false at the
 * school-fact level; ambiguous cases (tomato/vegetable, peanut/nut) are
 * deliberately left out.
 */

export interface NegationEntry {
  statement: string;
  subject: string;
  predicate: 'is-a' | 'has-part' | 'made-of';
  object: string;
}

export const NEGATION_DECK: readonly NegationEntry[] = [
  // ── Category corrections (is-a) ─────────────────────────────────────
  { statement: 'whale is not a fish', subject: 'whale', predicate: 'is-a', object: 'fish' },
  { statement: 'whale is not a shark', subject: 'whale', predicate: 'is-a', object: 'shark' },
  { statement: 'dolphin is not a fish', subject: 'dolphin', predicate: 'is-a', object: 'fish' },
  { statement: 'spider is not an insect', subject: 'spider', predicate: 'is-a', object: 'insect' },
  { statement: 'spider is not a bird', subject: 'spider', predicate: 'is-a', object: 'bird' },
  { statement: 'bat is not a bird', subject: 'bat', predicate: 'is-a', object: 'bird' },
  { statement: 'bat is not an insect', subject: 'bat', predicate: 'is-a', object: 'insect' },
  { statement: 'penguin is not a fish', subject: 'penguin', predicate: 'is-a', object: 'fish' },
  { statement: 'butterfly is not a bird', subject: 'butterfly', predicate: 'is-a', object: 'bird' },
  { statement: 'bee is not a bird', subject: 'bee', predicate: 'is-a', object: 'bird' },
  { statement: 'snake is not an insect', subject: 'snake', predicate: 'is-a', object: 'insect' },
  { statement: 'worm is not an insect', subject: 'worm', predicate: 'is-a', object: 'insect' },
  { statement: 'lizard is not an insect', subject: 'lizard', predicate: 'is-a', object: 'insect' },
  { statement: 'turtle is not a fish', subject: 'turtle', predicate: 'is-a', object: 'fish' },
  { statement: 'frog is not a fish', subject: 'frog', predicate: 'is-a', object: 'fish' },
  { statement: 'frog is not a lizard', subject: 'frog', predicate: 'is-a', object: 'lizard' },
  { statement: 'crab is not a fish', subject: 'crab', predicate: 'is-a', object: 'fish' },
  { statement: 'seal is not a fish', subject: 'seal', predicate: 'is-a', object: 'fish' },
  { statement: 'shark is not a whale', subject: 'shark', predicate: 'is-a', object: 'whale' },
  { statement: 'wolf is not a dog', subject: 'wolf', predicate: 'is-a', object: 'dog' },
  { statement: 'mushroom is not a plant', subject: 'mushroom', predicate: 'is-a', object: 'plant' },
  { statement: 'banana is not a vegetable', subject: 'banana', predicate: 'is-a', object: 'vegetable' },
  { statement: 'apple is not a vegetable', subject: 'apple', predicate: 'is-a', object: 'vegetable' },
  { statement: 'strawberry is not a vegetable', subject: 'strawberry', predicate: 'is-a', object: 'vegetable' },
  { statement: 'carrot is not a fruit', subject: 'carrot', predicate: 'is-a', object: 'fruit' },
  { statement: 'potato is not a fruit', subject: 'potato', predicate: 'is-a', object: 'fruit' },
  { statement: 'onion is not a fruit', subject: 'onion', predicate: 'is-a', object: 'fruit' },
  { statement: 'sun is not a planet', subject: 'sun', predicate: 'is-a', object: 'planet' },
  { statement: 'moon is not a planet', subject: 'moon', predicate: 'is-a', object: 'planet' },
  { statement: 'moon is not a star', subject: 'moon', predicate: 'is-a', object: 'star' },
  { statement: 'earth is not a star', subject: 'earth', predicate: 'is-a', object: 'star' },
  { statement: 'star is not a planet', subject: 'star', predicate: 'is-a', object: 'planet' },

  // ── Absent parts (does not have) ────────────────────────────────────
  { statement: 'snake does not have legs', subject: 'snake', predicate: 'has-part', object: 'legs' },
  { statement: 'snake does not have wings', subject: 'snake', predicate: 'has-part', object: 'wings' },
  { statement: 'fish does not have lungs', subject: 'fish', predicate: 'has-part', object: 'lungs' },
  { statement: 'fish does not have hair', subject: 'fish', predicate: 'has-part', object: 'hair' },
  { statement: 'fish does not have fur', subject: 'fish', predicate: 'has-part', object: 'fur' },
  { statement: 'bird does not have teeth', subject: 'bird', predicate: 'has-part', object: 'teeth' },
  { statement: 'bird does not have fur', subject: 'bird', predicate: 'has-part', object: 'fur' },
  { statement: 'whale does not have scales', subject: 'whale', predicate: 'has-part', object: 'scales' },
  { statement: 'frog does not have scales', subject: 'frog', predicate: 'has-part', object: 'scales' },
  { statement: 'frog does not have hair', subject: 'frog', predicate: 'has-part', object: 'hair' },
  { statement: 'spider does not have wings', subject: 'spider', predicate: 'has-part', object: 'wings' },
  { statement: 'spider does not have bones', subject: 'spider', predicate: 'has-part', object: 'bones' },
  { statement: 'worm does not have legs', subject: 'worm', predicate: 'has-part', object: 'legs' },
  { statement: 'worm does not have bones', subject: 'worm', predicate: 'has-part', object: 'bones' },
  { statement: 'shark does not have bones', subject: 'shark', predicate: 'has-part', object: 'bones' },
  { statement: 'insect does not have bones', subject: 'insect', predicate: 'has-part', object: 'bones' },
  { statement: 'bee does not have bones', subject: 'bee', predicate: 'has-part', object: 'bones' },
  { statement: 'penguin does not have teeth', subject: 'penguin', predicate: 'has-part', object: 'teeth' },
  { statement: 'turtle does not have teeth', subject: 'turtle', predicate: 'has-part', object: 'teeth' },
  { statement: 'plant does not have a brain', subject: 'plant', predicate: 'has-part', object: 'brain' },
  { statement: 'moon does not have air', subject: 'moon', predicate: 'has-part', object: 'air' },

  // ── Wrong materials (is not made of) ────────────────────────────────
  { statement: 'glass is not made of plastic', subject: 'glass', predicate: 'made-of', object: 'plastic' },
  { statement: 'glass is not made of wood', subject: 'glass', predicate: 'made-of', object: 'wood' },
  { statement: 'paper is not made of plastic', subject: 'paper', predicate: 'made-of', object: 'plastic' },
  { statement: 'paper is not made of metal', subject: 'paper', predicate: 'made-of', object: 'metal' },
  { statement: 'diamond is not made of metal', subject: 'diamond', predicate: 'made-of', object: 'metal' },
  { statement: 'moon is not made of cheese', subject: 'moon', predicate: 'made-of', object: 'cheese' },
  { statement: 'cheese is not made of meat', subject: 'cheese', predicate: 'made-of', object: 'meat' },
  { statement: 'steel is not made of wood', subject: 'steel', predicate: 'made-of', object: 'wood' },
  { statement: 'ice is not made of glass', subject: 'ice', predicate: 'made-of', object: 'glass' }
];

/**
 * Feed every negation statement through the teacher's conversational entry
 * point and return how many were sent. chatAnswer (not respond) is the
 * negation-teaching path: parseNegationStatement runs inside chatAnswer,
 * which stores the confirmed-false claim AND memorizes the exchange —
 * respond alone is only memorized-recall lookup and would teach nothing.
 * `entries` narrows the deck (for example to the subjects a small session
 * actually knows); it defaults to the full deck.
 */
export function teachNegationDeck(
  teacher: { chatAnswer(text: string): unknown },
  entries: readonly NegationEntry[] = NEGATION_DECK
): number {
  let count = 0;
  for (const entry of entries) {
    teacher.chatAnswer(entry.statement);
    count += 1;
  }
  return count;
}
