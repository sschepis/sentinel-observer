import type { DeckWord } from '../deck';
import type { Relation, RelationPredicate } from '../relations';

/**
 * GROUNDED FACTS — stable real-world scaffolding the frequency deck teaches
 * badly or not at all: the days of the week, the months and their ordinal
 * facts, the seasons, the cardinal directions, basic geography words, and
 * the sun/earth/sky basics.
 *
 * WordNet's first synsets for these words are frequently wrong-domain
 * ("may" the modal, "march" the walk), so this layer is applied LAST in
 * ACTIVE_DECK assembly — its curated senses win. Definitions are written as
 * extractable learner-English noun phrases ("a day of the week...") so the
 * relation extractor mines is-a edges from them for free, and every stated
 * fact is calendar- or astronomy-stable (season phrasing says "in the
 * north" so nothing asserted is hemisphere-false). The 'planet' entry of
 * definitionOverrides is deliberately NOT repeated here — "earth is the
 * third planet from the sun" is stated in full agreement with it. Words the
 * technical curriculum claims ('moon', 'star', 'rock', 'sound', ...) are
 * deliberately ABSENT: this layer wins over the astronomy strand, so an
 * entry here would silently replace the strand's general sense with an
 * Earth-specific one while technicalRelations() still cites the general
 * sense. ('sun' is safe: the strand declares no bare 'sun' concept, and the
 * definition here agrees with its 'star' concept.)
 */

const fact = (word: string, definition: string, example: string): DeckWord => ({
  word,
  definition,
  example
});

export const GROUNDED_FACTS_DECK: readonly DeckWord[] = [
  // ── Days of the week ─────────────────────────────────────────────────
  fact('monday', 'a day of the week, the first day of the working week', 'School starts again on Monday.'),
  fact('tuesday', 'a day of the week that comes after monday', 'The meeting is on Tuesday.'),
  fact('wednesday', 'a day of the week in the middle of the working week', 'We play music on Wednesday.'),
  fact('thursday', 'a day of the week that comes after wednesday', 'The market opens on Thursday.'),
  fact('friday', 'a day of the week, the last day of the working week', 'They eat fish on Friday.'),
  fact('saturday', 'a day of the week and the first day of the weekend', 'We rest on Saturday.'),
  fact('sunday', 'a day of the week, the last day of the weekend and a day of rest', 'The shops close on Sunday.'),
  // ── Months of the year ───────────────────────────────────────────────
  fact('january', 'the first month of the year, in the middle of winter in the north', 'January is often the coldest month.'),
  fact('february', 'the second month of the year and the shortest month', 'February has twenty-eight or twenty-nine days.'),
  fact('march', 'the third month of the year, when spring begins in the north', 'The snow melts in March.'),
  fact('april', 'the fourth month of the year, in the season of spring', 'April brings a lot of rain.'),
  fact('may', 'the fifth month of the year, between april and june', 'The flowers bloom in May.'),
  fact('june', 'the sixth month of the year, when summer begins in the north', 'School ends in June.'),
  fact('july', 'the seventh month of the year, in the middle of summer in the north', 'July is usually a hot month.'),
  fact('august', 'the eighth month of the year, at the end of summer in the north', 'Many families travel in August.'),
  fact('september', 'the ninth month of the year, when autumn begins in the north', 'School starts in September.'),
  fact('october', 'the tenth month of the year, in the season of autumn', 'The leaves turn red in October.'),
  fact('november', 'the eleventh month of the year, near the end of autumn', 'November brings the first frost.'),
  fact('december', 'the twelfth month of the year, when winter begins in the north', 'December is the last month of the year.'),
  // ── Seasons ──────────────────────────────────────────────────────────
  fact('spring', 'a season of the year between winter and summer, when plants begin to grow', 'The birds return in spring.'),
  fact('summer', 'a season of the year between spring and autumn, and the warmest season', 'We swim in the lake in summer.'),
  fact('autumn', 'a season of the year between summer and winter, when leaves fall from the trees', 'The forest turns golden in autumn.'),
  fact('winter', 'a season of the year between autumn and spring, and the coldest season', 'Snow falls in winter.'),
  // ── Cardinal directions ──────────────────────────────────────────────
  fact('north', 'a direction that points toward the top of most maps', 'The birds fly north in spring.'),
  fact('south', 'a direction that points toward the bottom of most maps', 'The birds fly south in winter.'),
  fact('east', 'a direction that points toward the rising sun in the morning', 'The sun rises in the east.'),
  fact('west', 'a direction that points toward the setting sun in the evening', 'The sun sets in the west.'),
  // ── Time-structure words ─────────────────────────────────────────────
  fact('direction', 'a line along which someone or something moves, faces, or points', 'The wind changed direction.'),
  fact('season', 'a part of the year with its own weather, such as winter or summer', 'Each season lasts about three months.'),
  fact('week', 'a period of seven days', 'A week has seven days.'),
  fact('weekend', 'a part of the week made up of saturday and sunday, when many people rest', 'We visit family at the weekend.'),
  fact('calendar', 'a chart that shows the days, weeks, and months of the year', 'She marked the date on the calendar.'),
  fact('noon', 'a time in the middle of the day, when the sun is highest in the sky', 'We eat lunch at noon.'),
  fact('midnight', 'a time in the middle of the night, when one day ends and the next begins', 'The clock struck twelve at midnight.'),
  fact('morning', 'an early part of the day, from when the sun rises until noon', 'The birds sing in the morning.'),
  fact('evening', 'a late part of the day, from the end of the afternoon until night', 'We read together in the evening.'),
  // ── Basic geography ──────────────────────────────────────────────────
  fact('continent', 'a very large area of land on the earth, such as africa or asia', 'Africa is a large continent.'),
  fact('country', 'an area of land with its own people, laws, and government', 'France is a country in Europe.'),
  fact('city', 'a large and important place where many people live and work close together', 'The city is full of tall buildings.'),
  fact('village', 'a place in the country where a small number of people live, smaller than a town', 'The village has one small shop.'),
  fact('map', 'a drawing of an area that shows where places are', 'We found the lake on the map.'),
  fact('globe', 'a round model of the earth that shows the continents and oceans', 'She spun the globe and pointed at a country.'),
  fact('compass', 'a tool that shows which direction is north', 'The hiker checked the compass.'),
  fact('horizon', 'a line in the distance where the earth and the sky seem to meet', 'The ship appeared on the horizon.'),
  // ── Astronomy basics (consistent with the curated 'planet' override; the
  //    astronomy strand owns 'moon' and 'star', so they are not stated here) ──
  fact('sun', 'a star at the center of the solar system that gives the earth light and heat', 'The sun rises every morning.'),
  fact('earth', 'the planet where people live, the third planet from the sun', 'The earth goes around the sun once a year.'),
  fact('sky', 'the space that you see above the earth, where the sun and clouds appear', 'The sky is blue today.')
];

const SOURCE = 'grounded-facts curriculum';

const edge = (subject: string, predicate: RelationPredicate, object: string): Relation => ({
  subject,
  predicate,
  object,
  source: SOURCE,
  origin: 'authored'
});

/**
 * The authored edges for the grounded scaffolding. Plain predicates only
 * (is-a, has-part, has-property, opposite-of, located-in, made-of,
 * capable-of, causes, used-for) — these merge through the same
 * authored-edge path as the technical curriculum and are filtered to
 * knownWords, so nothing here can reference a word the observer lacks.
 */
export const GROUNDED_FACTS_RELATIONS: readonly Relation[] = [
  // Days are days; the weekend is made of two of them.
  edge('monday', 'is-a', 'day'),
  edge('tuesday', 'is-a', 'day'),
  edge('wednesday', 'is-a', 'day'),
  edge('thursday', 'is-a', 'day'),
  edge('friday', 'is-a', 'day'),
  edge('saturday', 'is-a', 'day'),
  edge('sunday', 'is-a', 'day'),
  edge('weekend', 'has-part', 'saturday'),
  edge('weekend', 'has-part', 'sunday'),
  // Months are months.
  edge('january', 'is-a', 'month'),
  edge('february', 'is-a', 'month'),
  edge('march', 'is-a', 'month'),
  edge('april', 'is-a', 'month'),
  edge('may', 'is-a', 'month'),
  edge('june', 'is-a', 'month'),
  edge('july', 'is-a', 'month'),
  edge('august', 'is-a', 'month'),
  edge('september', 'is-a', 'month'),
  edge('october', 'is-a', 'month'),
  edge('november', 'is-a', 'month'),
  edge('december', 'is-a', 'month'),
  // Seasons and their northern-stable properties.
  edge('spring', 'is-a', 'season'),
  edge('summer', 'is-a', 'season'),
  edge('autumn', 'is-a', 'season'),
  edge('winter', 'is-a', 'season'),
  edge('winter', 'has-property', 'cold'),
  edge('summer', 'has-property', 'hot'),
  edge('spring', 'has-property', 'warm'),
  edge('autumn', 'has-property', 'cool'),
  // Cardinal directions and their opposites.
  edge('north', 'is-a', 'direction'),
  edge('south', 'is-a', 'direction'),
  edge('east', 'is-a', 'direction'),
  edge('west', 'is-a', 'direction'),
  edge('north', 'opposite-of', 'south'),
  edge('south', 'opposite-of', 'north'),
  edge('east', 'opposite-of', 'west'),
  edge('west', 'opposite-of', 'east'),
  // Time structure: what contains what.
  edge('week', 'has-part', 'days'),
  edge('week', 'has-part', 'weekend'),
  edge('month', 'has-part', 'days'),
  edge('month', 'has-part', 'weeks'),
  edge('year', 'has-part', 'months'),
  edge('year', 'has-part', 'weeks'),
  edge('year', 'has-part', 'seasons'),
  edge('day', 'has-part', 'morning'),
  edge('day', 'has-part', 'evening'),
  edge('day', 'has-part', 'night'),
  // Astronomy basics.
  edge('earth', 'is-a', 'planet'),
  edge('sun', 'is-a', 'star'),
  edge('sun', 'located-in', 'sky'),
  edge('sun', 'has-property', 'hot'),
  edge('sun', 'has-property', 'bright'),
  edge('sun', 'made-of', 'gas'),
  edge('sun', 'causes', 'daylight'),
  edge('sun', 'causes', 'heat'),
  edge('sun', 'capable-of', 'shine'),
  edge('moon', 'located-in', 'sky'),
  edge('moon', 'located-in', 'space'),
  edge('moon', 'capable-of', 'shine'),
  edge('star', 'located-in', 'sky'),
  edge('star', 'has-property', 'bright'),
  edge('star', 'made-of', 'gas'),
  edge('earth', 'located-in', 'space'),
  edge('earth', 'capable-of', 'spin'),
  edge('earth', 'has-part', 'land'),
  edge('earth', 'has-part', 'water'),
  edge('sky', 'has-part', 'clouds'),
  edge('sky', 'has-part', 'stars'),
  // Geography scaffolding.
  edge('continent', 'has-part', 'countries'),
  edge('country', 'has-part', 'cities'),
  edge('city', 'has-part', 'streets'),
  edge('city', 'is-a', 'place'),
  edge('town', 'is-a', 'place'),
  edge('village', 'is-a', 'place'),
  edge('map', 'is-a', 'drawing'),
  edge('map', 'used-for', 'travel'),
  edge('globe', 'is-a', 'model'),
  edge('compass', 'is-a', 'tool'),
  edge('calendar', 'is-a', 'chart'),
  edge('calendar', 'has-part', 'months'),
  edge('calendar', 'has-part', 'days'),
  edge('horizon', 'located-in', 'distance')
];

/**
 * Layer the grounded facts onto an existing deck, mirroring
 * layerTechnicalDeck exactly: words already in the base deck are REPLACED IN
 * PLACE and only genuinely new words are appended. In-place replacement
 * keeps the WORD SET and its order identical, which is what the legacy
 * hash-based `deckVocabulary` needs to leave every signature untouched
 * (a duplicated word would be re-salted and overwrite its own signature).
 *
 * HONEST LIMIT: under the production `semantic-is-a-v4` scheme
 * (`semanticVocabulary`), signatures are derived from DEFINITION-mined is-a
 * edges, so replacing a definition in place CAN shift that word's category
 * primes — and appended words perturb the global category-prime ranking.
 * Any deck-content change therefore requires regenerating the trained
 * bootstrap artifact; `assertImportable` checks the exported vocabulary
 * fingerprint so a stale artifact is rejected loudly instead of decoding
 * traces against a mismatched basis.
 */
export function layerGroundedFacts(base: readonly DeckWord[]): DeckWord[] {
  const byWord = new Map(GROUNDED_FACTS_DECK.map((entry) => [entry.word, entry]));
  const inBase = new Set(base.map((entry) => entry.word));

  const layered = base.map((entry) => byWord.get(entry.word) ?? entry);

  for (const entry of GROUNDED_FACTS_DECK) {
    if (!inBase.has(entry.word)) layered.push(entry);
  }
  return layered;
}
