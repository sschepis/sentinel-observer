/**
 * DETERMINISTIC VERIFICATION — grading without a model in the loop.
 *
 * Everywhere else in this app an answer is judged by `semanticGrader`, an
 * LLM. That is the right tool for "what do you enjoy?" and the wrong tool
 * for "what is 7 + 5?", where correctness is a fact. These drills generate
 * an unlimited supply of exercises with known answers and mark them
 * exactly: no API call, no cost, and no possibility of a fabricated grade.
 *
 * Exercises are generated from a seed, so a train/test split is reproducible
 * and a held-out set really is held out. That is what makes the important
 * claim falsifiable: an observer that MEMORIZED the training instances
 * scores at chance on unseen ones, while an observer that INDUCED the rule
 * does not.
 */

export type AnswerKind = 'number' | 'text';

export interface Exercise {
  /** The concept this drills. */
  concept: string;
  drill: string;
  prompt: string;
  /** The canonical correct answer. */
  answer: string;
  kind: AnswerKind;
}

export interface Verdict {
  correct: boolean;
  expected: string;
  /** What the observer's response was read as (null when it stated nothing). */
  got: string | null;
}

/** Deterministic PRNG — a seeded run must reproduce exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rng: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

const pick = <T,>(rng: () => number, list: readonly T[]): T => list[Math.floor(rng() * list.length)];

function gcd(a: number, b: number): number {
  let [x, y] = [Math.abs(a), Math.abs(b)];
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let d = 2; d * d <= n; d += 1) if (n % d === 0) return false;
  return true;
}

/** Trim floating noise without inventing precision. */
function num(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

type Generator = (rng: () => number, concept: string) => Exercise;

const numeric = (concept: string, drill: string, prompt: string, answer: number): Exercise => ({
  concept,
  drill,
  prompt,
  answer: num(answer),
  kind: 'number'
});

const textual = (concept: string, drill: string, prompt: string, answer: string): Exercise => ({
  concept,
  drill,
  prompt,
  answer,
  kind: 'text'
});

const METRIC_LENGTH: ReadonlyArray<[string, number]> = [
  ['millimeters', 0.001],
  ['centimeters', 0.01],
  ['meters', 1],
  ['kilometers', 1000]
];

/**
 * Small everyday facts with a KNOWN truth value — the raw material for the
 * truth-functional logic drills. Each is decidable by arithmetic the earlier
 * strands already teach, so the truth value is a fact and not trivia.
 *
 * SIZE CONTRACT: every fixed table below must keep its drill's distinct-
 * prompt space at or above 44 — `runDrill` requests (TRAIN_SIZE + TEST_SIZE)
 * * 2 = 44 distinct exercises, and a smaller space silently degrades the
 * train/held-out split (measured: at 12 facts, logic-not trained on only 4
 * exercises). logic-not asks each fact under two phrasings, so 24 facts
 * give it 48 prompts; logic-and/or draw fact PAIRS and are far above the
 * floor.
 */
const LOGIC_FACTS: ReadonlyArray<[string, boolean]> = [
  ['two plus two is four', true],
  ['three plus three is seven', false],
  ['ten is greater than five', true],
  ['one plus one is three', false],
  ['five minus two is three', true],
  ['four times two is nine', false],
  ['six divided by two is three', true],
  ['nine is less than three', false],
  ['seven plus one is eight', true],
  ['eight minus five is two', false],
  ['three times three is nine', true],
  ['ten minus four is five', false],
  ['ten plus ten is twenty', true],
  ['six plus five is twelve', false],
  ['twelve is greater than nine', true],
  ['two is greater than eight', false],
  ['eight divided by four is two', true],
  ['nine minus three is five', false],
  ['five times two is ten', true],
  ['seven times two is fifteen', false],
  ['four plus four is eight', true],
  ['ten divided by five is three', false],
  ['six is less than seven', true],
  ['ten minus seven is four', false]
];

/**
 * If-then scenarios for the conditional drill. Each carries both the modus
 * ponens reading (affirm the if part, answer yes) and the modus tollens
 * reading (deny the then part, answer no) — the two forms whose answers are
 * actually determinable. Affirming the consequent is NOT here, because its
 * honest answer is "cannot tell", which the marker has no word for.
 */
const CONDITIONAL_SCENARIOS: ReadonlyArray<{
  condition: string;
  consequence: string;
  affirm: string;
  askConsequence: string;
  denyConsequence: string;
  askCondition: string;
}> = [
  { condition: 'it rains', consequence: 'the ground gets wet', affirm: 'It rains.', askConsequence: 'Does the ground get wet?', denyConsequence: 'The ground does not get wet.', askCondition: 'Did it rain?' },
  { condition: 'the bell rings', consequence: 'class ends', affirm: 'The bell rings.', askConsequence: 'Does class end?', denyConsequence: 'Class does not end.', askCondition: 'Did the bell ring?' },
  { condition: 'the sun sets', consequence: 'the sky gets dark', affirm: 'The sun sets.', askConsequence: 'Does the sky get dark?', denyConsequence: 'The sky does not get dark.', askCondition: 'Did the sun set?' },
  { condition: 'the switch is on', consequence: 'the lamp shines', affirm: 'The switch is on.', askConsequence: 'Does the lamp shine?', denyConsequence: 'The lamp does not shine.', askCondition: 'Is the switch on?' },
  { condition: 'it snows', consequence: 'the roof turns white', affirm: 'It snows.', askConsequence: 'Does the roof turn white?', denyConsequence: 'The roof does not turn white.', askCondition: 'Did it snow?' },
  { condition: 'the kettle boils', consequence: 'steam rises', affirm: 'The kettle boils.', askConsequence: 'Does steam rise?', denyConsequence: 'Steam does not rise.', askCondition: 'Did the kettle boil?' },
  { condition: 'the wind blows', consequence: 'the flag moves', affirm: 'The wind blows.', askConsequence: 'Does the flag move?', denyConsequence: 'The flag does not move.', askCondition: 'Did the wind blow?' },
  { condition: 'the alarm sounds', consequence: 'everyone leaves the building', affirm: 'The alarm sounds.', askConsequence: 'Does everyone leave the building?', denyConsequence: 'Not everyone leaves the building.', askCondition: 'Did the alarm sound?' },
  { condition: 'water freezes', consequence: 'it turns to ice', affirm: 'The water freezes.', askConsequence: 'Does it turn to ice?', denyConsequence: 'It does not turn to ice.', askCondition: 'Did the water freeze?' },
  { condition: 'the light turns green', consequence: 'the cars move', affirm: 'The light turns green.', askConsequence: 'Do the cars move?', denyConsequence: 'The cars do not move.', askCondition: 'Did the light turn green?' },
  { condition: 'the phone rings', consequence: 'she answers it', affirm: 'The phone rings.', askConsequence: 'Does she answer it?', denyConsequence: 'She does not answer it.', askCondition: 'Did the phone ring?' },
  { condition: 'the seed is planted', consequence: 'a sprout grows', affirm: 'The seed is planted.', askConsequence: 'Does a sprout grow?', denyConsequence: 'No sprout grows.', askCondition: 'Was the seed planted?' },
  { condition: 'the oven is hot', consequence: 'the bread bakes', affirm: 'The oven is hot.', askConsequence: 'Does the bread bake?', denyConsequence: 'The bread does not bake.', askCondition: 'Is the oven hot?' },
  { condition: 'the tide rises', consequence: 'the sand disappears', affirm: 'The tide rises.', askConsequence: 'Does the sand disappear?', denyConsequence: 'The sand does not disappear.', askCondition: 'Did the tide rise?' },
  { condition: 'the music plays', consequence: 'the children dance', affirm: 'The music plays.', askConsequence: 'Do the children dance?', denyConsequence: 'The children do not dance.', askCondition: 'Did the music play?' },
  { condition: 'the gate is open', consequence: 'the sheep wander out', affirm: 'The gate is open.', askConsequence: 'Do the sheep wander out?', denyConsequence: 'The sheep do not wander out.', askCondition: 'Is the gate open?' },
  { condition: 'the battery dies', consequence: 'the toy stops', affirm: 'The battery dies.', askConsequence: 'Does the toy stop?', denyConsequence: 'The toy does not stop.', askCondition: 'Did the battery die?' },
  { condition: 'the rope is cut', consequence: 'the swing falls', affirm: 'The rope is cut.', askConsequence: 'Does the swing fall?', denyConsequence: 'The swing does not fall.', askCondition: 'Was the rope cut?' },
  { condition: 'the milk spills', consequence: 'the floor gets wet', affirm: 'The milk spills.', askConsequence: 'Does the floor get wet?', denyConsequence: 'The floor does not get wet.', askCondition: 'Did the milk spill?' },
  { condition: 'the candle burns', consequence: 'the wax melts', affirm: 'The candle burns.', askConsequence: 'Does the wax melt?', denyConsequence: 'The wax does not melt.', askCondition: 'Did the candle burn?' },
  { condition: 'the train arrives', consequence: 'the doors open', affirm: 'The train arrives.', askConsequence: 'Do the doors open?', denyConsequence: 'The doors do not open.', askCondition: 'Did the train arrive?' },
  { condition: 'the rain stops', consequence: 'the puddles dry', affirm: 'The rain stops.', askConsequence: 'Do the puddles dry?', denyConsequence: 'The puddles do not dry.', askCondition: 'Did the rain stop?' }
];

/**
 * Category triples for the syllogism drill. The valid form (Barbara) forces
 * a yes; the invalid affirming-the-consequent form asks "must", so its
 * determinable answer is no.
 */
const SYLLOGISM_TRIPLES: ReadonlyArray<{
  members: string;
  member: string;
  category: string;
  categoryMember: string;
  name: string;
}> = [
  { members: 'cats', member: 'a cat', category: 'animals', categoryMember: 'an animal', name: 'Tom' },
  { members: 'dogs', member: 'a dog', category: 'mammals', categoryMember: 'a mammal', name: 'Rex' },
  { members: 'sparrows', member: 'a sparrow', category: 'birds', categoryMember: 'a bird', name: 'Pip' },
  { members: 'whales', member: 'a whale', category: 'mammals', categoryMember: 'a mammal', name: 'Moby' },
  { members: 'lions', member: 'a lion', category: 'animals', categoryMember: 'an animal', name: 'Leo' },
  { members: 'ladybugs', member: 'a ladybug', category: 'insects', categoryMember: 'an insect', name: 'Dot' },
  { members: 'salmon', member: 'a salmon', category: 'fish', categoryMember: 'a fish', name: 'Finn' },
  { members: 'elephants', member: 'an elephant', category: 'mammals', categoryMember: 'a mammal', name: 'Ella' },
  { members: 'horses', member: 'a horse', category: 'mammals', categoryMember: 'a mammal', name: 'Duke' },
  { members: 'frogs', member: 'a frog', category: 'animals', categoryMember: 'an animal', name: 'Hop' },
  { members: 'eagles', member: 'an eagle', category: 'birds', categoryMember: 'a bird', name: 'Sky' },
  { members: 'bees', member: 'a bee', category: 'insects', categoryMember: 'an insect', name: 'Buzz' },
  { members: 'sharks', member: 'a shark', category: 'fish', categoryMember: 'a fish', name: 'Snap' },
  { members: 'rabbits', member: 'a rabbit', category: 'mammals', categoryMember: 'a mammal', name: 'Thumper' },
  { members: 'penguins', member: 'a penguin', category: 'birds', categoryMember: 'a bird', name: 'Waddle' },
  { members: 'ants', member: 'an ant', category: 'insects', categoryMember: 'an insect', name: 'Andy' },
  { members: 'snakes', member: 'a snake', category: 'reptiles', categoryMember: 'a reptile', name: 'Slink' },
  { members: 'turtles', member: 'a turtle', category: 'reptiles', categoryMember: 'a reptile', name: 'Shelly' },
  { members: 'goats', member: 'a goat', category: 'mammals', categoryMember: 'a mammal', name: 'Billy' },
  { members: 'crows', member: 'a crow', category: 'birds', categoryMember: 'a bird', name: 'Coal' },
  { members: 'trout', member: 'a trout', category: 'fish', categoryMember: 'a fish', name: 'Speck' },
  { members: 'beetles', member: 'a beetle', category: 'insects', categoryMember: 'an insect', name: 'Bo' }
];

/** Regular plurals plus the irregular table English refuses to regularize.
 *  (≥ 44 entries — see the size contract on LOGIC_FACTS.) */
const PLURAL_TABLE: ReadonlyArray<[string, string]> = [
  ['child', 'children'],
  ['mouse', 'mice'],
  ['foot', 'feet'],
  ['tooth', 'teeth'],
  ['man', 'men'],
  ['woman', 'women'],
  ['person', 'people'],
  ['leaf', 'leaves'],
  ['box', 'boxes'],
  ['city', 'cities'],
  ['dog', 'dogs'],
  ['cat', 'cats'],
  ['book', 'books'],
  ['tree', 'trees'],
  ['bench', 'benches'],
  ['brush', 'brushes'],
  ['story', 'stories'],
  ['car', 'cars'],
  ['goose', 'geese'],
  ['ox', 'oxen'],
  ['sheep', 'sheep'],
  ['deer', 'deer'],
  ['wolf', 'wolves'],
  ['knife', 'knives'],
  ['wife', 'wives'],
  ['life', 'lives'],
  ['shelf', 'shelves'],
  ['half', 'halves'],
  ['loaf', 'loaves'],
  ['thief', 'thieves'],
  ['baby', 'babies'],
  ['lady', 'ladies'],
  ['party', 'parties'],
  ['penny', 'pennies'],
  ['army', 'armies'],
  ['fox', 'foxes'],
  ['bus', 'buses'],
  ['glass', 'glasses'],
  ['dish', 'dishes'],
  ['watch', 'watches'],
  ['church', 'churches'],
  ['potato', 'potatoes'],
  ['tomato', 'tomatoes'],
  ['hero', 'heroes'],
  ['piano', 'pianos'],
  ['photo', 'photos']
];

/** Regular past tenses plus the common irregular verbs.
 *  (≥ 44 entries — see the size contract on LOGIC_FACTS.) */
const PAST_TENSE_TABLE: ReadonlyArray<[string, string]> = [
  ['walk', 'walked'],
  ['play', 'played'],
  ['jump', 'jumped'],
  ['talk', 'talked'],
  ['climb', 'climbed'],
  ['cook', 'cooked'],
  ['paint', 'painted'],
  ['wash', 'washed'],
  ['go', 'went'],
  ['eat', 'ate'],
  ['see', 'saw'],
  ['run', 'ran'],
  ['take', 'took'],
  ['give', 'gave'],
  ['come', 'came'],
  ['make', 'made'],
  ['help', 'helped'],
  ['open', 'opened'],
  ['close', 'closed'],
  ['laugh', 'laughed'],
  ['learn', 'learned'],
  ['listen', 'listened'],
  ['look', 'looked'],
  ['move', 'moved'],
  ['plant', 'planted'],
  ['rain', 'rained'],
  ['shout', 'shouted'],
  ['smile', 'smiled'],
  ['stay', 'stayed'],
  ['turn', 'turned'],
  ['say', 'said'],
  ['tell', 'told'],
  ['find', 'found'],
  ['think', 'thought'],
  ['bring', 'brought'],
  ['buy', 'bought'],
  ['catch', 'caught'],
  ['teach', 'taught'],
  ['write', 'wrote'],
  ['ride', 'rode'],
  ['sing', 'sang'],
  ['drink', 'drank'],
  ['swim', 'swam'],
  ['fly', 'flew']
];

/** Words for the vowel-count drill; the count is computed, never hand-typed.
 *  (≥ 44 entries — see the size contract on LOGIC_FACTS.) */
const VOWEL_WORDS: readonly string[] = [
  'apple',
  'banana',
  'orange',
  'pencil',
  'window',
  'garden',
  'mountain',
  'river',
  'yellow',
  'purple',
  'elephant',
  'umbrella',
  'book',
  'tree',
  'cloud',
  'stone',
  'table',
  'chair',
  'house',
  'water',
  'paper',
  'music',
  'animal',
  'island',
  'summer',
  'winter',
  'morning',
  'evening',
  'family',
  'letter',
  'number',
  'circle',
  'flower',
  'candle',
  'basket',
  'bridge',
  'castle',
  'dragon',
  'forest',
  'guitar',
  'hammer',
  'jacket',
  'kitten',
  'ladder',
  'magnet',
  'rocket'
];

const ADD_STORY_TEMPLATES: ReadonlyArray<(a: number, b: number) => string> = [
  (a, b) => `Sam has ${a} apples and gets ${b} more. How many apples does Sam have?`,
  (a, b) => `Mia read ${a} pages yesterday and ${b} pages today. How many pages did she read in all?`,
  (a, b) => `A jar holds ${a} red marbles and ${b} blue marbles. How many marbles are in the jar?`,
  (a, b) => `Leo scored ${a} points in the first game and ${b} points in the second. How many points did he score in total?`
];

const MUL_STORY_TEMPLATES: ReadonlyArray<(a: number, b: number) => string> = [
  (a, b) => `There are ${a} boxes with ${b} pencils in each box. How many pencils are there in all?`,
  (a, b) => `Each of ${a} shelves holds ${b} books. How many books are there?`,
  (a, b) => `A pack has ${b} stickers and Ana buys ${a} packs. How many stickers does she buy?`,
  (a, b) => `There are ${a} tables and each table seats ${b} people. How many people can sit down?`
];

export const GENERATORS: Record<string, Generator> = {
  // ── Core arithmetic ─────────────────────────────────────────────────────
  addition: (rng, c) => {
    const a = between(rng, 2, 99);
    const b = between(rng, 2, 99);
    return numeric(c, 'addition', `What is ${a} + ${b}?`, a + b);
  },
  subtraction: (rng, c) => {
    const a = between(rng, 10, 99);
    const b = between(rng, 1, a - 1);
    return numeric(c, 'subtraction', `What is ${a} - ${b}?`, a - b);
  },
  multiplication: (rng, c) => {
    const a = between(rng, 2, 12);
    const b = between(rng, 2, 12);
    return numeric(c, 'multiplication', `What is ${a} * ${b}?`, a * b);
  },
  division: (rng, c) => {
    const b = between(rng, 2, 12);
    const q = between(rng, 2, 12);
    return numeric(c, 'division', `What is ${b * q} / ${b}?`, q);
  },
  remainder: (rng, c) => {
    const b = between(rng, 2, 9);
    const a = between(rng, b + 1, 60);
    return numeric(c, 'remainder', `What is the remainder when ${a} is divided by ${b}?`, a % b);
  },
  'order-of-operations': (rng, c) => {
    const a = between(rng, 2, 9);
    const b = between(rng, 2, 9);
    const d = between(rng, 2, 9);
    return numeric(c, 'order-of-operations', `What is ${a} + ${b} * ${d}?`, a + b * d);
  },
  comparison: (rng, c) => {
    const a = between(rng, 1, 99);
    let b = between(rng, 1, 99);
    if (b === a) b = a + 1;
    return numeric(c, 'comparison', `Which is greater, ${a} or ${b}?`, Math.max(a, b));
  },

  // ── Properties ──────────────────────────────────────────────────────────
  commutative: (rng, c) => {
    const a = between(rng, 2, 12);
    const b = between(rng, 2, 12);
    return numeric(c, 'commutative', `If ${a} * ${b} = ${a * b}, what is ${b} * ${a}?`, a * b);
  },
  distributive: (rng, c) => {
    const a = between(rng, 2, 9);
    const b = between(rng, 2, 9);
    const d = between(rng, 2, 9);
    return numeric(c, 'distributive', `What is ${a} * (${b} + ${d})?`, a * (b + d));
  },

  // ── Number properties ───────────────────────────────────────────────────
  'absolute-value': (rng, c) => {
    const a = between(rng, 1, 99) * (rng() < 0.5 ? -1 : 1);
    return numeric(c, 'absolute-value', `What is the absolute value of ${a}?`, Math.abs(a));
  },
  parity: (rng, c) => {
    const a = between(rng, 1, 99);
    return textual(c, 'parity', `Is ${a} even or odd?`, a % 2 === 0 ? 'even' : 'odd');
  },
  prime: (rng, c) => {
    const a = between(rng, 2, 60);
    return textual(c, 'prime', `Is ${a} a prime number?`, isPrime(a) ? 'yes' : 'no');
  },
  factor: (rng, c) => {
    const a = between(rng, 2, 12);
    const b = between(rng, 10, 60);
    return textual(c, 'factor', `Is ${a} a factor of ${b}?`, b % a === 0 ? 'yes' : 'no');
  },
  gcf: (rng, c) => {
    const a = between(rng, 4, 60);
    const b = between(rng, 4, 60);
    return numeric(c, 'gcf', `What is the greatest common factor of ${a} and ${b}?`, gcd(a, b));
  },
  lcm: (rng, c) => {
    const a = between(rng, 2, 20);
    const b = between(rng, 2, 20);
    return numeric(c, 'lcm', `What is the least common multiple of ${a} and ${b}?`, (a * b) / gcd(a, b));
  },
  'place-value': (rng, c) => {
    const digits = [between(rng, 1, 9), between(rng, 0, 9), between(rng, 0, 9)];
    const position = between(rng, 0, 2);
    const value = Number(digits.join(''));
    const weight = [100, 10, 1][position];
    return numeric(
      c,
      'place-value',
      `In ${value}, what is the place value of the digit ${digits[position]}?`,
      digits[position] * weight
    );
  },

  // ── Fractions, percent, powers ──────────────────────────────────────────
  'simplify-fraction': (rng, c) => {
    const d = between(rng, 2, 9);
    const n = between(rng, 1, d - 1);
    const k = between(rng, 2, 6);
    const g = gcd(n, d);
    return textual(
      c,
      'simplify-fraction',
      `Write ${n * k}/${d * k} in simplest form.`,
      `${n / g}/${d / g}`
    );
  },
  percent: (rng, c) => {
    const p = pick(rng, [10, 20, 25, 50, 75]);
    const base = between(rng, 1, 20) * 20;
    return numeric(c, 'percent', `What is ${p} percent of ${base}?`, (base * p) / 100);
  },
  exponent: (rng, c) => {
    const base = between(rng, 2, 6);
    const power = between(rng, 2, 4);
    return numeric(c, 'exponent', `What is ${base}^${power}?`, base ** power);
  },
  square: (rng, c) => {
    const a = between(rng, 2, 20);
    return numeric(c, 'square', `What is the square of ${a}?`, a * a);
  },
  'square-root': (rng, c) => {
    const a = between(rng, 2, 20);
    return numeric(c, 'square-root', `What is the square root of ${a * a}?`, a);
  },
  'scientific-notation': (rng, c) => {
    const mantissa = between(rng, 10, 99) / 10;
    const power = between(rng, 2, 5);
    return textual(
      c,
      'scientific-notation',
      `Write ${num(mantissa * 10 ** power)} in scientific notation.`,
      `${num(mantissa)} * 10^${power}`
    );
  },
  rounding: (rng, c) => {
    const a = between(rng, 11, 989);
    const to = pick(rng, [10, 100]);
    return numeric(c, 'rounding', `Round ${a} to the nearest ${to}.`, Math.round(a / to) * to);
  },

  // ── Units and measurement ───────────────────────────────────────────────
  'prefix-value': (rng, c) => {
    const [name, value] = pick(rng, [
      ['kilo', 1000],
      ['centi', 0.01],
      ['milli', 0.001],
      ['mega', 1000000],
      ['deci', 0.1]
    ] as ReadonlyArray<[string, number]>);
    return numeric(c, 'prefix-value', `The prefix ${name} multiplies a unit by what number?`, value);
  },
  'convert-length': (rng, c) => {
    let from = pick(rng, METRIC_LENGTH);
    let to = pick(rng, METRIC_LENGTH);
    if (from[0] === to[0]) to = METRIC_LENGTH[(METRIC_LENGTH.indexOf(from) + 1) % METRIC_LENGTH.length];
    const amount = between(rng, 1, 50);
    return numeric(
      c,
      'convert-length',
      `How many ${to[0]} are in ${amount} ${from[0]}?`,
      (amount * from[1]) / to[1]
    );
  },
  'convert-mass': (rng, c) => {
    const amount = between(rng, 1, 50);
    return rng() < 0.5
      ? numeric(c, 'convert-mass', `How many grams are in ${amount} kilograms?`, amount * 1000)
      : numeric(c, 'convert-mass', `How many milligrams are in ${amount} grams?`, amount * 1000);
  },
  'convert-volume': (rng, c) => {
    const amount = between(rng, 1, 50);
    return numeric(c, 'convert-volume', `How many milliliters are in ${amount} liters?`, amount * 1000);
  },
  'convert-time': (rng, c) => {
    const amount = between(rng, 1, 30);
    return rng() < 0.5
      ? numeric(c, 'convert-time', `How many seconds are in ${amount} minutes?`, amount * 60)
      : numeric(c, 'convert-time', `How many minutes are in ${amount} hours?`, amount * 60);
  },
  area: (rng, c) => {
    const w = between(rng, 2, 20);
    const h = between(rng, 2, 20);
    return numeric(c, 'area', `What is the area of a rectangle ${w} meters by ${h} meters?`, w * h);
  },
  volume: (rng, c) => {
    const a = between(rng, 2, 10);
    const b = between(rng, 2, 10);
    const d = between(rng, 2, 10);
    return numeric(c, 'volume', `What is the volume of a box ${a} by ${b} by ${d} meters?`, a * b * d);
  },
  density: (rng, c) => {
    const v = between(rng, 2, 10);
    const d = between(rng, 2, 10);
    return numeric(c, 'density', `What is the density of ${v * d} grams filling ${v} cubic centimeters?`, d);
  },
  speed: (rng, c) => {
    const t = between(rng, 2, 12);
    const s = between(rng, 2, 20);
    return numeric(c, 'speed', `What is the speed of something going ${s * t} meters in ${t} seconds?`, s);
  },
  force: (rng, c) => {
    const m = between(rng, 2, 20);
    const a = between(rng, 2, 10);
    return numeric(c, 'force', `What force accelerates ${m} kilograms at ${a} meters per second squared?`, m * a);
  },
  temperature: (rng, c) => {
    const celsius = between(rng, -20, 100);
    return numeric(c, 'temperature', `What is ${celsius} degrees celsius in kelvin?`, celsius + 273);
  },

  // ── Geometry ────────────────────────────────────────────────────────────
  'perimeter-rectangle': (rng, c) => {
    const w = between(rng, 2, 20);
    const h = between(rng, 2, 20);
    return numeric(
      c,
      'perimeter-rectangle',
      `What is the perimeter of a rectangle ${w} meters by ${h} meters?`,
      2 * (w + h)
    );
  },
  'triangle-angle-sum': (rng, c) => {
    const a = between(rng, 20, 80);
    const b = between(rng, 20, 80);
    return numeric(
      c,
      'triangle-angle-sum',
      `A triangle has angles of ${a} degrees and ${b} degrees. What is the third angle in degrees?`,
      180 - a - b
    );
  },
  'complementary-angle': (rng, c) => {
    const a = between(rng, 10, 80);
    return numeric(
      c,
      'complementary-angle',
      `Two angles are complementary. One is ${a} degrees. What is the other angle in degrees?`,
      90 - a
    );
  },
  'supplementary-angle': (rng, c) => {
    const a = between(rng, 20, 160);
    return numeric(
      c,
      'supplementary-angle',
      `Two angles are supplementary. One is ${a} degrees. What is the other angle in degrees?`,
      180 - a
    );
  },
  'circle-diameter': (rng, c) => {
    const r = between(rng, 2, 30);
    return rng() < 0.5
      ? numeric(c, 'circle-diameter', `A circle has a radius of ${r} meters. What is its diameter in meters?`, 2 * r)
      : numeric(c, 'circle-diameter', `A circle has a diameter of ${2 * r} meters. What is its radius in meters?`, r);
  },

  // ── Logic ───────────────────────────────────────────────────────────────
  'logic-and': (rng, c) => {
    const [a, ta] = pick(rng, LOGIC_FACTS);
    const [b, tb] = pick(rng, LOGIC_FACTS);
    return textual(
      c,
      'logic-and',
      `Statement A says ${a}. Statement B says ${b}. Is the statement 'A and B' true or false?`,
      ta && tb ? 'true' : 'false'
    );
  },
  'logic-or': (rng, c) => {
    const [a, ta] = pick(rng, LOGIC_FACTS);
    const [b, tb] = pick(rng, LOGIC_FACTS);
    return textual(
      c,
      'logic-or',
      `Statement A says ${a}. Statement B says ${b}. Is the statement 'A or B' true or false?`,
      ta || tb ? 'true' : 'false'
    );
  },
  'logic-if': (rng, c) => {
    const s = pick(rng, CONDITIONAL_SCENARIOS);
    return rng() < 0.5
      ? textual(c, 'logic-if', `If ${s.condition}, then ${s.consequence}. ${s.affirm} ${s.askConsequence}`, 'yes')
      : textual(c, 'logic-if', `If ${s.condition}, then ${s.consequence}. ${s.denyConsequence} ${s.askCondition}`, 'no');
  },
  syllogism: (rng, c) => {
    const t = pick(rng, SYLLOGISM_TRIPLES);
    // The invalid form affirms the consequent, so the forced answer is no:
    // being in the category does not make the individual a member.
    return rng() < 0.5
      ? textual(c, 'syllogism', `All ${t.members} are ${t.category}. ${t.name} is ${t.member}. Is ${t.name} ${t.categoryMember}?`, 'yes')
      : textual(c, 'syllogism', `All ${t.members} are ${t.category}. ${t.name} is ${t.categoryMember}. Must ${t.name} be ${t.member}?`, 'no');
  },
  'logic-not': (rng, c) => {
    const [fact, truth] = pick(rng, LOGIC_FACTS);
    // Two phrasings double the distinct-prompt space (24 facts -> 48
    // prompts), keeping the drill above the 44-exercise split floor.
    const phrasing = rng() < 0.5
      ? `Consider the statement: ${fact}. Is the negation of this statement true or false?`
      : `Take the statement: ${fact}. Is the opposite of this statement true or false?`;
    return textual(c, 'logic-not', phrasing, truth ? 'false' : 'true');
  },

  // ── Grammar ─────────────────────────────────────────────────────────────
  pluralize: (rng, c) => {
    const [singular, plural] = pick(rng, PLURAL_TABLE);
    return textual(c, 'pluralize', `What is the plural of ${singular}?`, plural);
  },
  'past-tense': (rng, c) => {
    const [present, past] = pick(rng, PAST_TENSE_TABLE);
    return textual(c, 'past-tense', `What is the past tense of ${present}?`, past);
  },
  'vowel-count': (rng, c) => {
    const word = pick(rng, VOWEL_WORDS);
    const count = (word.match(/[aeiou]/g) ?? []).length;
    return numeric(c, 'vowel-count', `How many vowels are in the word ${word}?`, count);
  },

  // ── Applied arithmetic and measurement ──────────────────────────────────
  'word-problem-add': (rng, c) => {
    const a = between(rng, 2, 40);
    const b = between(rng, 2, 40);
    return numeric(c, 'word-problem-add', pick(rng, ADD_STORY_TEMPLATES)(a, b), a + b);
  },
  'word-problem-mul': (rng, c) => {
    const a = between(rng, 2, 12);
    const b = between(rng, 2, 12);
    return numeric(c, 'word-problem-mul', pick(rng, MUL_STORY_TEMPLATES)(a, b), a * b);
  },
  'elapsed-time': (rng, c) => {
    const start = between(rng, 1, 12);
    const hours = between(rng, 1, 10);
    // Clock arithmetic: hours wrap mod 12, with 12 written instead of 0.
    const end = ((start + hours - 1) % 12) + 1;
    return numeric(
      c,
      'elapsed-time',
      `A movie starts at ${start} o'clock and lasts ${hours} hours. At what hour does it end?`,
      end
    );
  },
  'money-total': (rng, c) => {
    const quarters = between(rng, 1, 9);
    const dimes = between(rng, 1, 9);
    return numeric(
      c,
      'money-total',
      `How many cents are ${quarters} quarters and ${dimes} dimes worth?`,
      quarters * 25 + dimes * 10
    );
  },
  'solve-x-add': (rng, c) => {
    const a = between(rng, 1, 30);
    const x = between(rng, 1, 30);
    return numeric(c, 'solve-x-add', `If x + ${a} = ${a + x}, what is x?`, x);
  },
  'solve-x-mul': (rng, c) => {
    const a = between(rng, 2, 12);
    const k = between(rng, 2, 12);
    return numeric(c, 'solve-x-mul', `If ${a} * x = ${a * k}, what is x?`, k);
  },
  'sequence-next': (rng, c) => {
    const start = between(rng, 1, 20);
    const step = between(rng, 2, 9);
    const shown = [start, start + step, start + 2 * step, start + 3 * step];
    return numeric(
      c,
      'sequence-next',
      `What number comes next: ${shown.join(', ')}?`,
      start + 4 * step
    );
  }
};

/** Every drill the verifier can mark. */
export function knownDrills(): string[] {
  return Object.keys(GENERATORS);
}

/**
 * Number of distinct answers a drill's generator can produce — exact
 * enumeration over the generator's own parameter ranges. Drills whose answer
 * space is far below the 100-value guess assumed by the 0.01 baseline (gcf,
 * lcm, square-root, temperature, rounding) would otherwise have their chance
 * level understated by the same enumeration that makes them drillable.
 */
function answerSpaceSize(drill: string): number {
  switch (drill) {
    case 'gcf': {
      const values = new Set<number>();
      for (let a = 4; a <= 60; a += 1) for (let b = 4; b <= 60; b += 1) values.add(gcd(a, b));
      return values.size;
    }
    case 'lcm': {
      const values = new Set<number>();
      for (let a = 2; a <= 20; a += 1) for (let b = 2; b <= 20; b += 1) values.add((a * b) / gcd(a, b));
      return values.size;
    }
    case 'square-root':
      // The root of a² for a ∈ 2..20 — 19 distinct answers.
      return 19;
    case 'temperature':
      // celsius ∈ -20..100 — 121 distinct answers.
      return 121;
    case 'rounding': {
      const values = new Set<number>();
      for (let a = 11; a <= 989; a += 1) {
        values.add(Math.round(a / 10) * 10);
        values.add(Math.round(a / 100) * 100);
      }
      return values.size;
    }
    default:
      return 0;
  }
}

/**
 * The drills whose answer space is two options — yes/no or true/false.
 * Guessing scores half on these, so half is their chance level.
 */
const BINARY_DRILLS: ReadonlySet<string> = new Set([
  'prime',
  'factor',
  'parity',
  'comparison',
  'logic-and',
  'logic-or',
  'logic-if',
  'syllogism',
  'logic-not'
]);

/**
 * Families whose answers cluster into a small space: a blind guess hits
 * ~1/space of the time, not the flat 1%. Crediting them at 1% would call
 * noise induction. Sizes follow directly from the generator ranges above
 * (square-root answers are 2..20, celsius inputs are -20..100, and so on).
 */
const CLUSTERED_ANSWER_SPACE: Record<string, number> = {
  gcf: 60,
  lcm: 112,
  'square-root': 19,
  temperature: 121,
  rounding: 101
};

/**
 * Rough probability of a correct answer by guessing. An accuracy at or below
 * this level on unseen exercises means nothing was induced.
 */
export function chanceLevel(drill: string): number {
  if (BINARY_DRILLS.has(drill)) return 0.5;
  const space = CLUSTERED_ANSWER_SPACE[drill];
  if (space !== undefined) return 1 / space;
  return 0.01;
}

/**
 * Generate `count` DISTINCT exercises for a drill. Distinctness is by prompt,
 * so a train/test split cannot leak the same question into both sides.
 */
export function generateExercises(
  drill: string,
  concept: string,
  options: { count: number; seed?: number } = { count: 10 }
): Exercise[] {
  const generator = GENERATORS[drill];
  if (generator === undefined) return [];
  const rng = mulberry32(options.seed ?? 1);
  const seen = new Set<string>();
  const exercises: Exercise[] = [];
  // Bounded: some drills have a small question space and cannot fill a
  // large request. Returning fewer is honest; looping forever is not — and
  // once a full request-window of attempts yields nothing new, the space is
  // treated as exhausted rather than burning the remaining attempts.
  let sinceNew = 0;
  const exhaustionWindow = Math.max(100, options.count * 5);
  for (let attempt = 0; attempt < options.count * 50 && exercises.length < options.count; attempt += 1) {
    const exercise = generator(rng, concept);
    if (seen.has(exercise.prompt)) {
      sinceNew += 1;
      if (sinceNew >= exhaustionWindow) break;
      continue;
    }
    seen.add(exercise.prompt);
    exercises.push(exercise);
    sinceNew = 0;
  }
  return exercises;
}

/**
 * Split exercises into a training set and a HELD-OUT test set. The partition
 * is by a hash of the prompt, so it is stable and the two sides are disjoint
 * by construction rather than by convention.
 */
export function splitExercises(
  exercises: readonly Exercise[],
  testEvery = 4
): { train: Exercise[]; test: Exercise[] } {
  const train: Exercise[] = [];
  const test: Exercise[] = [];
  for (const exercise of exercises) {
    let hash = 0;
    for (let i = 0; i < exercise.prompt.length; i += 1) {
      hash = (Math.imul(hash, 31) + exercise.prompt.charCodeAt(i)) >>> 0;
    }
    (hash % testEvery === 0 ? test : train).push(exercise);
  }
  return { train, test };
}

/** The number an answer states, read as the LAST numeric token. */
export function statedNumber(response: string): string | null {
  const matches = response.match(/-?\d+(?:\.\d+)?/g);
  if (matches === null || matches.length === 0) return null;
  return num(Number(matches[matches.length - 1]));
}

/**
 * Mark a response against the known answer.
 *
 * Numeric answers are read as the last number stated, which is how an answer
 * is normally phrased ("I think it is 12"). Text answers are matched on
 * whole words so "even" never matches inside another word.
 */
export function verify(exercise: Exercise, response: string): Verdict {
  const text = response.trim().toLowerCase();
  if (exercise.kind === 'number') {
    const got = statedNumber(text);
    return { correct: got !== null && got === exercise.answer, expected: exercise.answer, got };
  }

  const expected = exercise.answer.toLowerCase();
  // Fraction-style answers ("3/4") are matched literally.
  if (expected.includes('/') || expected.includes('*')) {
    const normalized = text.replace(/\s+/g, '');
    const target = expected.replace(/\s+/g, '');
    return {
      correct: normalized.includes(target),
      expected: exercise.answer,
      got: text.length > 0 ? text : null
    };
  }

  const correct = new RegExp(`\\b${expected}\\b`).test(text);
  // "even or odd" style questions: crediting a response that says BOTH
  // would be marking an evasion as a hit. Only binary answers have a
  // nameable other side; open answers ("children", "went") have none.
  const opposites: Record<string, string> = {
    even: 'odd',
    odd: 'even',
    yes: 'no',
    no: 'yes',
    true: 'false',
    false: 'true'
  };
  const alternative = opposites[expected];
  const alsoSaidOther = alternative !== undefined && new RegExp(`\\b${alternative}\\b`).test(text);
  // An answer that negates the expected word ("it is not even", "even — not",
  // "not yes") asserts the opposite: it can never count as the affirmative,
  // even though the word itself appears in the text.
  const negated =
    new RegExp(`\\bnot\\s+${expected}\\b`).test(text) || new RegExp(`\\b${expected}\\b\\s+not`).test(text);
  return {
    correct: correct && !alsoSaidOther && !negated,
    expected: exercise.answer,
    got: text.length > 0 ? text : null
  };
}

export interface DrillScore {
  drill: string;
  attempted: number;
  correct: number;
  accuracy: number;
  chance: number;
  /** True when accuracy is meaningfully above guessing. */
  aboveChance: boolean;
}

/** Score a set of answered exercises against the chance baseline. */
export function scoreExercises(
  exercises: readonly Exercise[],
  answer: (exercise: Exercise) => string
): DrillScore {
  const drill = exercises[0]?.drill ?? 'unknown';
  let correct = 0;
  for (const exercise of exercises) {
    if (verify(exercise, answer(exercise)).correct) correct += 1;
  }
  const accuracy = exercises.length > 0 ? correct / exercises.length : 0;
  const chance = chanceLevel(drill);
  return {
    drill,
    attempted: exercises.length,
    correct,
    accuracy,
    chance,
    aboveChance: accuracy > chance + 0.2
  };
}
