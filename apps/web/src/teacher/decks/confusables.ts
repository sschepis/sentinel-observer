import type { DeckWord } from '../deck';

/**
 * THE CONFUSABLE-PAIR DECK — the P10 contrastive-differentiation substrate
 * (TODO Phase 15, item 15.2).
 *
 * Each pair is two words the observer is likely to store as near-duplicate
 * traces: orthographic near-twins (desert/dessert) whose prime signatures
 * sit close together, and semantic near-neighbors (crocodile/alligator)
 * whose definitions overlap heavily. The consolidation pass will walk these
 * pairs and PUSH the confused traces apart (±δ on the differentiating
 * primes, plus a belief trace naming the distinction).
 *
 * Until that pass lands, this deck is directly teachable: each side carries
 * a learner-English definition and example WRITTEN TO HIGHLIGHT THE
 * CONTRAST, and `contrast` states the distinction in one sentence — so even
 * plain teaching stores the difference explicitly rather than leaving two
 * blurred traces.
 */

export interface ConfusablePair {
  /** One side of the confusion. */
  a: DeckWord;
  /** The other side of the confusion. */
  b: DeckWord;
  /** One sentence stating the distinction between the two words. */
  contrast: string;
}

export const CONFUSABLE_PAIRS: readonly ConfusablePair[] = [
  // ── Orthographic near-twins ──────────────────────────────────────────────
  {
    a: { word: 'desert', definition: 'a dry land with very little rain', example: 'The desert has sand and almost no water.' },
    b: { word: 'dessert', definition: 'a sweet food eaten after a meal', example: 'We had cake for dessert after dinner.' },
    contrast: 'Desert is dry land; dessert is sweet food after a meal.'
  },
  {
    a: { word: 'affect', definition: 'to change or make a difference to something', example: 'Rain can affect our plans for the day.' },
    b: { word: 'effect', definition: 'the result or change that something causes', example: 'The medicine had a good effect on her.' },
    contrast: 'Affect is the verb that changes something; effect is the noun result.'
  },
  {
    a: { word: 'lose', definition: 'to no longer have something, or to not win', example: 'Do not lose your keys on the way home.' },
    b: { word: 'loose', definition: 'not tight or not firmly held', example: 'The shirt is loose and moves in the wind.' },
    contrast: 'Lose means to misplace or be beaten; loose means not tight.'
  },
  {
    a: { word: 'accept', definition: 'to take or agree to something offered', example: 'I accept your kind invitation.' },
    b: { word: 'except', definition: 'not including someone or something', example: 'Everyone came except my brother.' },
    contrast: 'Accept means to agree to take; except means leaving something out.'
  },
  {
    a: { word: 'than', definition: 'a word used to compare two things', example: 'She is taller than her sister.' },
    b: { word: 'then', definition: 'at that time, or what happens next', example: 'We ate dinner and then watched a film.' },
    contrast: 'Than compares two things; then tells the time or order.'
  },
  {
    a: { word: 'quiet', definition: 'making little or no noise', example: 'The library is a quiet place to read.' },
    b: { word: 'quite', definition: 'to a large degree; rather', example: 'The test was quite hard for me.' },
    contrast: 'Quiet means little noise; quite means rather or very.'
  },
  {
    a: { word: 'weather', definition: 'the state of the sky and air, like rain or sun', example: 'The weather today is sunny and warm.' },
    b: { word: 'whether', definition: 'a word introducing a choice between things', example: 'I do not know whether to walk or ride.' },
    contrast: 'Weather is rain or sun outside; whether introduces a choice.'
  },
  {
    a: { word: 'principal', definition: 'the head of a school, or the most important', example: 'The principal spoke to the whole school.' },
    b: { word: 'principle', definition: 'a basic rule or truth that guides action', example: 'Honesty is a principle she lives by.' },
    contrast: 'Principal is the school head or the main one; principle is a rule.'
  },
  {
    a: { word: 'stationary', definition: 'not moving; standing still', example: 'The car stayed stationary at the red light.' },
    b: { word: 'stationery', definition: 'paper, pens, and other writing materials', example: 'She bought stationery to write her letters.' },
    contrast: 'Stationary means not moving; stationery is writing paper and pens.'
  },
  {
    a: { word: 'advice', definition: 'an opinion given to help someone decide', example: 'My advice is to sleep early before the test.' },
    b: { word: 'advise', definition: 'to tell someone what you think they should do', example: 'I advise you to bring an umbrella.' },
    contrast: 'Advice is the noun you give; advise is the verb of giving it.'
  },
  {
    a: { word: 'breath', definition: 'the air that goes in and out of the body', example: 'Take a deep breath before you dive.' },
    b: { word: 'breathe', definition: 'to move air in and out of the body', example: 'It is hard to breathe on a high mountain.' },
    contrast: 'Breath is the air itself; breathe is the act of taking it in.'
  },
  {
    a: { word: 'choose', definition: 'to pick one thing from several now', example: 'Please choose a book you want to read.' },
    b: { word: 'chose', definition: 'picked one thing in the past', example: 'Yesterday she chose the red dress.' },
    contrast: 'Choose is the present act of picking; chose is the past.'
  },
  {
    a: { word: 'later', definition: 'after the present time', example: 'I will call you later this evening.' },
    b: { word: 'latter', definition: 'the second of two things just named', example: 'Of tea and coffee, I prefer the latter.' },
    contrast: 'Later means afterwards in time; latter is the second of two named.'
  },
  {
    a: { word: 'personal', definition: 'belonging to or about one person', example: 'This diary is personal, so please do not read it.' },
    b: { word: 'personnel', definition: 'the people who work for a company', example: 'The personnel meet every Monday morning.' },
    contrast: 'Personal means private to one person; personnel means the staff.'
  },
  {
    a: { word: 'conscience', definition: 'the inner sense of right and wrong', example: 'His conscience told him to return the money.' },
    b: { word: 'conscious', definition: 'awake and aware of what is happening', example: 'She was conscious during the whole visit.' },
    contrast: 'Conscience is the inner moral sense; conscious means awake and aware.'
  },
  {
    a: { word: 'complement', definition: 'a thing that completes or goes well with another', example: 'The red scarf is a complement to her coat.' },
    b: { word: 'compliment', definition: 'a kind thing said to praise someone', example: 'He gave her a compliment about her singing.' },
    contrast: 'Complement completes something; compliment praises someone.'
  },
  {
    a: { word: 'farther', definition: 'a greater physical distance', example: 'The store is farther down this road.' },
    b: { word: 'further', definition: 'more, or to a greater degree', example: 'We need further time to finish the work.' },
    contrast: 'Farther is physical distance; further is more amount or degree.'
  },
  {
    a: { word: 'allusion', definition: 'an indirect mention of something', example: 'The poem makes an allusion to an old story.' },
    b: { word: 'illusion', definition: 'something that looks real but is not', example: 'The pool of water in the road was an illusion.' },
    contrast: 'An allusion is an indirect mention; an illusion is a false appearance.'
  },
  {
    a: { word: 'eminent', definition: 'famous and respected in a field', example: 'An eminent doctor gave the talk.' },
    b: { word: 'imminent', definition: 'about to happen very soon', example: 'Dark clouds mean rain is imminent.' },
    contrast: 'Eminent means famous and respected; imminent means about to happen.'
  },
  {
    a: { word: 'precede', definition: 'to come before something in time or order', example: 'Spring will precede summer every year.' },
    b: { word: 'proceed', definition: 'to continue or go forward', example: 'Please proceed to the next question.' },
    contrast: 'Precede means to come before; proceed means to go forward.'
  },
  {
    a: { word: 'device', definition: 'a tool or machine made for a purpose', example: 'A phone is a device for talking at a distance.' },
    b: { word: 'devise', definition: 'to invent or plan something in the mind', example: 'We must devise a plan to finish on time.' },
    contrast: 'Device is the tool itself; devise is to invent or plan it.'
  },
  {
    a: { word: 'dairy', definition: 'milk and foods made from milk', example: 'Cheese and butter are dairy foods.' },
    b: { word: 'diary', definition: 'a book where you write about each day', example: 'She writes in her diary every night.' },
    contrast: 'Dairy is milk food; a diary is a daily written record.'
  },
  {
    a: { word: 'brake', definition: 'the part that slows or stops a vehicle', example: 'Press the brake gently at the corner.' },
    b: { word: 'break', definition: 'to split into pieces, or a short rest', example: 'Do not break the glass; take a break instead.' },
    contrast: 'A brake stops a vehicle; to break is to split or to rest.'
  },
  {
    a: { word: 'capital', definition: 'the main city of a country, or money for business', example: 'Paris is the capital of France.' },
    b: { word: 'capitol', definition: 'the building where lawmakers meet', example: 'The lawmakers gathered at the capitol.' },
    contrast: 'Capital is the main city or money; capitol is the lawmakers\u2019 building.'
  },
  {
    a: { word: 'coarse', definition: 'rough and not smooth or fine', example: 'The coarse sand hurt our bare feet.' },
    b: { word: 'course', definition: 'a series of lessons, or a path taken', example: 'She took a course in cooking this spring.' },
    contrast: 'Coarse means rough in texture; a course is lessons or a path.'
  },
  {
    a: { word: 'moral', definition: 'about right and wrong, or the lesson of a story', example: 'The moral of the story is to be honest.' },
    b: { word: 'morale', definition: 'the level of hope and spirit in a group', example: 'Winning the game raised the team\u2019s morale.' },
    contrast: 'Moral concerns right and wrong; morale is a group\u2019s spirit.'
  },
  {
    a: { word: 'peace', definition: 'a time without war or noise; calm', example: 'The village lived in peace for many years.' },
    b: { word: 'piece', definition: 'a part or bit of something larger', example: 'May I have a piece of that bread?' },
    contrast: 'Peace is calm without conflict; a piece is a part of something.'
  },
  {
    a: { word: 'plain', definition: 'simple and without decoration, or flat land', example: 'She wore a plain white shirt.' },
    b: { word: 'plane', definition: 'a flying vehicle with wings', example: 'The plane landed at the airport on time.' },
    contrast: 'Plain means simple or flat land; a plane flies in the sky.'
  },
  // ── Semantic near-neighbors ──────────────────────────────────────────────
  {
    a: { word: 'crocodile', definition: 'a large water reptile with a long pointed snout', example: 'The crocodile has a long V-shaped snout.' },
    b: { word: 'alligator', definition: 'a large water reptile with a wide rounded snout', example: 'The alligator has a wide U-shaped snout.' },
    contrast: 'A crocodile has a pointed snout; an alligator has a wide rounded one.'
  },
  {
    a: { word: 'turtle', definition: 'a shelled reptile that lives mostly in water', example: 'The turtle swam across the pond with flat feet.' },
    b: { word: 'tortoise', definition: 'a shelled reptile that lives on land', example: 'The tortoise walked slowly across the dry field.' },
    contrast: 'A turtle lives mostly in water; a tortoise lives on land.'
  },
  {
    a: { word: 'tornado', definition: 'a narrow spinning column of air over land', example: 'The tornado twisted across the flat fields.' },
    b: { word: 'hurricane', definition: 'a very large spinning storm that forms over warm ocean', example: 'The hurricane grew over the warm ocean for days.' },
    contrast: 'A tornado is a narrow column over land; a hurricane is a vast ocean storm.'
  },
  {
    a: { word: 'rabbit', definition: 'a small long-eared animal that lives in burrows', example: 'The rabbit hid in its burrow under the field.' },
    b: { word: 'hare', definition: 'a larger long-eared animal that lives above ground', example: 'The hare ran fast across the open grass.' },
    contrast: 'A rabbit lives in burrows; a hare is larger and lives above ground.'
  },
  {
    a: { word: 'frog', definition: 'a smooth wet-skinned animal that stays near water', example: 'The frog jumped from the wet rock into the pond.' },
    b: { word: 'toad', definition: 'a dry bumpy-skinned animal that walks on land', example: 'The toad walked slowly through the dry garden.' },
    contrast: 'A frog has smooth wet skin near water; a toad is dry and bumpy on land.'
  },
  {
    a: { word: 'street', definition: 'a road in a town with buildings along it', example: 'The street was full of shops and people.' },
    b: { word: 'road', definition: 'a wide way for vehicles between places', example: 'The road runs from the town to the farm.' },
    contrast: 'A street sits in a town with buildings; a road connects places.'
  },
  {
    a: { word: 'house', definition: 'a building where people live', example: 'They built a house of brick and wood.' },
    b: { word: 'home', definition: 'the place where you live and belong', example: 'After the long trip, it felt good to be home.' },
    contrast: 'A house is the building; a home is the place you belong.'
  },
  {
    a: { word: 'hear', definition: 'to notice sound with the ears without trying', example: 'I can hear the birds outside the window.' },
    b: { word: 'listen', definition: 'to pay attention to sound on purpose', example: 'Please listen carefully to the teacher.' },
    contrast: 'To hear is to notice sound; to listen is to attend to it on purpose.'
  },
  {
    a: { word: 'see', definition: 'to notice something with the eyes without trying', example: 'I can see the mountain from my window.' },
    b: { word: 'watch', definition: 'to look at something for a time on purpose', example: 'We watch the game every Saturday.' },
    contrast: 'To see is to notice with the eyes; to watch is to look on purpose over time.'
  },
  {
    a: { word: 'say', definition: 'to speak words', example: 'Please say your name slowly.' },
    b: { word: 'tell', definition: 'to give information to a person', example: 'Please tell me the way to the station.' },
    contrast: 'To say is to speak words; to tell is to give information to someone.'
  },
  {
    a: { word: 'borrow', definition: 'to take something you will give back', example: 'May I borrow your pen for a minute?' },
    b: { word: 'lend', definition: 'to give something that will be given back', example: 'Can you lend me your umbrella today?' },
    contrast: 'You borrow something from a person; you lend something to a person.'
  },
  {
    a: { word: 'bring', definition: 'to carry something toward the speaker', example: 'Please bring your book here to me.' },
    b: { word: 'take', definition: 'to carry something away from the speaker', example: 'Please take these letters to the office.' },
    contrast: 'Bring moves a thing toward here; take moves it away from here.'
  },
  {
    a: { word: 'jealousy', definition: 'fear of losing what you have to someone else', example: 'His jealousy grew when she praised his friend.' },
    b: { word: 'envy', definition: 'wanting what another person has', example: 'She felt envy when she saw his new bicycle.' },
    contrast: 'Jealousy fears losing what you have; envy wants what another has.'
  },
  {
    a: { word: 'bee', definition: 'a striped insect that makes honey and lives in hives', example: 'The bee carried pollen back to the hive.' },
    b: { word: 'wasp', definition: 'a thin-waisted stinging insect that makes no honey', example: 'The wasp built a paper nest under the roof.' },
    contrast: 'A bee makes honey in a hive; a wasp does not make honey.'
  },
  {
    a: { word: 'butterfly', definition: 'a day-flying insect with bright wide wings', example: 'The butterfly opened its bright wings in the sun.' },
    b: { word: 'moth', definition: 'a night-flying insect with dull folded wings', example: 'The moth flew to the lamp in the dark.' },
    contrast: 'A butterfly flies by day with bright wings; a moth flies at night.'
  },
  {
    a: { word: 'cement', definition: 'the gray powder that binds building material', example: 'Workers mixed cement with water and sand.' },
    b: { word: 'concrete', definition: 'the hard building material made from cement, sand, and stone', example: 'The path was made of hard gray concrete.' },
    contrast: 'Cement is the binding powder; concrete is the finished hard mix.'
  },
  {
    a: { word: 'fog', definition: 'a thick cloud near the ground that hides things', example: 'The fog was so thick we could not see the road.' },
    b: { word: 'mist', definition: 'a thin light cloud near the ground', example: 'A soft mist floated over the morning field.' },
    contrast: 'Fog is thick and hides things; mist is thin and light.'
  }
];

/**
 * Every side of every pair as one flat teachable deck. A word may in
 * principle appear in two pairs; the deck keeps the first occurrence so
 * downstream teaching never stores the same word twice.
 */
export function confusableDeck(): DeckWord[] {
  const seen = new Set<string>();
  const deck: DeckWord[] = [];
  for (const pair of CONFUSABLE_PAIRS) {
    for (const entry of [pair.a, pair.b]) {
      if (seen.has(entry.word)) continue;
      seen.add(entry.word);
      deck.push(entry);
    }
  }
  return deck;
}
