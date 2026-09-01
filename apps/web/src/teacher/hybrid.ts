import { CREATIVE_REINFORCE_SCORE, CREATIVE_WEAKEN_SCORE, type TeacherAgent } from './TeacherAgent';
import type { Chaperone, SemanticGrader } from './chaperone';

// The store/gap policy is shared with creative practice — one threshold
// pair, no drift. Re-exported for callers that need the numbers.
export { CREATIVE_REINFORCE_SCORE as HYBRID_STORE_SCORE, CREATIVE_WEAKEN_SCORE as HYBRID_GAP_SCORE } from './TeacherAgent';

/**
 * The HYBRID voice — the ceiling layer of the conversation stack.
 *
 * When the observer's OWN layers all fail (memorized → operator → creative →
 * ask), it may summon the LLM to draft an answer CONDITIONED on its own
 * recalled memories: the observer provides the context, the LLM provides the
 * language. The draft is then graded semantically; a strong draft (>= 0.7)
 * is stored as the observer's own creative memory (source: hybrid) so the
 * next time the same thing is asked, it is recalled from memory with no LLM
 * call. Weak drafts (< 0.3) become gaps. Mid drafts are shown but never
 * stored. The observer remains the arbiter of what enters its memory.
 */

export interface HybridResult {
  answer: string;
  score: number | null;
  feedback: string | null;
  /** True when the draft was stored as the observer's own memory. */
  stored: boolean;
  /** The observer's own memories the draft was conditioned on. */
  memories: string[];
}


export async function hybridAnswer(
  teacher: TeacherAgent,
  chaperone: Chaperone,
  grader: SemanticGrader | null,
  utterance: string,
  signal?: AbortSignal
): Promise<HybridResult | null> {
  const memories = teacher.recallMemories(utterance, 5);
  // EPISODIC CONTEXT: the facts the observer remembers about the human,
  // tagged as remembered — the LLM drafts conditioned on the observer's
  // long-term memory, not just its phrase memory. The grader arbitrates
  // what the observer actually stores.
  const remembered = teacher.episodicRecall(utterance, 3);
  const draft = await chaperone.generateHybridAnswer(
    utterance,
    memories.map((m) => m.content),
    {
      signal,
      ...(remembered.length > 0 ? { rememberedFacts: remembered.map((r) => r.fact.content) } : {})
    }
  );
  if (draft === null) return null;

  let score: number | null = null;
  let feedback: string | null = null;
  if (grader !== null) {
    const outcome = await grader.grade(utterance, draft, { signal });
    score = outcome?.score ?? null;
    feedback = outcome?.feedback ?? null;
  }

  // The observer is the arbiter: strong drafts become its own memories,
  // weak ones become learning material, middling or ungraded ones are shown
  // and dropped (memory only accepts graded content).
  let stored = false;
  if (score !== null && score >= CREATIVE_REINFORCE_SCORE) {
    stored = teacher.creativeGradeFeedback(
      { traceIds: memories.map((m) => m.id), edges: [] },
      score,
      utterance,
      draft
    );
  } else if (score !== null && score <= CREATIVE_WEAKEN_SCORE) {
    teacher.recordGap(utterance);
  }

  return {
    answer: draft,
    score,
    feedback,
    stored,
    memories: memories.map((m) => m.content)
  };
}