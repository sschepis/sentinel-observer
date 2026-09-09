/**
 * @jest-environment node
 *
 * THE STORY-STATE ENGINE (docs/TASKS.md #64). Every case here is a real row
 * of corpus/problems.jsonl (SVAMP + ASDiv), and the file is organised the
 * way the engine's contract is: what it READS, and what it DECLINES.
 *
 * The declines are the more important half. Most of them were a WRONG
 * ANSWER at some point while this engine was built — a sum where the story
 * meant a difference, a whole double-counted with its parts, a question
 * about the other party to a transfer, a question naming a kind the story
 * never states — and each one is here so that it stays a decline.
 *
 * The whole-corpus measurement is curriculum/problemsBenchmark.test.ts
 * (bench config): of 3,004 problems the engine answers 418 and gets 418
 * right (414 before the rationals deck; measured with the relation store,
 * 411 without it). Every reading is also DERIVED here by the rewrite engine, so a
 * reading the engine could not reduce would fail this file rather than
 * quietly becoming an ASK in production.
 */
import { describe, it, expect } from '@jest/globals';
import { RuleStore } from './types';
import { PEANO_RULES } from './peano';
import { DIGITS_RULES } from './digits';
import { RAT_RULES } from './rat';
import { reduce } from './engine';
import { decodeNormalForm, parseRewritePrompt } from './parse';
import { digitsForNumberWords, parseStory, type StoryWorld } from './story';

const store = new RuleStore([...PEANO_RULES, ...DIGITS_RULES, ...RAT_RULES]);

/** What the observer would actually say: the term, reduced by the engine. */
function derive(prompt: string): { value: string | null; status: string; steps: number } {
  const parsed = parseRewritePrompt(prompt);
  if (parsed === null) return { value: null, status: 'unparsed', steps: 0 };
  const reduction = reduce(store, parsed.term, { fuel: parsed.fuel });
  if (reduction.outcome.status !== 'normal') return { value: null, status: reduction.outcome.status, steps: reduction.steps };
  return { value: decodeNormalForm(reduction.outcome.term), status: 'normal', steps: reduction.steps };
}

/** prompt, the value it must read, the shape, and why the case is here. */
const READS: Array<[string, number, string, string]> = [
  [
    'Maria had fifty sheets of paper in her desk and forty-one more in her backpack. How many did she have total?',
    91, 'total', 'number words'
  ],
  [
    'Josh had 22 marbles in his collection. Jack gave him 20 marbles. How many marbles does Josh have now?',
    42, 'total', 'the receiver owns the gift'
  ],
  [
    'There were 10 roses in the vase. Jessica cut 8 more roses from her flower garden and put them in the vase. How many roses are there in the vase now?',
    18, 'total', 'a gain worded as a cut'
  ],
  [
    'A mirror store has 78 mirrors in stock. 8 mirrors are broken, and 57 mirrors are sold. How many mirrors are left?',
    13, 'residual', 'two take-aways'
  ],
  [
    'There are 8 people on the bus. At the next stop 12 more people got on the bus and 3 people got off. How many people are there on the bus now?',
    17, 'total', 'a gain and a loss'
  ],
  [
    'Robin cut off 13 inches of his hair. If his hair was 14 inches long initially How long is his hair now?',
    1, 'total', 'taken off a measure'
  ],
  [
    'Randy has 79 blocks. He uses 14 blocks to build a tower and 11 blocks to build a house. How many blocks are left?',
    54, 'residual', 'a whole consumed by activities'
  ],
  [
    'Dave had 19 apps on his phone. He deleted 5 apps. How many apps are left on his phone?',
    14, 'residual', 'residual'
  ],
  [
    'Paco had 97 salty cookies and 34 sweet cookies. He ate 15 sweet cookies and 56 salty cookies. How many sweet cookies did Paco have left?',
    19, 'residual', 'two kinds, the question picks one'
  ],
  [
    'Haley grew 9 trees in her backyard. After a typhoon 4 died. Then she grew 5 more trees. How many trees does she have left?',
    10, 'residual', 'gain, loss, gain'
  ],
  [
    'Evan has a large collection of books. He gave his best friend 14 books. He gave his little brother 8 books. Now Evan has 60 books in his collection. How many books did he have at first?',
    82, 'start', 'the start is the unknown'
  ],
  [
    'Jerry had caught some butterflies. He let eleven go and now he has eighty-two left. How many did he originally have?',
    93, 'start', 'a release, in number words'
  ],
  [
    'Randy has some blocks. He uses 52 blocks to build a tower. If there are 38 blocks left How many blocks did he have at the start?',
    90, 'start', 'the start is the unknown'
  ],
  [
    'Last week Fred had 33 dollars and Jason had 95 dollars. Over the weekend Fred delivered newspapers earning 16 dollars and washed cars earning 74 dollars. How much money did Fred earn over the weekend?',
    90, 'change', 'the events, not the state'
  ],
  [
    'Todd had 85 cents in his pocket. He bought a candy bar for 14 cents. He bought a box of cookies for 39 cents. How much money did Todd spend altogether?',
    53, 'change', 'the events, not the state'
  ],
  [
    'When Amy got to the fair she had $15. When she left she had $11. How much money did she spend at the fair?',
    4, 'change', 'two states are the change'
  ],
  [
    'Randy has 97 blocks. He uses some blocks to build a tower. If there are 72 blocks left How many blocks did he use to build the tower?',
    25, 'change', 'the change is the unknown'
  ],
  [
    'Paul had 134 books. After giving 39 books to his friend and selling some books in a garage sale he had 68 books left. How many books did he sell in the garage sale?',
    27, 'change', 'the change is the unknown'
  ],
  [
    'Zachary did 51 push-ups and David did 44 push-ups in gym class today. How many more push-ups did Zachary do than David?',
    7, 'difference by owner', 'a difference'
  ],
  [
    'A grocery store had 19 bottles of diet soda and 60 bottles of regular soda. How many more bottles of regular soda than diet soda did they have?',
    41, 'difference', 'a difference of two kinds'
  ],
  [
    'Willy has 1400 crayons. Lucy has 290 crayons. How many more crayons does Willy have then Lucy?',
    1110, 'difference by owner', 'a difference by owner'
  ],
  [
    'There are 37 baskets. There are 17 apples in each basket. How many apples are there in all?',
    629, 'per × groups', 'per x groups'
  ],
  [
    'There are 544 pots. Each pot has 32 flowers in it. How many flowers are there in all?',
    17408, 'per × groups', 'per x groups, in the digits deck'
  ],
  [
    'If each bag has 41 cookies and you had 53 bags of cookies How many cookies would you have?',
    2173, 'per × groups', 'per x groups'
  ],
  [
    'There are 396 students going to a trivia competition. If each school van can hold 9 students, how many vans will they need?',
    44, 'groups = whole ÷ per', 'groups = whole / per'
  ],
  [
    'Frank was reading through his favorite book. The book had 392 pages and he read 14 pages per day. How many days did he take to finish the book?',
    28, 'groups = whole ÷ per', 'groups = whole / per'
  ],
  [
    'Laura has 28 blocks and 8 cards. If she shares the blocks among 4 friends, how many blocks does each friend get?',
    7, 'share = whole ÷ groups', 'share = whole / groups'
  ],
  [
    'Emily is making bead necklaces for her friends. She was able to make 6 necklaces and she had 18 beads. How many beads did each necklace need?',
    3, 'share = whole ÷ groups', 'share = whole / groups'
  ],
  [
    '67 medals are displayed in the sports center. There are 19 gold medals and 32 silver medals. How many bronze medals are displayed?',
    16, 'whole − stated parts', 'the whole less its stated parts'
  ],
  [
    'A grocery store had 49 bottles of regular soda, 40 bottles of diet soda and 6 bottles of lite soda. How many bottles of regular soda and diet soda did they have altogether?',
    89, 'total', 'the question names which kinds'
  ],
  [
    'Rachel had to complete 5 pages of math homework, 10 pages of reading homework and 6 more pages of biology homework. How many pages of reading and biology homework did she have to complete?',
    16, 'total', 'the question names which kinds'
  ],
  [
    'Julia played tag with 5 kids on monday, 9 kids on tuesday and 15 kids on wednesday. How many kids did she play with on monday and wednesday?',
    20, 'total', 'the question names which days'
  ],
  // Money, exactly (TASKS #67). Both of these were declined outright until
  // the rationals deck existed: no deck could hold $17.15.
  [
    'After paying $2.30 for a drink, Bryon has $17.15. How much money did he have before buying the drink?',
    19.45, 'start', 'a decimal start, exact'
  ],
  [
    'Lisa rented 4 DVDs for $4.80. How much did each DVD cost to rent?',
    1.2, 'share = whole ÷ groups', 'a share that does not come out even, in money'
  ],
  // Rate stories with more than one thing in them (TASKS #68). All four
  // were declines: the rate counted as one more unnamed alternative, or the
  // count had to be a single number.
  [
    'Robin has 28 packages of gum and 13 packages of candy. There are 4 pieces in each package. How many pieces of gum does Robin have?',
    112, 'per × groups', 'the measure is not one of the alternatives'
  ],
  [
    'Faye was placing her pencils and crayons into 19 rows with 4 pencils and 27 crayons in each row. How many pencils does she have?',
    76, 'per × groups', 'two rates over the same groups, and the question names which'
  ],
  [
    'The Ferris wheel in paradise park has 2 small seats and 23 large seats. Each small seat can hold 14 people and large seat can hold 54 people. How many people can ride the Ferris wheel on small seats?',
    28, 'per × groups', 'the most specific named slot decides'
  ],
  [
    'Kaleb bought 14 boxes of chocolate candy and gave 5 to his little brother. If each box has 6 pieces inside it, how many pieces did Kaleb still have?',
    54, 'per × groups after the story', 'a rate over a story that lost something: (14 − 5) × 6'
  ],
  // A NET OF RATES (TASKS #82): several rates over the same groups, all of
  // them accounted for, with the sign taken from the clause that stated
  // each one. All three were declines until the reader stopped throwing
  // away whether a RATE's clause was a loss.
  [
    'Lewis earns $ 491 every week during the 1181 weeks of harvest. If he has to pay $ 216 rent every week How much money will have at the end of the harvest season?',
    324775, 'net of rates × groups', 'an income and a cost per week: (491 − 216) × 1181'
  ],
  [
    'Lewis earns $ 28 every week during the 1091 weeks of harvest. He also earns $ 939 per week for working overtime. If he works overtime every week How much money does he earn during harvest season?',
    1054997, 'net of rates × groups', 'two incomes per week'
  ],
  [
    'There are 466 pots. Each pot has 53 flowers and 181 sticks in it. How many flowers and sticks are there in all?',
    109044, 'net of rates × groups', 'the question names both rates, so it asks for their sum'
  ],
  [
    'There are 7 baskets of peaches. Each basket has 10 red peaches and 2 green peaches. How many green peaches are in the baskets altogether?',
    14, 'per × groups', 'two rates over ONE noun contrast by their words: the question chooses, never sums'
  ],
];

/** prompt, and the reason this story is beyond the engine. */
const DECLINES: Array<[string, string]> = [
  [
    'At band practice there were 4 rows of students with 8 students in each row and then another 9 students in the back. How many students were there total?',
    'the 9 in the back was read as a second rate per row: two rates over one noun with nothing to choose by'
  ],
  [
    'We ordered 17 pizzas. Each pizza has 4 slices. If there are 25 of us How many slices of pizza are there altogether?',
    'an unnamed ADDITION to a rate story is a third thing the shape cannot place'
  ],
  [
    'Bryan took a look at his books and magazines. If he has 23 books and 61 magazines in each of his 29 bookshelves How many books and magazines does he have in total?',
    'the books have a rate of their own, stated in another clause'
  ],
  [
    'Mary is baking a cake. The recipe calls for 9 cups of sugar 14 cups of flour and 40 cups of salt. She already put in 4 cups of flour. How many more cups of flour than cups of sugar does she need to add now?',
    'two steps: (14 − 4) − 9, a comparison against a derived quantity'
  ],
  [
    'Kira has $1.20 in quarters and dimes. She has minimized coins altogether. How many coins does she have?',
    'a count cannot be fractional: 1.2 is not a number of coins (TASKS #67)'
  ],
  [
    "Lastly, he went to a music store and bought a new set of speakers for his dad's entertainment system. If the initial price of the speakers is $475.00 he got it for $199.00, how much money was he able to save from having a discount?",
    'a stated price beside what was paid is a comparison, not two events'
  ],
  [
    'In a school there are 308 girls and 318 boys. There are also 36 teachers How many pupils are there in that school?',
    'is a pupil a girl? only the relation store can say (TASKS #65)'
  ],
  [
    'In a school, there are 542 girls and 387 boys. How many pupils are there in total?',
    'the same, even with a total cue'
  ],
  [
    'At the zoo, I see 35 elephants and 48 tigers. How many legs do I see?',
    'legs per elephant is world knowledge (TASKS #65)'
  ],
  [
    'A book has 2 chapters across 23 pages. The first chapter is 10 pages long. How many pages are in the first chapter?',
    'a stated whole beside its parts'
  ],
  [
    'There are 45 questions on the math test. 17 questions are word problems. 28 questions are addition and subtraction problems. Steve can only answer 38 questions. How many questions did Steve leave blank?',
    'one quantity is the sum of others: adding all would double-count'
  ],
  [
    'Katie had 91 ds games and her new friends had 88 games and old friends had 53 games. How many games do her friends have in all?',
    'named a distinguishing word it cannot act on coherently'
  ],
  [
    '18 red peaches, 14 yellow peaches and 17 green peaches are in the basket. How many red and yellow peaches are in the basket?',
    'the same: two named kinds, no coherent contrast'
  ],
  [
    'Rachel picked 7 apples from her tree. Thereafter 2 new apples grew on the tree. Now the tree has 6 apples still on it. How many apples did the tree have to begin with?',
    'the question asks about the other party to the event'
  ],
  [
    'Nell collects baseball cards. She had 528 cards while Jeff had 11 cards. She gave some of her cards to jeff and now has 252 cards left. How many cards did Nell give to Jeff?',
    'a transfer between two owners'
  ],
  [
    'Alexa and Katerina stood on a scale together. The scale read 95 pounds. Alexa knows she weighs 46 pounds. How much does Katerina weigh?',
    'one number covers two parties'
  ],
  [
    'Marco and his dad went strawberry picking. Marco\'s strawberries weighed 10 pounds. If together their strawberries weighed 26 pounds. How much more did his dad\'s strawberries weigh than his?',
    'a difference between a whole and a part'
  ],
  [
    'Winter is almost here and most animals are migrating to warmer countries. There were 87 bird families living near the mountain. If 7 bird families flew away for winter How many more bird families stayed behind than those that flew away for the winter?',
    'a difference against a derived remainder'
  ],
  [
    'Next in their itinerary was the insectarium. She was able to capture 60 species of butterflies, 15 species of ants and 20 species of other insects. How many species of insects did Penny capture?',
    'a residual category: other insects'
  ],
  [
    'Debby bought 95 soda bottles and 180 water bottles when they were on sale. If she drank 15 water bottles and 54 soda bottles a day How many days would the water bottles last?',
    'asks for days, which the story states only as a rate'
  ],
  [
    'A clown needed two hundred twenty-seven balloons for a party he was going to, but the balloons only came in packs of two. How many packs of balloons would he need to buy?',
    'asks for packs, which the story does not count'
  ],
  [
    'Mrs. Walker will have 56 apples for bobbing for apples. Each bucket will hold 9 apples. How many buckets will she need?',
    'an inexact quotient is not an answer'
  ],
  [
    'Melissa played 3 games and scored a total of 81 points scoring the same for each game. How many points did she score in each game?',
    'a stated total beside the count it divides by'
  ],
  [
    'A farmer had 160 tomatoes in his garden. If he picked 56 of them yesterday and 41 today. How many did he have left after yesterday\'s picking?',
    'a question that selects by exclusion'
  ],
  [
    'Tiffany was collecting cans for recycling. On monday she had 8 bags of cans. She found 10 bags of cans on the next day and 4 bags of cans the day after that. How many bags did she find after monday?',
    'the same'
  ],
  [
    'A sandbox is 312 centimeters long and 146 centimeters wide. How many square centimeters of ground does the sandbox cover?',
    'an area'
  ],
  [
    'The dance troupe used ribbob to form a rectangle. The rectangle was 20 feet long and 15 feet wide. How long was the piece of ribbon?',
    'a perimeter'
  ],
  [
    'A fence post in Tina\'s garden is 4 feet tall. When she measured the fence post\'s shadow, she found that it was 12 feet long. A tree in Tina\'s yard had a shadow of 72 feet. How tall is the tree?',
    'a proportion'
  ],
  [
    'This year on your 11th birthday your mother tells you that she is exactly 3 times as old as you are. How old is she?',
    'a scaling'
  ],
  [
    'Isabella\'s hair is 18 cubes long. She gets hair extensions and it doubles her length. How much hair does she have now?',
    'a doubling'
  ],
  [
    'Chef Pillsbury\'s secret recipe requires 7 eggs for every 2 cups of flour. How many eggs will he need if he uses 8 cups of flour?',
    'a ratio'
  ],
  [
    'Jemma filled one-fourth of a barrel with compost on Saturday. Then she filled the remaining space with 4200 g of compost on Sunday. How many kilograms of compost are in the barrel?',
    'a fraction and a unit conversion'
  ],
  [
    'Caitlin is on the 13th step of a giant slide. She walked down 4 steps to talk to her friend Dana. Then she walked up 12 steps to the top. How many steps does the giant slide have?',
    'the story leans on an ordinal position'
  ],
  [
    'Alex, Brad, Calvin, and Dennis are playing checkers. Each of the 4 boys played 2 games with every other player. How many games of checkers were played altogether?',
    'a combinatorial count'
  ],
  [
    'On a track for remote-controlled racing cars, racing car A completes the track in 28 seconds, while racing car B completes it in 24 seconds. If they both start at the same time, after how many seconds will they be side by side again?',
    'a coincidence of periods'
  ],
  [
    'There were some birds sitting on the fence. 4 more birds came to join them. How many birds are sitting on the fence now?',
    'the story hides the number the answer needs'
  ],
  [
    'Thirteen ducks are swimming in a lake. Twenty more ducks come to join them. How many ducks are swimming in the lake?',
    'the lake is not a kind it can place'
  ],
];

describe('story-state engine — what it reads', () => {
  it.each(READS)('reads (%#) %s', (prompt, expected, shape) => {
    const reading = parseStory(prompt);
    expect(reading).not.toBeNull();
    expect({ value: reading!.value, shape: reading!.shape }).toEqual({ value: expected, shape });
  });

  it('every reading DERIVES in the engine, and the engine agrees with the reading', () => {
    for (const [prompt, expected] of READS) {
      expect({ prompt, ...derive(prompt) }).toEqual({ prompt, value: String(expected), status: 'normal', steps: expect.any(Number) });
    }
  });

  it('adds, subtracts and multiplies in the DIGITS deck, so the cost is columns and not tally marks', () => {
    // 544 x 32 in unary Peano exhausts a 10,000-step budget (measured:
    // 29 seconds, then an ASK); column-wise it is a few hundred steps.
    // Reaching the digits deck at all needed a decoder for its normal form,
    // which nothing had — the whole deck was unreachable from a spoken
    // answer before this (docs/TASKS.md #69).
    const prompt = 'There are 544 pots. Each pot has 32 flowers in it. How many flowers are there in all?';
    const reading = parseStory(prompt);
    expect(reading?.deck).toBe('digits');
    const derived = derive(prompt);
    expect(derived.value).toBe('17408');
    expect(derived.steps).toBeLessThan(4000);
  });

  it('a division is derived in Peano, because the digits deck has no division rule', () => {
    const reading = parseStory('There are 396 students going to a trivia competition. If each school van can hold 9 students, how many vans will they need?');
    expect(reading?.deck).toBe('peano');
    expect(derive('There are 396 students going to a trivia competition. If each school van can hold 9 students, how many vans will they need?').value).toBe('44');
  });

  it('reads number words, and keeps the word that follows them', () => {
    // The bug this pins: the converter swallowed the separator after a
    // conversion, so "let eleven go" became "let 11go" — the story lost the
    // verb that made it a take-away AND the quantity's noun.
    expect(digitsForNumberWords('He let eleven go and now he has eighty-two left.')).toBe('He let 11 go and now he has 82 left.');
    expect(digitsForNumberWords('two hundred sixty-six sinks')).toBe('266 sinks');
    expect(digitsForNumberWords('one of her trees')).toBe('one of her trees');
    expect(digitsForNumberWords('she saw one more minivan')).toBe('she saw 1 more minivan');
  });
});

describe('story-state engine — money and measures, exactly (TASKS #67)', () => {
  it('a decimal is a quantity now, and the deck follows the arithmetic', () => {
    const reading = parseStory('After paying $2.30 for a drink, Bryon has $17.15. How much money did he have before buying the drink?');
    expect(reading?.deck).toBe('rat');
    // The exact value is the pair, not the float: 389/20.
    expect(reading?.exact).toEqual({ numerator: 389, denominator: 20 });
    expect(reading?.spoken).toBe('19.45');
    expect(derive('After paying $2.30 for a drink, Bryon has $17.15. How much money did he have before buying the drink?').value).toBe('19.45');
  });

  it('a whole-number story still goes to the whole-number decks', () => {
    // The rationals cost more per step, so nothing that was whole before
    // may become a fraction now.
    expect(parseStory('There are 37 baskets. There are 17 apples in each basket. How many apples are there in all?')?.deck).toBe('digits');
    expect(parseStory('Laura has 28 blocks and 8 cards. If she shares the blocks among 4 friends, how many blocks does each friend get?')?.deck).toBe('peano');
  });

  it('a division that does not come out even is an ANSWER for money and a DECLINE for things', () => {
    // "How much did each DVD cost" asks for an amount; "how many blocks
    // does each friend get" asks for a count, and 4.5 blocks is not a
    // reading of the story — it is a misreading of it.
    expect(parseStory('Lisa rented 4 DVDs for $4.80. How much did each DVD cost to rent?')?.spoken).toBe('1.2');
    expect(parseStory('Laura has 9 blocks and 8 cards. If she shares the blocks among 2 friends, how many blocks does each friend get?')).toBeNull();
  });

  it('a composed reading is one TERM, two operations deep', () => {
    // The first derivation this engine builds that is not a single
    // operation: the count the rate multiplies is itself a subtraction, and
    // it is one term the engine reduces — not two answers stitched
    // together (TASKS #68).
    const prompt = 'Kaleb bought 14 boxes of chocolate candy and gave 5 to his little brother. If each box has 6 pieces inside it, how many pieces did Kaleb still have?';
    const reading = parseStory(prompt);
    expect(reading?.shape).toBe('per × groups after the story');
    const term = reading!.term;
    expect(term.t === 'sym' ? term.head : null).toBe('dig.mul');
    const inner = term.t === 'sym' ? term.args[0] : null;
    expect(inner !== null && inner.t === 'sym' ? inner.head : null).toBe('dig.sub');
    expect(derive(prompt).value).toBe('54');
  });

  it('the operand ceiling is the honest bound: cents ride unary numerals underneath', () => {
    // $53.90 is 539/10 and $39.33 is 3933/100, and `rat.sub` cross-multiplies
    // them into tens of thousands of successors. Declining is coverage, not
    // a wrong answer — a digit-backed rational is the fix (TASKS #81).
    expect(parseStory('Dave earned $53.90. Sara earned $39.33. How much more money did Dave earn than Sara?')).toBeNull();
  });
});

describe('story-state engine — what it declines', () => {
  it.each(DECLINES)('declines (%#) %s', (prompt) => {
    expect(parseStory(prompt)).toBeNull();
  });

  it('a decline reaches the dispatch as a decline — the engine is never handed a guess', () => {
    for (const [prompt] of DECLINES) {
      const parsed = parseRewritePrompt(prompt);
      // Either nothing parses, or one of the anchored parsers reads a shape
      // it can defend. What must never happen is a story-shaped term for a
      // story this engine did not understand.
      if (parsed !== null) expect(parsed.drill).not.toMatch(/^story-/);
    }
  });

  it('the honesty contract, stated as a property: over the whole corpus sample it answers or declines, never guesses', () => {
    // A compact stand-in for the bench: every READ derives to its value and
    // every DECLINE yields nothing. The bench measures the rates; this
    // guards the invariant in the unit suite.
    for (const [prompt, expected] of READS) expect(derive(prompt).value).toBe(String(expected));
    for (const [prompt] of DECLINES) expect(parseStory(prompt)).toBeNull();
  });
});

describe('story-state engine — where the arithmetic asks what the observer knows (TASKS #65)', () => {
  /** A store that knows what ConceptNet knows about these two words. */
  const birds: StoryWorld = {
    isKindOf: (word, kind) => kind === 'bird' && (word === 'goose' || word === 'duck' || word === 'geese')
  };

  it('sums two kinds only when the store says the asked kind covers both', () => {
    const prompt = 'There were 58 geese and 37 ducks in the marsh. How many birds were there in all?';
    // Without a store the observer cannot know a goose is a bird: decline.
    expect(parseStory(prompt)).toBeNull();
    // With one, the sum is derived — and the reading records what the store
    // had to say for it to be sound.
    const reading = parseStory(prompt, birds);
    expect(reading?.value).toBe(95);
    expect(reading?.shape).toBe('total by kind (store)');
    expect(reading?.coveredKinds).toEqual(['goose is-a bird', 'duck is-a bird']);
  });

  it('a store that covers only one of the kinds still declines', () => {
    const half: StoryWorld = { isKindOf: (word, kind) => kind === 'bird' && word === 'goose' };
    expect(parseStory('There were 58 geese and 37 ducks in the marsh. How many birds were there in all?', half)).toBeNull();
  });

  it('a PART question is never a kind question, however generous the store', () => {
    // "How many legs" over elephants and tigers needs legs-per-elephant, a
    // number no is-a chain holds. Soundness here is relative to the store,
    // so a store claiming an elephant IS a leg would be believed — but a
    // store that knows an elephant HAS legs settles it structurally, and
    // that is the store the observer actually has.
    const anatomy: StoryWorld = { isKindOf: () => true, hasPart: (_word, part) => part === 'leg' || part === 'wheel' };
    expect(parseStory('At the zoo, I see 35 elephants and 48 tigers. How many legs do I see?', anatomy)).toBeNull();
    expect(parseStory('There are 22 bicycles and 3 cars in the garage. How many wheels are there in the garage?', anatomy)).toBeNull();
  });

  it('the store never rescues a shape the engine does not understand', () => {
    const yesToEverything: StoryWorld = { isKindOf: () => true };
    // A difference across kinds, a stated whole, an unknown quantity: all
    // still decline with a maximally generous store.
    for (const prompt of [
      'Marco and his dad went strawberry picking. Marco\'s strawberries weighed 10 pounds. If together their strawberries weighed 26 pounds. How much more did his dad\'s strawberries weigh than his?',
      'A book has 2 chapters across 23 pages. The first chapter is 10 pages long. How many pages are in the first chapter?',
      'There were some birds sitting on the fence. 4 more birds came to join them. How many birds are sitting on the fence now?'
    ]) {
      expect(parseStory(prompt, yesToEverything)).toBeNull();
    }
  });

  it('every reading and every decline in this file is unchanged by a store that knows nothing', () => {
    const silent: StoryWorld = { isKindOf: () => false };
    for (const [prompt, expected] of READS) expect(parseStory(prompt, silent)?.value).toBe(expected);
    for (const [prompt] of DECLINES) expect(parseStory(prompt, silent)).toBeNull();
  });
});
