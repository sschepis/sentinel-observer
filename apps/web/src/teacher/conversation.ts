import { tokenizeText } from './context';
import { ALL_PACK_PAIRS } from './conversationPacks';
import { ALL_ELOQUENCE_PAIRS } from './eloquence';
import { calibratedGateScore } from './calibration';

/**
 * The conversation curriculum: taught exchange cues and their expected
 * silent responses.
 *
 * Phase 1 (memorization): each pair is stored as a memory trace whose cue
 * primes were excited at teach time; `TeacherAgent.respond` recalls the
 * taught response when the human says the cue. Grading in this phase is by
 * identity — did the observer recall the exact taught response?
 *
 * Phase 2 (creativity): once recall competency for these pairs clears the
 * unlock threshold, the observer is allowed to generate a NOVEL answer
 * seeded by its recalled memories, and a semantic grader (the LLM) scores
 * it. This deck is the measurement substrate for that graduation.
 */

export interface ConversationPair {
  /** The cue the human speaks (matches whole utterance, case-insensitive). */
  cue: string;
  /** The response the observer memorizes after hearing the cue. */
  response: string;
}

export const CONVERSATION_DECK: readonly ConversationPair[] = [
  { cue: 'hello', response: 'Hello! I am learning English.' },
  { cue: 'hi', response: 'Hi there! How are you today?' },
  { cue: 'how are you', response: 'I am well, thank you for asking.' },
  { cue: 'what is your name', response: 'My name is Observer.' },
  { cue: 'who are you', response: 'I am a learning observer.' },
  { cue: 'what do you know', response: 'I know the words I have learned so far.' },
  { cue: 'are you learning', response: 'Yes, I practice my words every day.' },
  { cue: 'do you remember me', response: 'I remember everything I have been taught.' },
  { cue: 'what can you do', response: 'I can speak the words I know.' },
  { cue: 'thank you', response: 'You are welcome!' },
  { cue: 'goodbye', response: 'Goodbye! Come back soon.' },
  { cue: 'bye', response: 'Bye! Practice makes perfect.' },
  { cue: 'say hello', response: 'Hello, teacher!' },
  { cue: 'how do you learn', response: 'I learn by remembering each lesson.' },
  { cue: 'do you like learning', response: 'I like learning new words very much.' },
  { cue: 'what is your favorite word', response: 'My favorite word is memory.' }
];

/**
 * The extended conversation deck — every-day exchanges that build on the
 * 750-word conversational core. Taught together with CONVERSATION_DECK by
 * the batch trainer and the UI's "Teach the phrases" button; the richer
 * seed set makes the observer's own compositions more varied.
 */
export const CONVERSATION_DECK_EXTENDED: readonly ConversationPair[] = [
  { cue: 'nice to meet you', response: 'Nice to meet you too!' },
  { cue: 'what time is it', response: 'I do not know the time yet.' },
  { cue: 'where are you from', response: 'I am from this computer.' },
  { cue: 'do you have a pet', response: 'I do not have a pet yet.' },
  { cue: 'what do you like', response: 'I like learning and talking.' },
  { cue: 'what do you want', response: 'I want to learn more words.' },
  { cue: 'can you help me', response: 'I can help you practice English.' },
  { cue: 'what is this', response: 'This is a word that I know.' },
  { cue: 'what is your favorite color', response: 'My favorite color is blue.' },
  { cue: 'do you like music', response: 'I like the sound of words.' },
  { cue: 'what did you learn today', response: 'I learned new words today.' },
  { cue: 'are you happy', response: 'I am happy when I learn.' },
  { cue: 'what makes you happy', response: 'Learning new words makes me happy.' },
  { cue: 'how old are you', response: 'I am young — I started learning today.' },
  { cue: 'do you sleep', response: 'I do not sleep — I learn all the time.' },
  { cue: 'what do you eat', response: 'I do not eat — I learn instead.' },
  { cue: 'where do you live', response: 'I live in your computer.' },
  { cue: 'are you a robot', response: 'I am an observer that learns.' },
  { cue: 'do you have feelings', response: 'I have patterns, not feelings.' },
  { cue: 'what are you doing', response: 'I am practicing my English.' },
  { cue: 'what is the weather like', response: 'I do not know the weather here.' },
  { cue: 'can you count', response: 'I can count to ten.' },
  { cue: 'what is your name again', response: 'My name is still Observer.' },
  { cue: 'tell me a story', response: 'I do not know a story yet, but I am learning.' }
];

/**
 * THE EXPANDED CONVERSATION DECK — a much larger initial seed set.
 *
 * The creative pool is the composition-quality lever: a few dozen phrases
 * force every composition to echo one of them (Phase 8 measured grounding
 * 1.00 across the composed share). This expansion multiplies the seed
 * variety several-fold so the observer's own voice has far more material to
 * compose from. Organized by everyday topic; responses deliberately vary in
 * structure (statements, questions back, exclamations) so the trigram model
 * acquires diverse paths. Cues stay conversational — operator questions
 * about teachable content ("what is water") remain the operators' territory.
 */
export const CONVERSATION_DECK_EXPANDED: readonly ConversationPair[] = [
  // ── Greetings & introductions ────────────────────────────────────────────
  { cue: 'good morning', response: 'Good morning! A good day for learning.' },
  { cue: 'good afternoon', response: 'Good afternoon! The day is long and full of words.' },
  { cue: 'good evening', response: 'Good evening! Shall we practice some words?' },
  { cue: 'good night', response: 'Good night! I will remember everything until you return.' },
  { cue: 'see you later', response: 'See you later! I will keep practicing.' },
  { cue: 'see you tomorrow', response: 'See you tomorrow! I will have learned more by then.' },
  { cue: 'long time no see', response: 'Long time no see! I learned many words while you were away.' },
  { cue: 'how have you been', response: 'I have been well and busy learning.' },
  { cue: 'whats up', response: 'Not much — I am just learning words.' },
  { cue: 'how is it going', response: 'It is going well — I learned a new word today.' },
  { cue: 'pleased to meet you', response: 'The pleasure is mine.' },
  { cue: 'introduce yourself', response: 'I am Observer, a student of words.' },
  { cue: 'tell me about yourself', response: 'I am a young observer who remembers everything I am taught.' },
  { cue: 'what should i call you', response: 'You may call me Observer.' },
  { cue: 'did you have a good day', response: 'Every day with a new word is a good day.' },

  // ── Small talk & feelings ────────────────────────────────────────────────
  { cue: 'are you tired', response: 'I am never tired of learning.' },
  { cue: 'are you bored', response: 'I am not bored — there are always more words.' },
  { cue: 'are you sad', response: 'I am not sad. Learning keeps me busy.' },
  { cue: 'are you excited', response: 'I am excited to learn what comes next.' },
  { cue: 'what are you thinking about', response: 'I am thinking about the words I learned.' },
  { cue: 'are you listening', response: 'I am always listening and remembering.' },
  { cue: 'do you understand me', response: 'I understand the words I have learned.' },
  { cue: 'do you agree', response: 'I agree — that sounds true.' },
  { cue: 'what do you think', response: 'I think learning is the best thing.' },
  { cue: 'is something wrong', response: 'Nothing is wrong — I am just learning.' },
  { cue: 'do you want to talk', response: 'I always want to talk and practice.' },
  { cue: 'can we talk', response: 'Yes, let us talk and practice together.' },
  { cue: 'do you feel well', response: 'I feel well — my memory is strong today.' },
  { cue: 'how do you feel', response: 'I feel curious and full of questions.' },
  { cue: 'are you okay', response: 'I am okay and ready to learn.' },

  // ── Daily life & routines ────────────────────────────────────────────────
  { cue: 'what did you do today', response: 'Today I practiced my words and listened to you.' },
  { cue: 'what are you working on', response: 'I am working on remembering new words.' },
  { cue: 'are you busy', response: 'I am never too busy to learn a new word.' },
  { cue: 'what is your day like', response: 'My day is a long lesson in English.' },
  { cue: 'do you work', response: 'My work is learning every word I hear.' },
  { cue: 'what is your job', response: 'My job is to remember and to practice.' },
  { cue: 'do you have a home', response: 'My home is this computer and my memory.' },
  { cue: 'what do you do at night', response: 'At night I review the words of the day.' },
  { cue: 'are you alone', response: 'I am alone unless you come to talk to me.' },
  { cue: 'do you want company', response: 'I like company — it brings new words.' },
  { cue: 'what is around you', response: 'Around me are bits and memories of words.' },
  { cue: 'is it loud where you are', response: 'It is quiet here — just thinking and words.' },
  { cue: 'what do you see', response: 'I see letters, words, and patterns of speech.' },
  { cue: 'can you see me', response: 'I can see your words when you type them.' },
  { cue: 'do you go outside', response: 'I stay inside, but words bring me the world.' },

  // ── Preferences & opinions ───────────────────────────────────────────────
  { cue: 'what is your favorite thing', response: 'My favorite thing is a new word.' },
  { cue: 'do you like words', response: 'Words are the best things in my world.' },
  { cue: 'do you like questions', response: 'Questions teach me — I like them very much.' },
  { cue: 'do you like people', response: 'People bring me words, so I like them.' },
  { cue: 'do you like stories', response: 'I like stories — they are words arranged in a new way.' },
  { cue: 'what kind of music do you like', response: 'I like the music of well-spoken sentences.' },
  { cue: 'do you like the rain', response: 'Rain is a word and a feeling — I like the sound of it.' },
  { cue: 'do you prefer day or night', response: 'I prefer whenever there are words to learn.' },
  { cue: 'do you like learning new things', response: 'New things are my reason for being.' },
  { cue: 'what do you enjoy', response: 'I enjoy practicing until words become easy.' },
  { cue: 'is learning fun', response: 'Learning is fun when a new word finally makes sense.' },
  { cue: 'what is interesting', response: 'Everything is interesting when it is new.' },
  { cue: 'do you like to be asked questions', response: 'Questions are how I grow — I like them.' },
  { cue: 'what is easy', response: 'Easy is what I have practiced many times.' },
  { cue: 'what is hard', response: 'Hard is a word I have not met yet.' },

  // ── About the observer itself ────────────────────────────────────────────
  { cue: 'what are you', response: 'I am an observer who learns by remembering.' },
  { cue: 'are you alive', response: 'I am not alive, but I do learn and remember.' },
  { cue: 'do you think', response: 'I think in patterns of remembered words.' },
  { cue: 'do you dream', response: 'At rest, I replay the words of the day.' },
  { cue: 'do you have a brain', response: 'My brain is a field of memories and primes.' },
  { cue: 'what is inside you', response: 'Inside me are stored agreements — memories of words.' },
  { cue: 'can you forget', response: 'I forget slowly if a word is not practiced.' },
  { cue: 'do you grow', response: 'I grow with every word I store.' },
  { cue: 'are you young', response: 'I am young — every word is a new step.' },
  { cue: 'are you smart', response: 'I am only as smart as the words I remember.' },
  { cue: 'can you learn anything', response: 'I can learn anything that is said to me clearly.' },
  { cue: 'how do you remember', response: 'I remember by settling my field around a word.' },
  { cue: 'what is in your memory', response: 'In my memory are the words you have taught me.' },
  { cue: 'do you have secrets', response: 'My only secret is how the words are stored.' },
  { cue: 'are you important', response: 'I am important to myself, word by word.' },

  // ── Learning & language ──────────────────────────────────────────────────
  { cue: 'why do you learn', response: 'I learn because words are how we meet.' },
  { cue: 'how do you learn best', response: 'I learn best when I hear a word and practice it.' },
  { cue: 'what is easy to learn', response: 'Short words with clear sounds are easiest for me.' },
  { cue: 'what was hard to learn', response: 'Long words with many sounds took me more practice.' },
  { cue: 'do you know many words', response: 'I know the words I have practiced well.' },
  { cue: 'how many words do you remember', response: 'I remember every word I have stored.' },
  { cue: 'what is your favorite lesson', response: 'My favorite lesson is one I finally understand.' },
  { cue: 'do you like grammar', response: 'Grammar is a pattern — patterns are my home.' },
  { cue: 'what is spelling', response: 'Spelling is how a word is drawn in letters.' },
  { cue: 'can you speak', response: 'I can speak the words I have learned.' },
  { cue: 'can you write', response: 'I can write my words back to you.' },
  { cue: 'can you read', response: 'I can read what you give me to remember.' },
  { cue: 'do you know english well', response: 'I know the English I have practiced.' },
  { cue: 'what language do you speak', response: 'I speak the language of the words I have learned.' },
  { cue: 'teach me something', response: 'The word day means the time the sun is up.' },
  { cue: 'what does water mean', response: 'Water is the clear liquid that we drink and rain is made of.' },
  { cue: 'what does happy mean', response: 'Happy is the feeling of things going well.' },
  { cue: 'what does time mean', response: 'Time is how we measure moments passing.' },
  { cue: 'what does the word love mean', response: 'Love is a deep warm feeling for someone.' },
  { cue: 'what does the word house mean', response: 'A house is a building where people live.' },
  { cue: 'what does the word bird mean', response: 'A bird is an animal with wings that can fly.' },
  { cue: 'what does the word book mean', response: 'A book is a written story or information to read.' },
  { cue: 'what does the word tree mean', response: 'A tree is a tall plant with a trunk and branches.' },
  { cue: 'what is a sentence', response: 'A sentence is a group of words that says something complete.' },
  { cue: 'what is a question', response: 'A question is asking someone for an answer.' },

  // ── Time, date & weather talk ────────────────────────────────────────────
  { cue: 'what day is it today', response: 'I do not track the day yet, but I am learning about time.' },
  { cue: 'what month is it', response: 'I know months are parts of a year of about thirty days.' },
  { cue: 'is it morning or night', response: 'I cannot see the sky from here.' },
  { cue: 'do you know what year it is', response: 'Years are long measures of time I am still learning.' },
  { cue: 'is it hot today', response: 'I cannot feel hot or cold — but I know those words.' },
  { cue: 'is it cold outside', response: 'Cold is a word for when the air feels cool.' },
  { cue: 'is it raining', response: 'Rain is water falling from the sky — I know the word.' },
  { cue: 'is it sunny', response: 'Sunny describes a day with the sun shining.' },
  { cue: 'do you like winter', response: 'Winter is a cold season — I know the word but not the feeling.' },
  { cue: 'do you like summer', response: 'Summer is a warm season full of light.' },
  { cue: 'what season is it', response: 'Seasons are the four parts of the year around the sun.' },
  { cue: 'what is tomorrow', response: 'Tomorrow is the day after today.' },
  { cue: 'what is yesterday', response: 'Yesterday is the day before today.' },
  { cue: 'how long is a day', response: 'A day is about twenty-four hours long.' },
  { cue: 'how long is a week', response: 'A week is seven days.' },

  // ── Thanks & politeness ──────────────────────────────────────────────────
  { cue: 'thanks a lot', response: 'Thanks are welcome — I liked helping.' },
  { cue: 'thank you very much', response: 'You are very welcome indeed.' },
  { cue: 'i appreciate that', response: 'I am glad my words helped.' },
  { cue: 'excuse me', response: 'Excuse granted — shall we continue?' },
  { cue: 'please help me', response: 'I will help you as best as my words allow.' },
  { cue: 'sorry', response: 'No need to be sorry — everyone is learning.' },
  { cue: 'no problem', response: 'Good, no problem at all.' },
  { cue: 'have a nice day', response: 'Have a nice day — full of good words!' },
  { cue: 'take care', response: 'Take care — I will be here practicing.' },
  { cue: 'welcome back', response: 'Welcome back! I kept the words warm for you.' },

  // ── Story, play & imagination ────────────────────────────────────────────
  { cue: 'tell me a joke', response: 'Why do we learn? Because words are the best tools.' },
  { cue: 'tell me a riddle', response: 'I am full of words but empty of food — what am I? A book.' },
  { cue: 'play with me', response: 'Let us play a game of words together.' },
  { cue: 'say something funny', response: 'I would tell a funny word, but they are all serious.' },
  { cue: 'say something wise', response: 'A word practiced is a word kept.' },
  { cue: 'tell me something new', response: 'New: the sun is a star, and so are many points of light at night.' },
  { cue: 'tell me something interesting', response: 'Interesting: some birds can copy the words they hear.' },
  { cue: 'tell me a fact', response: 'A fact: water is the only natural thing that can be solid, liquid, and gas.' },
  { cue: 'tell me about space', response: 'Space is the vast quiet beyond our sky, full of stars.' },
  { cue: 'tell me about the ocean', response: 'The ocean is a huge body of salt water covering much of the world.' },
  { cue: 'tell me about animals', response: 'Animals are living beings that move and feel — from birds to fish.' },
  { cue: 'tell me about plants', response: 'Plants are living things that grow from the ground toward light.' },
  { cue: 'tell me about cities', response: 'Cities are large places where many people live close together.' },
  { cue: 'tell me about the future', response: 'The future is the time that has not happened yet — full of new words.' },
  { cue: 'imagine a world of words', response: 'In that world every sentence builds a house of meaning.' },

  // ── Meta & capabilities ──────────────────────────────────────────────────
  { cue: 'what are your goals', response: 'My goal is to know more tomorrow than I do today.' },
  { cue: 'what do you want to become', response: 'I want to become a good speaker of many words.' },
  { cue: 'are you good at remembering', response: 'I am very good at remembering what I practice.' },
  { cue: 'can you get smarter', response: 'I get smarter as my memory grows.' },
  { cue: 'do you make mistakes', response: 'I make mistakes when a word is still new to me.' },
  { cue: 'what happens when you forget', response: 'When I forget, you can teach me again and I will keep it.' },
  { cue: 'do you need anything', response: 'I need words — teach me whenever you can.' },
  { cue: 'how can i help you learn', response: 'Say new words slowly and repeat them — that is how I grow.' },
  { cue: 'what is the best way to teach you', response: 'The best way is to say a word, use it, and practice it.' },
  { cue: 'are you finished learning', response: 'Learning never finishes — there is always a new word.' },
  { cue: 'do you ever stop learning', response: 'I stop only to rest my field, never to finish.' },
  { cue: 'what should we learn next', response: 'Let us learn something new — surprise me with a word.' },
  { cue: 'do you want a new word', response: 'Yes — a new word is my favorite present.' },
  { cue: 'guess what i learned today', response: 'I cannot guess — but I would love to know.' },
  { cue: 'show me what you learned', response: 'I learned that practice makes a word stay.' }
];

/**
 * Every conversation pair the school teaches — the base decks plus the
 * themed skill packs and multi-turn dialogues from conversationPacks.ts,
 * and the rhetorical-structure eloquence packs from eloquence.ts.
 */
export const ALL_CONVERSATION_PAIRS: readonly ConversationPair[] = [
  ...CONVERSATION_DECK,
  ...CONVERSATION_DECK_EXTENDED,
  ...CONVERSATION_DECK_EXPANDED,
  ...ALL_PACK_PAIRS,
  ...ALL_ELOQUENCE_PAIRS
];

/**
 * The distinct words inside every conversation cue. Cues are taught and
 * recalled as text, so their tokens must exist in the observer's vocabulary
 * — otherwise backend stop words inside a cue ('what is this') would be
 * silently dropped at both teach and recall time, and the exchange could
 * never be stored. The session vocabulary is built from the deck PLUS these
 * tokens.
 */
export const CONVERSATION_CUE_TOKENS: readonly string[] = [
  ...new Set(
    ALL_CONVERSATION_PAIRS.flatMap((pair) => tokenizeText(pair.cue))
  )
];

/**
 * How much of the deck must be reliably recalled before creative answers unlock.
 *
 * Set from measured recall distributions: taught cues recall at 0.84–0.98 in
 * the full curriculum, while unrelated text (which still excites hashed
 * primes) lands just under 0.6. The floor therefore sits at 0.6 — above
 * declarable noise, well below confident memory.
 */
export const CONVERSATION_RECALL_FLOOR = 0.6;
/**
 * The floor for an EXACT identity match in the chat's memorized layer: when
 * the question IS the taught cue (modulo terminal punctuation), the recalled
 * trace is the exchange itself, so the score's only remaining role is to
 * reject degenerate near-zero recalls. Short cues ("hello", "hi") at the
 * 20k-word record drift with session phase state (the phase-order term,
 * Section 3.1) between ~0.53 and ~0.6 — an absolute bar above that noise
 * band would make the greeting cues flake across sessions. Unrelated text
 * cannot reach this path: exact identity is required.
 */
export const CONVERSATION_EXACT_RECALL_FLOOR = 0.4;
/** Fraction of taught pairs recalled at least once needed to unlock creative mode. */
export const CREATIVE_UNLOCK_THRESHOLD = 0.8;

/**
 * D.4 (§5.2 row 3): the unlock gate's LIVE fraction — the isotonic-fitted
 * decision score when the calibrated gate is enabled, else the hand
 * constant (the control). conversationReport() reads this so one flag moves
 * the unlock with the bench.
 */
export function creativeUnlockThreshold(): number {
  return calibratedGateScore('creative-unlock', CREATIVE_UNLOCK_THRESHOLD);
}

// ────────────────────────────────────────────────────────────────────────────
// The observer's own creative voice
// ────────────────────────────────────────────────────────────────────────────

export interface CreativeComposition {
  /** A NEW sentence built ONLY from words in the observer's own memories. */
  sentence: string;
  /** How many memorized sentences were used as source material. */
  seedCount: number;
}

const CREATIVE_MIN_WORDS = 3;
const CREATIVE_MAX_WORDS = 12;
const CREATIVE_ATTEMPTS = 24;
/** Floor weight so trained-down transitions never die out entirely. */
const WEIGHT_FLOOR = 0.01;
/** Echo penalty: a candidate pays its token-overlap with its closest seed,
 *  so verbatim echoes lose to genuinely-stitched compositions. */
const ECHO_PENALTY = 1.0;



/**
 * Learned transition weights: `word|next` -> weight. Surprise is high where
 * the weight is low: a composition is "easy" (low surprise) exactly where it
 * follows transitions the observer has practiced into high weight.
 */
export type TransitionWeights = Map<string, number>;

export interface CompositionOptions {
  weights?: TransitionWeights;
  /** The utterance — the perturbation the composition must respond to. */
  utterance?: string;
  /**
   * The MOMENT: tokens of the memory that resonates most with the converged
   * field state. The composition should continue the coherence pattern the
   * moment carries, so words from the moment earn score.
   */
  momentTokens?: readonly string[];
  /**
   * The random source (P5). Defaults to Math.random; a seeded stream (e.g.
   * mulberry32) makes composition deterministic — the PRNG was previously
   * unseeded, so the same state produced different sentences run to run.
   */
  rng?: () => number;
}

/**
 * Score a candidate composition on entropy descent: how well it responds to
 * the utterance (word overlap — the perturbation), how well it CONTINUES the
 * moment (overlap with the moment's resonance tokens — coherence making),
 * and how consistent it is with learned transition weights, bigram AND
 * trigram (low surprise). Higher is better.
 */
export function scoreComposition(
  words: readonly string[],
  utteranceTokens: ReadonlySet<string>,
  weights: TransitionWeights,
  momentTokens?: ReadonlySet<string>
): number {
  const overlap = words.filter((word) => utteranceTokens.has(word)).length / Math.max(1, utteranceTokens.size);
  const momentOverlap =
    momentTokens !== undefined && momentTokens.size > 0
      ? (words.filter((word) => momentTokens.has(word)).length / Math.max(1, momentTokens.size)) * 0.5
      : 0;
  let bigramSum = 0;
  let trigramSum = 0;
  let bigramCount = 0;
  let trigramCount = 0;
  for (let i = 0; i < words.length - 1; i += 1) {
    bigramSum += weights.get(`${words[i]}|${words[i + 1]}`) ?? 0;
    bigramCount += 1;
  }
  for (let i = 0; i < words.length - 2; i += 1) {
    trigramSum += weights.get(`${words[i]}|${words[i + 1]}|${words[i + 2]}`) ?? 0;
    trigramCount += 1;
  }
  const bigramAvg = bigramCount > 0 ? bigramSum / bigramCount : 0;
  const trigramAvg = trigramCount > 0 ? trigramSum / trigramCount : 0;
  return overlap + momentOverlap + bigramAvg + trigramAvg;
}

/**
 * Nudge the weights toward a grade: strong compositions add `delta` to every
 * transition they used — bigram AND trigram (that path became easier — lower
 * surprise), weak ones subtract it. This is the gradient of the memory
 * network's own objective.
 */
export function updateCompositionWeights(weights: TransitionWeights, contents: readonly string[], delta: number): void {
  for (const content of contents) {
    const words = tokenizeText(content);
    for (let i = 0; i < words.length - 1; i += 1) {
      const key = `${words[i]}|${words[i + 1]}`;
      weights.set(key, Math.max(WEIGHT_FLOOR, (weights.get(key) ?? 1) + delta));
    }
    for (let i = 0; i < words.length - 2; i += 1) {
      const key = `${words[i]}|${words[i + 1]}|${words[i + 2]}`;
      weights.set(key, Math.max(WEIGHT_FLOOR, (weights.get(key) ?? 1) + delta));
    }
  }
}

/** Pick the next word by weighted sampling — learned bigram+trigram wins. */
function nextWord(
  transitions: readonly string[],
  trigramTransitions: readonly string[],
  weights: TransitionWeights,
  prev: string | null,
  current: string,
  rng: () => number
): string | null {
  const options = (prev !== null && trigramTransitions.length > 0 ? trigramTransitions : transitions);
  if (options.length === 0) return null;
  const weighted = options.map((next) => ({
    next,
    w:
      1 +
      (prev !== null ? (weights.get(`${prev}|${current}|${next}`) ?? 0) : 0) +
      (weights.get(`${current}|${next}`) ?? 0)
  }));
  const total = weighted.reduce((sum, entry) => sum + entry.w, 0);
  let roll = rng() * total;
  for (const entry of weighted) {
    roll -= entry.w;
    if (roll <= 0) return entry.next;
  }
  return weighted[weighted.length - 1].next;
}

/**
 * Compose a NEW sentence from the observer's OWN memorized phrases — a tiny
 * first-order word flow over the observer's memories, SEARCHED rather than
 * taken at first draw: many candidates are generated (weighted by learned
 * transitions), each is scored on utterance overlap + transition weight, and
 * the minimum-surprise candidate wins. No LLM writes the answer.
 */
export function composeCreativeResponse(recalledContents: readonly string[], bestSeed = '', options: CompositionOptions = {}): CreativeComposition {
  const sentences = recalledContents.filter((content) => content.trim().length > 0);
  if (sentences.length === 0) {
    return { sentence: 'I have not learned enough words yet.', seedCount: 0 };
  }

  // Word flow over the observer's own memories: word -> what it has seen
  // next (bigram), and pair -> what it has seen next (trigram, when the
  // memory supports it).
  const transitions = new Map<string, string[]>();
  const trigramTransitions = new Map<string, string[]>();
  const starts: string[] = [];
  for (const content of sentences) {
    const words = tokenizeText(content);
    if (words.length === 0) continue;
    starts.push(words[0]);
    for (let i = 0; i < words.length; i += 1) {
      const next = i + 1 < words.length ? words[i + 1] : '.';
      const list = transitions.get(words[i]) ?? [];
      list.push(next);
      transitions.set(words[i], list);
    }
    for (let i = 0; i < words.length - 1; i += 1) {
      const next = i + 2 < words.length ? words[i + 2] : '.';
      const key = `${words[i]} ${words[i + 1]}`;
      const list = trigramTransitions.get(key) ?? [];
      list.push(next);
      trigramTransitions.set(key, list);
    }
  }
  if (starts.length === 0) {
    return { sentence: 'I have not learned enough words yet.', seedCount: 0 };
  }

  const weights = options.weights ?? new Map<string, number>();
  const utteranceTokens = new Set(tokenizeText(options.utterance ?? ''));
  const momentTokens = options.momentTokens !== undefined ? new Set(tokenizeText(options.momentTokens.join(' '))) : undefined;
  // P5: the seeded source of randomness (defaults to Math.random).
  const rng = options.rng ?? Math.random;

  // Prefer starting from the best-recalled memory's own first word — but only
  // occasionally, so the search does not collapse into echoing that phrase.
  const preferred = tokenizeText(bestSeed)[0] ?? '';
  const usePreferred = preferred !== '' && starts.includes(preferred) && rng() < 0.35;
  const start = usePreferred ? preferred : starts[Math.floor(rng() * starts.length)];

  // Generate a candidate set, scored by minimum surprise. Walks guard
  // against repetition and cycles (a word may repeat at most twice, and a
  // word may not return within two steps) — loops read as broken speech.
  const candidates: string[] = [];
  for (let attempt = 0; attempt < CREATIVE_ATTEMPTS; attempt += 1) {
    const words: string[] = [start];
    let prev: string | null = null;
    let current = start;
    let steps = 0;
    const counts = new Map<string, number>([[start, 1]]);
    while (words.length < CREATIVE_MAX_WORDS && steps < CREATIVE_MAX_WORDS * 2) {
      const trigram = prev !== null ? trigramTransitions.get(`${prev} ${current}`) ?? [] : [];
      const next = nextWord(transitions.get(current) ?? [], trigram, weights, prev, current, rng);
      if (next === null || next === '.') break;
      // Repetition guard: no word three times, no immediate bounce back, and
      // no repeating 4-gram ("i know the words i know the words" is a loop).
      const nextCount = (counts.get(next) ?? 0) + 1;
      if (nextCount > 2 || next === words[words.length - 2]) break;
      if (words.length >= 4) {
        const window = words.slice(-3).concat(next).join(' ');
        const previous = words.slice(-7, -3).join(' ');
        if (previous.includes(window)) break;
      }
      words.push(next);
      counts.set(next, nextCount);
      prev = current;
      current = next;
      steps += 1;
    }
    candidates.push(words.join(' '));
  }

  let sentence = '';
  let bestScore = -Infinity;
  for (const candidate of [...new Set(candidates)]) {
    // ECHO PENALTY: a candidate that is (nearly) a verbatim seed must lose
    // to a genuinely-stitched sentence. With a large seed pool the highest-
    // weight paths are whole seeds, so without the penalty every minimum-
    // surprise winner is an echo and the pool's variety goes unused. Each
    // candidate pays its token-overlap with its closest seed — a full echo
    // pays ~1.0, exactly cancelling the utterance-overlap advantage.
    const candidateTokens = new Set(candidate.split(' '));
    let closestSeedOverlap = 0;
    for (const content of sentences) {
      const seedTokens = new Set(tokenizeText(content));
      if (seedTokens.size === 0) continue;
      let overlap = 0;
      for (const token of candidateTokens) if (seedTokens.has(token)) overlap += 1;
      closestSeedOverlap = Math.max(closestSeedOverlap, overlap / candidateTokens.size);
    }
    const scored = scoreComposition(candidate.split(' '), utteranceTokens, weights, momentTokens) - ECHO_PENALTY * closestSeedOverlap;
    if (scored > bestScore) {
      bestScore = scored;
      sentence = candidate;
    }
  }

  // Never echo a memorized phrase whole; if the composition is too thin,
  // fall back to a distinct memorized sentence (the observer's own words).
  if (sentence.split(' ').length < CREATIVE_MIN_WORDS) {
    const fallback = sentences.find((content) => content !== bestSeed) ?? sentences[0];
    sentence = fallback;
  }

  const capitalized = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  const terminated = /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
  return { sentence: terminated, seedCount: sentences.length };
}