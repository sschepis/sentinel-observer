/**
 * @jest-environment node
 *
 * TASKS.md #16 — THE DRIVE ARBITRATION MANIPULATION BENCH (Rule 2: a
 * mechanism on a decision path earns a bench that changes its input and
 * watches the behavior move).
 *
 * The drives now own exactly one decision on the chat path: when a reply
 * could honestly be a composition about known material OR a question about
 * it, `arbitrateReply` samples between 'compose' and 'ask' at the drive
 * temperature. This bench pins the drive components through the
 * manipulation hook, sweeps curiosity, and asserts the ask share rises with
 * it — against the null of an unchanged drive state, under which the share
 * must not move at all. It also asserts the boundary the design promises:
 * no factual form is ever arbitrated.
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { ALL_CONVERSATION_PAIRS, CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

const DECK: readonly DeckWord[] = [
  { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
  { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' },
  { word: 'wings', definition: 'a part of a bird used for flying', example: 'Wings flap.' },
  { word: 'dog', definition: 'a common animal with four legs that people keep as a pet', example: 'The dog barks.' },
  { word: 'apple', definition: 'a round red or green fruit', example: 'I eat an apple.' },
  { word: 'fruit', definition: 'a sweet part of a plant with seeds', example: 'I like fruit.' },
  { word: 'water', definition: 'a clear liquid that falls as rain and is used for drinking', example: 'Water is wet.' },
  { word: 'snow', definition: 'frozen white water that falls from the sky', example: 'Snow is cold.' },
  { word: 'game', definition: 'a contest with rules that people play to win', example: 'We play a game.' },
  { word: 'rules', definition: 'a set of instructions for playing a game', example: 'Rules matter.' },
  { word: 'weather', definition: 'the state of the air outside such as rain or sun', example: 'The weather is nice.' },
  { word: 'rain', definition: 'water that falls from clouds', example: 'Rain is wet.' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  smfWidth: 128,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

const PAIRS = ALL_CONVERSATION_PAIRS.slice(0, 40);

/** Known-material prompts that reach the compose/ask boundary: no factual
 *  form, at least one known content word. */
const PROMPTS = DECK.flatMap((entry) => [
  `tell me about ${entry.word}`,
  `say something about ${entry.word}`,
  `what do you think about ${entry.word}`
]);

/** A fresh, creative-unlocked teacher. Fresh per level so the learned drive
 *  weights and the gap ledger cannot carry one level's outcomes into the
 *  next; the arbitration stream is session-seeded, so two fresh teachers
 *  under the same drive state make the same choices. */
async function unlockedTeacher(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK, null, 500, 4, 7);
  for (const entry of DECK) teacher.teach(entry.word);
  teacher.teachConversationDeck(PAIRS);
  for (const pair of PAIRS) teacher.respond(pair.cue);
  expect(teacher.conversationReport().creativeUnlocked).toBe(true);
  return { session, teacher };
}

interface Shares {
  ask: number;
  compose: number;
  arbitrated: number;
  n: number;
}

async function sharesAt(curiosity: number, novelty = 0.5): Promise<Shares> {
  const { session, teacher } = await unlockedTeacher();
  teacher.setDriveOverride({ curiosity, novelty });
  let ask = 0;
  let compose = 0;
  let arbitrated = 0;
  for (const prompt of PROMPTS) {
    const answer = teacher.chatAnswer(prompt);
    if (answer.mode === 'creative') {
      compose += 1;
      if (answer.arbitration !== undefined) arbitrated += 1;
    } else if (answer.mode === 'ask') {
      ask += 1;
      if (answer.arbitration !== undefined) arbitrated += 1;
    }
  }
  session.dispose();
  return { ask: ask / PROMPTS.length, compose: compose / PROMPTS.length, arbitrated: arbitrated / PROMPTS.length, n: PROMPTS.length };
}

describe('drive arbitration on the chat path (TASKS.md #16)', () => {
  it('the compose/ask decision carries its arbitration record; factual forms are never arbitrated', async () => {
    const { session, teacher } = await unlockedTeacher();
    teacher.setDriveOverride({ curiosity: 0, novelty: 0.5 });
    const composed = teacher.chatAnswer('tell me about water');
    expect(['creative', 'ask']).toContain(composed.mode);
    if (composed.mode === 'creative' || composed.mode === 'ask') {
      expect(composed.arbitration).toBeDefined();
      expect(composed.arbitration?.options).toEqual(['compose', 'ask']);
      expect(composed.arbitration?.drives.curiosity).toBe(0);
    }
    // A factual form reaches the operator/relation layers or the honest ask
    // — never the arbitration. Whatever it answers, it was not a drive's call.
    teacher.setDriveOverride({ curiosity: 0, novelty: 1 });
    const factual = teacher.chatAnswer('is water a bird');
    expect(factual.mode).not.toBe('creative');
    if (factual.mode === 'ask') expect(factual.arbitration).toBeUndefined();
    const definition = teacher.chatAnswer('what is a quargle');
    expect(definition.mode).toBe('ask');
    if (definition.mode === 'ask') expect(definition.arbitration).toBeUndefined();
    session.dispose();
  }, 60000);

  it('sweeping curiosity moves the ask share up and the compose share down; the null (same state) does not move', async () => {
    const levels = [0, 0.25, 0.5, 0.75, 1];
    const sweep: Shares[] = [];
    for (const curiosity of levels) sweep.push(await sharesAt(curiosity));
    // eslint-disable-next-line no-console
    console.log(
      '\nDRIVE ARBITRATION — ask share vs curiosity (novelty pinned 0.5, n=' + sweep[0].n + ' prompts per level):\n' +
        levels.map((c, i) => `  curiosity ${c.toFixed(2)}  ask ${(sweep[i].ask * 100).toFixed(1)}%  compose ${(sweep[i].compose * 100).toFixed(1)}%  arbitrated ${(sweep[i].arbitrated * 100).toFixed(1)}%`).join('\n')
    );
    // Every reply at this boundary was arbitrated (compose or ask, both recorded).
    for (const s of sweep) expect(s.arbitrated).toBeGreaterThan(0.9);
    // The manipulation moves the behavior: high curiosity asks more than none.
    expect(sweep[sweep.length - 1].ask).toBeGreaterThan(sweep[0].ask + 0.2);
    expect(sweep[sweep.length - 1].compose).toBeLessThan(sweep[0].compose - 0.2);
    // Monotone within noise across the sweep (n=36 per level ⇒ one prompt is 2.8%).
    for (let i = 1; i < sweep.length; i += 1) expect(sweep[i].ask).toBeGreaterThanOrEqual(sweep[i - 1].ask - 0.1);
    // The null: the same drive state on a fresh teacher reproduces the same
    // shares exactly (seeded stream) — the movement above is the drives, not noise.
    const again = await sharesAt(0.5);
    expect(again.ask).toBe(sweep[2].ask);
    expect(again.compose).toBe(sweep[2].compose);
  }, 180000);

  it('reports the exploration floor: how often a zero-curiosity observer still asks about known material', async () => {
    const cold = await sharesAt(0, 0);
    const warm = await sharesAt(0, 1);
    // eslint-disable-next-line no-console
    console.log(`DRIVE ARBITRATION — exploration floor at curiosity 0: novelty 0 → ask ${(cold.ask * 100).toFixed(1)}%, novelty 1 → ask ${(warm.ask * 100).toFixed(1)}%`);
    // At the cold limit (curiosity 0, novelty 0 ⇒ T = T_MIN) the sample is
    // the argmax: compose wins every time. This pins the design's own claim
    // that T → T_MIN recovers the argmax.
    expect(cold.ask).toBe(0);
    // Novelty raises the temperature, so some asks appear even at zero
    // curiosity — reported, not gated: whether that exploration floor is
    // wanted is a design decision the number informs.
    expect(warm.ask).toBeGreaterThanOrEqual(0);
  }, 120000);
});
